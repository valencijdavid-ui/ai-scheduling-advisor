// PILOT-P0-3C-i — il fence dello scrittore, su PostgreSQL vero.
//
// Non e' una caratterizzazione: e' il guardiano del comportamento nuovo.
//
// La proprieta' in discussione e' di LOCK, e un lock non si dimostra leggendo
// SQL. Servono due transazioni vive che si contendano la stessa riga di
// `tenants`, e serve provare ENTRAMBE le serializzazioni — perche' il difetto
// che questa fase chiude non e' "l'ordine sbagliato", e' "nessun ordine
// garantito".
//
//   CASO A  lo scrittore vince il fence
//           -> la cancellazione ASPETTA
//           -> dopo il commit dello scrittore, la discovery POST-lock della
//              cancellazione vede l'appuntamento appena nato e lo cancella,
//              catturandone il debito remoto
//
//   CASO B  la cancellazione vince il fence
//           -> l'epoca diventa E+1
//           -> lo scrittore in attesa riparte, legge E+1, non combacia con la
//              E catturata, e viene RIFIUTATO: nessun appuntamento, nessun
//              intento, nessuna chiamata a Google
//
// L'attesa non e' una sleep. Si osserva `pg_stat_activity` finche' il backend
// non dichiara di essere in attesa di un lock: il test puo' fallire per
// timeout, mai per essere arrivato troppo presto.

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  openSession,
  postgresAvailable,
  waitUntilBlockedOnLock,
  type PgSession,
  type TestDatabase,
} from '../../helpers/postgres';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

const PHONE = '393331112233';
const CALENDAR_ID = 'studio@example.com';

