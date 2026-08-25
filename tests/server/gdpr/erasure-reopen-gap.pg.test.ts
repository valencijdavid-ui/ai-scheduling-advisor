// PILOT-P0-3C — CARATTERIZZAZIONE. Il buco di RIAPERTURA del debito remoto.
//
// Questo file non descrive un comportamento desiderato. Descrive il difetto
// piu' importante trovato dall'indagine P0-3C, e resta verde affermandolo.
//
// IL PUNTO
//
// `erasure_obligations` e' progettata per poter RIAPRIRE un debito gia'
// convergente: l'indice unico copre tutti gli stati proprio per questo, e il
// commento della migration lo dice esplicitamente —
//
//   "se uno scrittore P0-1 in volo ricrea l'evento dopo la cancellazione, il
//    debito deve poter tornare aperto invece di duplicarsi"
//
// Lo SCHEMA sa farlo. L'unico codice che invoca quell'UPSERT vive dentro
// `erase_customer_data`, e la sua sorgente di candidati e':
//
//   from public.appointments where a.id = any(v_appointment_ids)
//
// Dopo la cancellazione quelle righe non esistono piu'. Non esiste nessun
// altro percorso applicativo capace di scoprire l'identita' remota, quindi la
// riapertura e' irraggiungibile ESATTAMENTE nello scenario per cui e' stata
// costruita.
//
// La conseguenza e' che oggi la riapertura non serve a niente, e domani —
// quando P0-3C avra' un worker che scrive `converged` — diventera' il modo in
// cui il sistema dichiara chiuso un debito il cui evento remoto e' vivo.
//
// Lo stato remoto e' modellato in memoria e non nel database DI PROPOSITO:
// nel repository non esiste nessuna rappresentazione persistente di cosa viva
// su Google, ed e' precisamente questa assenza che rende il difetto invisibile.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, postgresAvailable, type TestDatabase } from '../../helpers/postgres';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

const CALENDAR_ID = 'studio@example.com';
const PHONE = '393331112233';

type ErasureResult = {
  localDeletion: 'complete' | 'manual_review_required';
  deleted: { appointments: number; conversations: number; messages: number };
  pendingObligations: number;
  manualRequired: number;
};

type ObligationRow = {
  status: string;
  external_event_id: string | null;
  calendar_id: string | null;
  resolved_at: string | null;
  attempts: number;
};