describePg('PILOT-P0-3C-i — fence di proiezione dello scrittore', () => {
  let db: TestDatabase;
  const openSessions: PgSession[] = [];

  beforeAll(() => {
    db = createTestDatabase();
  }, 120_000);

  afterEach(async () => {
    while (openSessions.length > 0) {
      await openSessions.pop()?.close();
    }
  });

  afterAll(() => {
    db?.drop();
  });

  const session = async (): Promise<PgSession> => {
    const created = await openSession(db);
    openSessions.push(created);
    return created;
  };

  // -------------------------------------------------------------------------
  // CASO A — lo scrittore vince, la cancellazione aspetta e poi lo raccoglie
  // -------------------------------------------------------------------------

  it('makes the erasure wait for an in-flight writer, then erases what it created', async () => {
    const seed = seedTenant(db);
    const appointmentId = randomUUID();
    const eventId = `apt${appointmentId.replace(/-/g, '')}`;

    const writer = await session();
    const eraser = await session();

    // 1. Lo scrittore apre la transazione e prende il fence inserendo
    //    appuntamento + intento. Da qui tiene FOR SHARE sulla riga del tenant.
    await writer.run('begin;');
    const created = parseJson(
      await writer.run(
        createAppointmentSql({ tenantId: seed.tenantId, appointmentId, eventId, expectedEpoch: 0 }),
      ),
    );
    expect(created.outcome).toBe('created');
    expect(created.desiredVersion).toBe(1);
    expect(created.writeGeneration).toBe(1);

    // 2. La cancellazione parte e si blocca: il suo primo statement
    //    sostanziale e' l'UPDATE dell'epoca, che confligge con FOR SHARE.
    await eraser.run('begin;');
    const erasing = eraser.send(eraseSql(seed.tenantId));

    await waitUntilBlockedOnLock(db, eraser.backendPid);
    expect(erasing.isSettled()).toBe(false);

    // 3. Lo scrittore committa. Solo adesso la cancellazione puo' procedere.
    await writer.run('commit;');

    const erased = parseJson(await erasing.done);
    await eraser.run('commit;');

    // La discovery POST-lock ha visto l'appuntamento nato un istante prima.
    expect((erased.deleted as { appointments: number }).appointments).toBe(1);
    expect(erased.pendingObligations).toBe(1);

    expect(db.query(`select id from public.appointments where id = '${appointmentId}'`)).toEqual(
      [],
    );

    // Il debito remoto normale di P0-3A e' stato catturato: la cattura non e'
    // stata scavalcata dalla corsa.
    const obligations = db.query<{ status: string; external_event_id: string }>(
      `select status, external_event_id from public.erasure_obligations
        where tenant_ref = '${seed.tenantId}'`,
    );
    expect(obligations).toEqual([{ status: 'pending', external_event_id: eventId }]);

    // L'intento dello scrittore e' sopravvissuto all'appuntamento cancellato.
    const intents = db.query<{ state: string; external_event_id: string }>(
      `select state, external_event_id from public.calendar_write_intents
        where tenant_ref = '${seed.tenantId}'`,
    );
    expect(intents).toEqual([{ state: 'in_flight', external_event_id: eventId }]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // CASO B — la cancellazione vince, lo scrittore stantio viene rifiutato
  // -------------------------------------------------------------------------

  it('rejects a stale writer that captured the epoch before the erasure committed', async () => {
    const seed = seedTenant(db);
    const appointmentId = randomUUID();
    const eventId = `apt${appointmentId.replace(/-/g, '')}`;

    // Lo scrittore ha catturato l'epoca all'inizio del turno: 0.
    const capturedEpoch = Number(
      db.scalar(`select public.read_tenant_projection_epoch('${seed.tenantId}')`),
    );
    expect(capturedEpoch).toBe(0);

    const eraser = await session();
    const writer = await session();

    // 1. La cancellazione avanza l'epoca e resta aperta.
    await eraser.run('begin;');
    const erased = parseJson(await eraser.run(eraseSql(seed.tenantId)));
    expect(erased.projectionEpoch).toBe(1);

    // 2. Lo scrittore prova a creare con l'epoca VECCHIA e si blocca sul
    //    FOR SHARE che la UPDATE non committata tiene occupato.
    await writer.run('begin;');
    const creating = writer.send(
      createAppointmentSql({
        tenantId: seed.tenantId,
        appointmentId,
        eventId,
        expectedEpoch: capturedEpoch,
      }),
    );

    await waitUntilBlockedOnLock(db, writer.backendPid);
    expect(creating.isSettled()).toBe(false);

    // 3. La cancellazione committa. Lo scrittore riparte e rilegge l'epoca
    //    dall'ULTIMA versione committata: E+1.
    await eraser.run('commit;');

    const outcome = parseJson(await creating.done);
    await writer.run('commit;');

    expect(outcome.outcome).toBe('stale_projection_epoch');
    expect(outcome.expected).toBe(0);
    expect(outcome.observed).toBe(1);

    // Niente e' stato scritto: nessuna riga rimaterializzata...
    expect(
      db.query(`select id from public.appointments where tenant_id = '${seed.tenantId}'`),
    ).toEqual([]);
    // ...e nessun intento, quindi nessuna autorizzazione a toccare Google.
    expect(
      db.query(
        `select id from public.calendar_write_intents where tenant_ref = '${seed.tenantId}'`,
      ),
    ).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // RC-2 — il modo del lock e' FOR SHARE, e non puo' scivolare a FOR KEY SHARE
  // -------------------------------------------------------------------------

  it('locks the tenant row with FOR SHARE, never FOR KEY SHARE', () => {
    const definition = db.scalar(
      `select pg_get_functiondef('public.lock_tenant_projection_fence(uuid)'::regprocedure)`,
    );

    expect(definition).toContain('for share');
    // FOR KEY SHARE non confligge con la UPDATE dell'epoca, che e' una
    // scrittura su colonna non-chiave: le due transazioni scorrerebbero
    // l'una accanto all'altra senza vedersi, e i due casi sopra
    // diventerebbero entrambi impossibili da garantire.
    expect(definition?.toLowerCase()).not.toContain('for key share');
    expect(definition?.toLowerCase()).not.toContain('for no key update');
  });

  it('proves FOR KEY SHARE would not have blocked, and FOR SHARE does', async () => {
    // Il contrasto e' la dimostrazione operativa: lo stesso identico
    // conflitto, letto con i due modi di lock, produce due esiti diversi.
    const seed = seedTenant(db);
    const holder = await session();
    const keyShareReader = await session();
    const shareReader = await session();

    await holder.run('begin;');
    await holder.run(
      `update public.tenants set projection_epoch = projection_epoch + 1 where id = '${seed.tenantId}';`,
    );

    await keyShareReader.run('begin;');
    const keyShare = keyShareReader.send(
      `select projection_epoch from public.tenants where id = '${seed.tenantId}' for key share;`,
    );

    // FOR KEY SHARE passa liberamente: nessun conflitto con FOR NO KEY UPDATE.
    await keyShare.done;
    expect(keyShare.isSettled()).toBe(true);
    await keyShareReader.run('rollback;');

    await shareReader.run('begin;');
    const share = shareReader.send(
      `select projection_epoch from public.tenants where id = '${seed.tenantId}' for share;`,
    );

    await waitUntilBlockedOnLock(db, shareReader.backendPid);
    expect(share.isSettled()).toBe(false);

    await holder.run('commit;');
    expect(await share.done).toContain('1');
    await shareReader.run('rollback;');
  }, 60_000);

  // -------------------------------------------------------------------------
  // RC-1 — l'epoca avanza PRIMA della discovery del soggetto
  // -------------------------------------------------------------------------

  it('advances the projection epoch before discovering any subject row', async () => {
    // Prova di COMPORTAMENTO, non di lettura del sorgente: si tiene bloccata
    // la cancellazione sul suo primo statement sostanziale e si osserva che
    // il lock che ha gia' chiesto e' quello sul TENANT.
    const seed = seedTenant(db);
    const holder = await session();
    const eraser = await session();

    // Un altro scrittore tiene il fence: la cancellazione non potra' andare
    // oltre il proprio primo statement.
    await holder.run('begin;');
    await holder.run(`select public.lock_tenant_projection_fence('${seed.tenantId}');`);

    await eraser.run('begin;');
    const erasing = eraser.send(eraseSql(seed.tenantId));
    await waitUntilBlockedOnLock(db, eraser.backendPid);

    // Un'attesa su riga si manifesta come lock su `transactionid`, non su una
    // relazione: la prova sta in cio' che la transazione ha GIA' preso.
    const held = db
      .query<{ relation: string }>(
        `select c.relname as relation
           from pg_locks l join pg_class c on c.oid = l.relation
          where l.pid = ${eraser.backendPid} and l.granted and c.relnamespace = 'public'::regnamespace`,
      )
      .map((row) => row.relation);

    // Ha gia' scritto il tenant...
    expect(held).toContain('tenants');
    // ...e NON ha ancora guardato niente del soggetto. Se la discovery girasse
    // per prima, questi lock ci sarebbero gia'.
    expect(held).not.toContain('conversations');
    expect(held).not.toContain('appointments');
    expect(held).not.toContain('erasure_obligations');

    await holder.run('rollback;');
    await erasing.done;
    await eraser.run('rollback;');
  }, 60_000);

  it('guards the erasure source order so the epoch update cannot drift below discovery', () => {
    const definition =
      db.scalar(
        `select pg_get_functiondef('public.erase_customer_data(uuid, text, uuid, uuid, text, text)'::regprocedure)`,
      ) ?? '';

    const epochUpdate = definition.indexOf('set projection_epoch = t.projection_epoch + 1');
    const conversationDiscovery = definition.indexOf('into v_conversation_ids');
    const appointmentDiscovery = definition.indexOf('into v_appointment_ids');
    const obligationCapture = definition.indexOf('insert into public.erasure_obligations');

    expect(epochUpdate).toBeGreaterThan(-1);
    expect(epochUpdate).toBeLessThan(conversationDiscovery);
    expect(epochUpdate).toBeLessThan(appointmentDiscovery);
    expect(epochUpdate).toBeLessThan(obligationCapture);
  });

  it('fails closed when the tenant no longer exists', async () => {
    // Nessuna invenzione di stato di grace: in C-i un tenant assente non e'
    // proiettabile, punto.
    const missing = randomUUID();

    expect(db.scalar(`select public.read_tenant_projection_epoch('${missing}')`)).toBeNull();

    const writer = await session();
    const outcome = parseJson(
      await writer.run(
        createAppointmentSql({
          tenantId: missing,
          appointmentId: randomUUID(),
          eventId: 'apt_missing',
          expectedEpoch: 0,
        }),
      ),
    );

    expect(outcome.outcome).toBe('tenant_gone');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson(raw: string): Record<string, unknown> {
  const line = raw.trim().split('\n').at(-1) ?? '';

  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`psql did not return JSON: ${raw}`, { cause: error });
  }
}

function seedTenant(db: TestDatabase): { tenantId: string } {
  const tenantId = randomUUID();
  const conversationId = randomUUID();

  db.exec(`
    insert into public.tenants (id, name, slug, billing_email)
    values ('${tenantId}', 'Studio Test', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', 'active', '{"calendar_id":"${CALENDAR_ID}"}'::jsonb);

    insert into public.conversations (id, tenant_id, channel, customer_identifier)
    values ('${conversationId}', '${tenantId}', 'whatsapp', '${PHONE}');
  `);

  return { tenantId };
}

function createAppointmentSql(input: {
  tenantId: string;
  appointmentId: string;
  eventId: string;
  expectedEpoch: number;
}): string {
  return `select public.create_appointment_with_calendar_intent(
    p_id := '${input.appointmentId}'::uuid,
    p_tenant_id := '${input.tenantId}'::uuid,
    p_expected_projection_epoch := ${input.expectedEpoch},
    p_conversation_id := null,
    p_service_id := null,
    p_service_name := 'Prima visita',
    p_customer_identifier := '${PHONE}',
    p_customer_name := 'Mario Rossi',
    p_customer_phone := '${PHONE}',
    p_scheduled_at := now() + interval '2 days',
    p_duration_minutes := 30,
    p_notes := null,
    p_booking_source := 'whatsapp_ai',
    p_calendar_provider := 'google_calendar',
    p_calendar_sync_status := 'pending',
    p_calendar_event_id := '${input.eventId}',
    p_calendar_sync_next_attempt_at := now(),
    p_calendar_target := '${CALENDAR_ID}',
    p_calendar_identity_source := 'current_config'
  );`;
}

function eraseSql(tenantId: string): string {
  return `select public.erase_customer_data('${tenantId}'::uuid, '${PHONE}',
    gen_random_uuid(), null, null, 'Vitest');`;
}