describePg('PILOT-P0-3C — caratterizzazione del buco di riapertura post-erasure', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  }, 120_000);

  afterAll(() => {
    db?.drop();
  });

  it('characterizes the post-erasure obligation reopen gap', () => {
    const seed = seedCustomerWithGoogleEvent(db);

    // -- Passo 1: cancellazione reale ------------------------------------
    const first = erase(db, seed);

    expect(first.deleted.appointments).toBe(1);
    expect(first.pendingObligations).toBe(1);
    expect(first.manualRequired).toBe(0);

    // La riga locale e' sparita: con lei l'unico puntatore all'evento remoto.
    expect(
      db.query(`select id from public.appointments where tenant_id = '${seed.tenantId}'`),
    ).toEqual([]);

    const captured = obligations(db, seed.tenantId);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      status: 'pending',
      external_event_id: seed.eventId,
      calendar_id: CALENDAR_ID,
    });

    // -- Passo 2: P0-3C converge il debito (setup, nessun worker reale) ---
    db.exec(`
      update public.erasure_obligations
         set status = 'converged', resolved_at = now()
       where tenant_ref = '${seed.tenantId}';
    `);

    // -- Passo 3: uno scrittore in volo ricrea lo stesso evento -----------
    //
    // Stato remoto SOLO in memoria: il repository non ha nessun posto dove
    // scriverlo, e questa assenza e' parte del difetto.
    const remoteCalendar = new Set<string>();
    remoteCalendar.add(seed.eventId);
    expect(remoteCalendar.has(seed.eventId)).toBe(true);

    // -- Passo 4: si ripete la cancellazione per lo stesso numero ---------
    const second = erase(db, seed);

    // Nessuna riga locale da cui partire, quindi nessuna identita' remota da
    // riscoprire: la cancellazione non ha NIENTE da catturare.
    expect(second.deleted.appointments).toBe(0);
    expect(second.pendingObligations).toBe(0);
    expect(second.manualRequired).toBe(0);

    // L'obbligazione resta chiusa mentre l'evento remoto e' vivo.
    const afterSecond = obligations(db, seed.tenantId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.status).toBe('converged');
    expect(afterSecond[0]?.resolved_at).not.toBeNull();

    // Il sistema crede che il debito sia chiuso...
    const openDebt = afterSecond.filter((row) => row.status === 'pending').length;
    expect(openDebt).toBe(0);
    // ...e l'evento con dentro il telefono del cliente e' ancora la'.
    expect(remoteCalendar.has(seed.eventId)).toBe(true);

    // POST_ERASURE_REOPEN_UNREACHABLE = TRUE
  });

  it('characterizes the reopen path working whenever the local row is still discoverable', () => {
    // Il complemento indispensabile del test precedente: dimostra che la
    // RIAPERTURA NON E' ROTTA. Lo schema e l'UPSERT funzionano — quello che
    // manca e' un percorso applicativo capace di scoprire l'identita' remota
    // quando l'appuntamento non c'e' piu'.
    //
    // Si usa la funzione VERA, non una copia dell'UPSERT riscritta nel test.
    const seed = seedCustomerWithGoogleEvent(db);

    erase(db, seed);
    db.exec(`
      update public.erasure_obligations
         set status = 'converged', resolved_at = now()
       where tenant_ref = '${seed.tenantId}';
    `);

    // Si restituisce al database cio' che la seconda cancellazione non aveva:
    // una riga locale che punta alla stessa identita' remota.
    db.exec(`
      insert into public.appointments
        (id, tenant_id, customer_identifier, customer_name, customer_phone,
         scheduled_at, calendar_provider, calendar_event_id)
      values ('${randomUUID()}', '${seed.tenantId}', '${PHONE}', 'Mario Rossi', '${PHONE}',
              now() + interval '2 days', 'google_calendar', '${seed.eventId}');
    `);

    const reopened = erase(db, seed);

    expect(reopened.deleted.appointments).toBe(1);
    expect(reopened.pendingObligations).toBe(1);

    const rows = obligations(db, seed.tenantId);
    // Una riga sola: riaperta, non duplicata. E' l'indice unico che lo
    // garantisce, ed e' il comportamento che P0-3C dovra' poter innescare
    // SENZA dipendere dall'esistenza dell'appuntamento.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      external_event_id: seed.eventId,
      resolved_at: null,
      attempts: 0,
    });
  });

  it('characterizes the absence of any non-appointment path to the remote identity', () => {
    // Perche' la riapertura sia raggiungibile serve una sorgente dell'identita'
    // remota che sopravviva alla riga cancellata. Oggi l'unico posto dove quel
    // dato esiste ancora e' l'obbligazione stessa — che pero' nessun codice
    // applicativo legge, se non i due conteggi del watchdog.
    const seed = seedCustomerWithGoogleEvent(db);
    erase(db, seed);

    db.exec(`delete from public.erasure_obligations where tenant_ref = '${seed.tenantId}';`);

    // Cancellata l'obbligazione, l'identita' dell'evento non e' piu'
    // ricostruibile da NESSUNA tabella: non e' un problema di query, e'
    // un'assenza di dato.
    const survivors = db.query<{ table_name: string }>(`
      select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'calendar_event_id'
    `);

    expect(survivors.map((row) => row.table_name).sort()).toEqual(['appointments']);
    expect(
      db.query(`select id from public.appointments where tenant_id = '${seed.tenantId}'`),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Seed = { tenantId: string; userId: string; eventId: string };

function seedCustomerWithGoogleEvent(db: TestDatabase): Seed {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const appointmentId = randomUUID();
  const eventId = `apt${appointmentId.replace(/-/g, '')}`;

  db.exec(`
    insert into public.tenants (id, name, slug, billing_email)
    values ('${tenantId}', 'Studio Test', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');

    insert into auth.users (id) values ('${userId}');
    insert into public.users (id, tenant_id, role) values ('${userId}', '${tenantId}', 'owner');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', 'active', '{"calendar_id":"${CALENDAR_ID}"}'::jsonb);

    insert into public.conversations (id, tenant_id, channel, customer_identifier)
    values ('${conversationId}', '${tenantId}', 'whatsapp', '${PHONE}');

    insert into public.appointments
      (id, tenant_id, conversation_id, customer_identifier, customer_name, customer_phone,
       scheduled_at, calendar_provider, calendar_event_id)
    values ('${appointmentId}', '${tenantId}', '${conversationId}', '${PHONE}', 'Mario Rossi',
            '${PHONE}', now() + interval '2 days', 'google_calendar', '${eventId}');
  `);

  return { tenantId, userId, eventId };
}

function erase(db: TestDatabase, seed: Seed): ErasureResult {
  const rows = db.query<{ result: ErasureResult }>(
    `select public.erase_customer_data(
       '${seed.tenantId}'::uuid, '${PHONE}', '${randomUUID()}'::uuid,
       '${seed.userId}'::uuid, null, 'Vitest') as result`,
  );

  const result = rows[0]?.result;

  if (!result) {
    throw new Error('erase_customer_data returned no result');
  }

  return result;
}

function obligations(db: TestDatabase, tenantId: string): ObligationRow[] {
  return db.query<ObligationRow>(
    `select status, external_event_id, calendar_id, resolved_at, attempts
       from public.erasure_obligations where tenant_ref = '${tenantId}'`,
  );
}
