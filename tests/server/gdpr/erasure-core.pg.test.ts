// PILOT-P0-3A — cancellazione customer su PostgreSQL reale.
//
// Questi test girano contro le migration vere applicate a un database
// usa-e-getta. Sono l'unico posto in cui i difetti che P0-3A chiude possono
// essere visti: F3 e' un fallimento di FOREIGN KEY dentro una sequenza non
// transazionale, e un repository finto in memoria non ha ne' FK ne'
// transazioni.
//
// Se non c'e' un PostgreSQL locale la suite si salta invece di fallire: non
// deve rompere `npm run verify` su una macchina senza database.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, postgresAvailable, type TestDatabase } from '../../helpers/postgres';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

type Seed = {
  tenantId: string;
  userId: string;
  conversationId: string;
  appointmentId: string;
  messageIds: string[];
};

type ErasureResult = {
  requestId: string;
  localDeletion: 'complete' | 'manual_review_required';
  deleted: {
    conversations: number;
    messages: number;
    appointments: number;
    optOuts: number;
    voiceEvents: number;
    schedulingDecisions: number;
  };
  dissociatedAppointments: number;
  pendingObligations: number;
  manualRequired: number;
  residualSuspected: number;
};

const CALENDAR_ID = 'studio@example.com';

describePg('PILOT-P0-3A — erase_customer_data su Postgres reale', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  }, 120_000);

  afterAll(() => {
    db?.drop();
  });

  // -------------------------------------------------------------------------
  // Caratterizzazione del difetto che questa fase chiude
  // -------------------------------------------------------------------------

  it('F3: la vecchia sequenza distrugge i messaggi e poi fallisce con 23503', () => {
    const seed = seedCustomer(db, { phone: '393331112233' });

    // Ordine originale: prima i messaggi, poi la conversazione. Ogni statement
    // e' una transazione a se', esattamente come cinque chiamate PostgREST.
    db.exec(
      `delete from public.messages where tenant_id = '${seed.tenantId}' and conversation_id = '${seed.conversationId}';`,
    );

    const sqlstate = db.trySql(
      `delete from public.conversations where tenant_id = '${seed.tenantId}' and id = '${seed.conversationId}'`,
    );

    // foreign_key_violation su appointments_conversation_id_fkey.
    expect(sqlstate).toBe('23503');

    // Lo stato risultante e' il danno: i messaggi non tornano indietro.
    expect(count(db, 'messages', seed.tenantId)).toBe(0);
    expect(count(db, 'conversations', seed.tenantId)).toBe(1);
    expect(count(db, 'appointments', seed.tenantId)).toBe(1);
    expect(count(db, 'opt_outs', seed.tenantId)).toBe(1);
  });

  it("il vincolo che causava F3 e' ancora NO ACTION: il fix non lo aggira cambiando lo schema", () => {
    const rows = db.query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint where conname = 'appointments_conversation_id_fkey'`,
    );

    // 'a' = NO ACTION. La correzione sta nell'ORDINE della transazione, non in
    // una modifica di una migration gia' applicata in produzione.
    expect(rows[0]?.confdeltype).toBe('a');
  });

  // -------------------------------------------------------------------------
  // Cancellazione atomica
  // -------------------------------------------------------------------------

  it('cancella tutto in una transazione e cattura il debito remoto', () => {
    const seed = seedCustomer(db, { phone: '393331112233', withGoogleEvent: true });
    const result = erase(db, seed, '393331112233');

    expect(result.deleted).toEqual({
      conversations: 1,
      messages: 2,
      appointments: 1,
      optOuts: 1,
      voiceEvents: 1,
      schedulingDecisions: 1,
    });

    expect(count(db, 'conversations', seed.tenantId)).toBe(0);
    expect(count(db, 'messages', seed.tenantId)).toBe(0);
    expect(count(db, 'appointments', seed.tenantId)).toBe(0);
    expect(count(db, 'opt_outs', seed.tenantId)).toBe(0);
    expect(count(db, 'voice_events', seed.tenantId)).toBe(0);
    expect(count(db, 'scheduling_decisions', seed.tenantId)).toBe(0);
  });

  it("appuntamento prima della conversazione: la FK non puo' piu' bloccare la cancellazione", () => {
    const seed = seedCustomer(db, { phone: '393331112299' });

    // Nessuna eccezione: e' la prova diretta che F3 non e' piu' possibile.
    const result = erase(db, seed, '393331112299');

    expect(result.deleted.appointments).toBe(1);
    expect(result.deleted.conversations).toBe(1);
  });

  it("un fallimento a meta' transazione annulla anche i messaggi", () => {
    const seed = seedCustomer(db, { phone: '393331112244' });

    // L'errore viene fatto scattare sull'ULTIMA cancellazione, quando
    // messaggi, appuntamenti e conversazioni sono gia' stati cancellati
    // dentro la transazione.
    db.exec(`
      create or replace function public.harness_block_opt_outs() returns trigger
      language plpgsql as $$ begin raise exception 'harness: opt_out delete blocked'; end $$;
      create trigger harness_block_opt_outs before delete on public.opt_outs
        for each row execute function public.harness_block_opt_outs();
    `);

    const sqlstate = db.trySql(eraseSql(seed, '393331112244'));

    db.exec('drop trigger harness_block_opt_outs on public.opt_outs;');

    expect(sqlstate).not.toBe('OK');

    // Tutto torna al suo posto: nessuna distruzione parziale.
    expect(count(db, 'messages', seed.tenantId)).toBe(2);
    expect(count(db, 'conversations', seed.tenantId)).toBe(1);
    expect(count(db, 'appointments', seed.tenantId)).toBe(1);
    expect(count(db, 'opt_outs', seed.tenantId)).toBe(1);
    expect(auditRows(db, seed.tenantId)).toHaveLength(0);
  });

  it('se la cattura del debito remoto fallisce, i dati del cliente restano', () => {
    const seed = seedCustomer(db, { phone: '393331112255', withGoogleEvent: true });

    db.exec(`
      create or replace function public.harness_block_obligations() returns trigger
      language plpgsql as $$ begin raise exception 'harness: obligation insert blocked'; end $$;
      create trigger harness_block_obligations before insert on public.erasure_obligations
        for each row execute function public.harness_block_obligations();
    `);

    const sqlstate = db.trySql(eraseSql(seed, '393331112255'));

    db.exec('drop trigger harness_block_obligations on public.erasure_obligations;');

    expect(sqlstate).not.toBe('OK');

    // Cancellare in locale senza poter registrare il debito remoto
    // significherebbe perdere per sempre l'identita' dell'evento Google.
    expect(count(db, 'conversations', seed.tenantId)).toBe(1);
    expect(count(db, 'appointments', seed.tenantId)).toBe(1);
    expect(count(db, 'messages', seed.tenantId)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Appuntamento agganciato di un altro cliente (RC-2)
  // -------------------------------------------------------------------------

  it("sgancia l'appuntamento di un ALTRO cliente invece di cancellarlo o fallire", () => {
    const seed = seedCustomer(db, { phone: '393331113000' });

    // Stessa conversazione, identita' diversa: capita quando piu' persone
    // scrivono dallo stesso numero di famiglia o studio.
    const otherId = randomUUID();
    db.exec(`
      insert into public.appointments
        (id, tenant_id, conversation_id, customer_identifier, customer_name, customer_phone,
         scheduled_at, calendar_provider, calendar_event_id)
      values ('${otherId}', '${seed.tenantId}', '${seed.conversationId}', '399999999999',
              'Altro Cliente', '399999999999', now() + interval '3 days',
              'google_calendar', 'aptother0001');
    `);

    const result = erase(db, seed, '393331113000');

    expect(result.dissociatedAppointments).toBe(1);

    const survivor = db.query<{ conversation_id: string | null }>(
      `select conversation_id from public.appointments where id = '${otherId}'`,
    );
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.conversation_id).toBeNull();

    // E soprattutto: nessun debito di cancellazione per un evento che non e'
    // del soggetto della richiesta.
    const obligations = db.query<{ external_event_id: string }>(
      `select external_event_id from public.erasure_obligations where tenant_ref = '${seed.tenantId}'`,
    );
    expect(obligations.map((row) => row.external_event_id)).not.toContain('aptother0001');
  });

  // -------------------------------------------------------------------------
  // Righe che perderebbero l'aggancio (RC-3)
  // -------------------------------------------------------------------------

  it('cancella voice_events e scheduling_decisions prima che il loro aggancio venga azzerato', () => {
    const seed = seedCustomer(db, { phone: '393331114000' });

    // Entrambe le FK sono ON DELETE SET NULL: cancellando prima i genitori
    // queste righe resterebbero orfane, con dentro contenuto del cliente e
    // nessun modo di ricondurle a lui.
    const result = erase(db, seed, '393331114000');

    expect(result.deleted.voiceEvents).toBe(1);
    expect(result.deleted.schedulingDecisions).toBe(1);
    expect(count(db, 'voice_events', seed.tenantId)).toBe(0);
    expect(count(db, 'scheduling_decisions', seed.tenantId)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Normalizzazione e rilevazione residua
  // -------------------------------------------------------------------------

  it('riconosce lo stesso numero scritto in formati diversi', () => {
    const seed = seedCustomer(db, { phone: '+39 333 111-2277' });

    // La richiesta arriva in cifre pure; il database ha la formattazione
    // originale perche' i percorsi di scrittura fanno solo trim.
    const result = erase(db, seed, '393331112277');

    expect(result.deleted.conversations).toBe(1);
    expect(result.deleted.appointments).toBe(1);
    expect(result.deleted.optOuts).toBe(1);
  });

  it('NON cancella un possibile alias con prefisso diverso, ma lo segnala', () => {
    const seed = seedCustomer(db, { phone: '3336667788' });

    // Nazionale vs internazionale: potrebbero essere la stessa persona, ma
    // potrebbero anche non esserlo. Cancellare qui vorrebbe dire distruggere i
    // dati di un altro cliente.
    const result = erase(db, seed, '393336667788');

    expect(result.deleted.conversations).toBe(0);
    expect(result.deleted.appointments).toBe(0);
    expect(result.residualSuspected).toBeGreaterThan(0);
    expect(count(db, 'conversations', seed.tenantId)).toBe(1);
  });

  it('rifiuta un numero non normalizzabile', () => {
    const seed = seedCustomer(db, { phone: '393331115000' });
    expect(db.trySql(eraseSql(seed, '12'))).toBe('22023');
  });

  it("zero righe non e' un errore: la richiesta e' ripetibile", () => {
    const seed = seedCustomer(db, { phone: '393331116000' });

    erase(db, seed, '393331116000');
    const second = erase(db, seed, '393331116000');

    expect(second.deleted.conversations).toBe(0);
    expect(second.pendingObligations).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Obbligazioni: stato, dedup, riapertura
  // -------------------------------------------------------------------------

  it('un evento Google noto diventa debito pending NON eseguibile', () => {
    const seed = seedCustomer(db, { phone: '393331117000', withGoogleEvent: true });
    const result = erase(db, seed, '393331117000');

    expect(result.pendingObligations).toBe(1);

    const rows = db.query<{
      status: string;
      next_attempt_at: string | null;
      calendar_id: string;
      external_event_id: string;
      resolved_at: string | null;
      attempts: number;
    }>(
      `select status, next_attempt_at, calendar_id, external_event_id, resolved_at, attempts
         from public.erasure_obligations where tenant_ref = '${seed.tenantId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    // In P0-3A il worker remoto non esiste: l'obbligazione e' durevole ma
    // deliberatamente non ancora eseguibile.
    expect(rows[0]?.next_attempt_at).toBeNull();
    // NULL non significa ne' convergente ne' terminale.
    expect(rows[0]?.status).not.toBe('converged');
    expect(rows[0]?.resolved_at).toBeNull();
    expect(rows[0]?.attempts).toBe(0);
    // L'identita' remota e' catturata prima che la riga locale sparisca.
    expect(rows[0]?.calendar_id).toBe(CALENDAR_ID);
    expect(rows[0]?.external_event_id).toBe('apt00000000001');
  });

  it("un evento senza id e' IGNOTO, non pulito: diventa manual_required", () => {
    const seed = seedCustomer(db, { phone: '393331118000', withGoogleEvent: 'missing-id' });
    const result = erase(db, seed, '393331118000');

    expect(result.manualRequired).toBe(1);
    expect(result.pendingObligations).toBe(0);

    const rows = db.query<{ status: string; external_event_id: string | null }>(
      `select status, external_event_id from public.erasure_obligations where tenant_ref = '${seed.tenantId}'`,
    );
    expect(rows[0]?.status).toBe('manual_required');
    expect(rows[0]?.external_event_id).toBeNull();
  });

  it("lo stesso evento non puo' generare due debiti attivi", () => {
    const tenantId = seedTenantOnly(db);
    const insert = `
      insert into public.erasure_obligations
        (request_id, tenant_ref, obligation_type, status, calendar_id, external_event_id)
      values ('${randomUUID()}', '${tenantId}', 'google_event_delete', 'pending', '${CALENDAR_ID}', 'aptdup0001')
    `;

    db.exec(`${insert};`);
    expect(db.trySql(insert)).toBe('23505');
  });

  it("un debito gia' convergente puo' essere riaperto dalla stessa identita'", () => {
    const seed = seedCustomer(db, { phone: '393331119000', withGoogleEvent: true });

    // Stato di partenza: P0-3C ha gia' cancellato l'evento e chiuso il debito.
    db.exec(`
      insert into public.erasure_obligations
        (request_id, tenant_ref, obligation_type, status, calendar_id, external_event_id, resolved_at, attempts)
      values ('${randomUUID()}', '${seed.tenantId}', 'google_event_delete', 'converged',
              '${CALENDAR_ID}', 'apt00000000001', now(), 3);
    `);

    erase(db, seed, '393331119000');

    const rows = db.query<{ status: string; resolved_at: string | null; attempts: number }>(
      `select status, resolved_at, attempts from public.erasure_obligations
        where tenant_ref = '${seed.tenantId}' and external_event_id = 'apt00000000001'`,
    );

    // Una sola riga (dedup stabile), tornata aperta.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.resolved_at).toBeNull();
    expect(rows[0]?.attempts).toBe(0);
  });

  it('due appuntamenti sullo stesso evento remoto sono UN debito, non un errore', () => {
    // Niente vieta a due righe di `appointments` di puntare allo stesso
    // evento Google: nessun vincolo unico su calendar_event_id, e i dati
    // legacy/importati non rispettano le assunzioni dei percorsi di scrittura
    // attuali. Senza dedup l'UPSERT multi-riga tocca due volte la stessa
    // obbligazione e Postgres solleva 21000: la transazione rollbacca pulita,
    // ma ogni ritentativo fallisce identico e quel cliente non e' piu'
    // cancellabile. Mai.
    const seed = seedCustomer(db, { phone: '393331125000', withGoogleEvent: true });

    db.exec(`
      insert into public.appointments
        (tenant_id, conversation_id, customer_identifier, customer_name, customer_phone,
         scheduled_at, calendar_provider, calendar_event_id)
      values ('${seed.tenantId}', '${seed.conversationId}', '393331125000', 'Mario Rossi',
              '393331125000', now() + interval '9 days', 'google_calendar', 'apt00000000001');
    `);

    const result = erase(db, seed, '393331125000');

    // Nessuna eccezione, e la cancellazione locale committa davvero.
    expect(result.deleted.appointments).toBe(2);
    expect(count(db, 'conversations', seed.tenantId)).toBe(0);
    expect(count(db, 'appointments', seed.tenantId)).toBe(0);

    // Un solo oggetto remoto -> un solo debito, e il conteggio dice UNO: sono
    // le obbligazioni catturate, non gli appuntamenti che le hanno generate.
    const rows = db.query<{ external_event_id: string }>(
      `select external_event_id from public.erasure_obligations where tenant_ref = '${seed.tenantId}'`,
    );
    expect(rows).toHaveLength(1);
    expect(result.pendingObligations).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Autorita' e identita' del calendario (R2)
  //
  // Il calendario su cui cancellare non si indovina. Se non lo sappiamo, la
  // riga deve dirlo: una riga che finge un calendario noto verrebbe cancellata
  // sul calendario sbagliato, riceverebbe 404, e il 404 di `cancelEvent` vale
  // successo idempotente. Il debito risulterebbe chiuso e l'evento — con
  // dentro il telefono del cliente — resterebbe vivo su Google.
  // -------------------------------------------------------------------------

  it("CASO A — autorita' + provenienza registrata: pending sul calendario storico", () => {
    const seed = seedGoogleCase(db, {
      phone: '393332000001',
      integrationStatus: 'active',
      storedProvenance: 'storico@example.com',
    });

    const result = erase(db, seed, '393332000001');

    expect(result.pendingObligations).toBe(1);
    expect(result.manualRequired).toBe(0);
    // La provenienza registrata batte sempre la config corrente: e' dove
    // l'evento e' stato scritto DAVVERO.
    expect(obligation(db, seed.tenantId)).toEqual({
      status: 'pending',
      calendar_id: 'storico@example.com',
    });
  });

  it("CASO B — autorita' senza provenienza: pending sul calendario corrente", () => {
    const seed = seedGoogleCase(db, {
      phone: '393332000002',
      integrationStatus: 'active',
      storedProvenance: null,
    });

    const result = erase(db, seed, '393332000002');

    expect(result.pendingObligations).toBe(1);
    // Fallback storico noto e documentato: la config corrente e' la miglior
    // ipotesi disponibile finche' P0-3C non popola la provenienza.
    expect(obligation(db, seed.tenantId)).toEqual({
      status: 'pending',
      calendar_id: CALENDAR_ID,
    });
  });

  it("CASO C — nessuna autorita': manual_required, ma la provenienza si conserva", () => {
    const seed = seedGoogleCase(db, {
      phone: '393332000003',
      integrationStatus: 'revoked',
      storedProvenance: 'storico@example.com',
    });

    const result = erase(db, seed, '393332000003');

    // Il calendario e' noto, ma il token per cancellare no. Nessun automatismo
    // potra' chiudere questo debito: nasce gia' come lavoro di un operatore.
    expect(result.manualRequired).toBe(1);
    expect(result.pendingObligations).toBe(0);
    // La provenienza resta: serve a chi dovra' rimediare a mano.
    expect(obligation(db, seed.tenantId)).toEqual({
      status: 'manual_required',
      calendar_id: 'storico@example.com',
    });
  });

  it("CASO D — nessuna autorita' e nessuna provenienza: calendar_id NULL, MAI 'primary'", () => {
    const seed = seedGoogleCase(db, {
      phone: '393332000004',
      integrationStatus: 'revoked',
      storedProvenance: null,
    });

    const result = erase(db, seed, '393332000004');

    expect(result.manualRequired).toBe(1);
    expect(result.pendingObligations).toBe(0);

    const row = obligation(db, seed.tenantId);
    expect(row.status).toBe('manual_required');
    // Questo e' il punto dell'intero caso: ignoto si scrive ignoto.
    expect(row.calendar_id).toBeNull();
    expect(row.calendar_id).not.toBe('primary');
  });

  it("manual_required puo' conoscere l'evento senza conoscere il calendario", () => {
    const tenantId = seedTenantOnly(db);

    const accepted = db.trySql(`
      insert into public.erasure_obligations
        (request_id, tenant_ref, obligation_type, status, calendar_id, external_event_id)
      values ('${randomUUID()}', '${tenantId}', 'google_event_delete', 'manual_required',
              null, 'evt_calendario_ignoto')
    `);

    // Lo stato onesto deve essere rappresentabile, altrimenti il vincolo
    // costringerebbe a inventare un calendario.
    expect(accepted).toBe('OK');
  });

  it("uno stato eseguibile non puo' conoscere l'evento senza il calendario", () => {
    const tenantId = seedTenantOnly(db);

    for (const status of ['pending', 'scheduled', 'converged']) {
      const rejected = db.trySql(`
        insert into public.erasure_obligations
          (request_id, tenant_ref, obligation_type, status, calendar_id, external_event_id)
        values ('${randomUUID()}', '${tenantId}', 'google_event_delete', '${status}',
                null, 'evt_non_eseguibile')
      `);

      // 23514 = check_violation. Un worker non saprebbe dove cancellare.
      expect(rejected).toBe('23514');
    }
  });

  // -------------------------------------------------------------------------
  // last_error_code: un codice, non un messaggio
  // -------------------------------------------------------------------------

  it('last_error_code accetta un codice stabile e rifiuta il testo libero', () => {
    const tenantId = seedTenantOnly(db);

    const insertWithCode = (code: string): string =>
      db.trySql(`
        insert into public.erasure_obligations
          (request_id, tenant_ref, obligation_type, status, calendar_id, external_event_id, last_error_code)
        values ('${randomUUID()}', '${tenantId}', 'google_event_delete', 'manual_required',
                null, '${randomUUID()}', '${code.replace(/'/g, "''")}')
      `);

    for (const code of ['google_401', 'timeout', 'retry_exhausted']) {
      expect(insertWithCode(code)).toBe('OK');
    }

    // Il corpo di una risposta Google contiene extendedProperties, cioe' il
    // telefono del cliente: questa colonna non deve poterlo ospitare.
    expect(
      insertWithCode('Google API error: event with customerPhone 393331112233 not found'),
    ).toBe('23514');
    expect(insertWithCode('x'.repeat(65))).toBe('23514');
  });

  // -------------------------------------------------------------------------
  // Esito locale (R3)
  // -------------------------------------------------------------------------

  it("senza residui ambigui la cancellazione locale e' completa", () => {
    const seed = seedCustomer(db, { phone: '393331126000', withGoogleEvent: true });
    const result = erase(db, seed, '393331126000');

    expect(result.localDeletion).toBe('complete');
    expect(result.residualSuspected).toBe(0);
    // Il debito remoto e' una dimensione a se': resta pending anche qui.
    expect(result.pendingObligations).toBe(1);
  });

  it("con un alias sospetto l'esito locale NON e' completo", () => {
    const seed = seedCustomer(db, { phone: '3336667799' });

    // Nazionale contro internazionale: la riga resta viva (cancellarla
    // sarebbe distruggere i dati di un altro), quindi la cancellazione locale
    // non e' finita — ha solo finito la parte che si poteva fare da sola.
    const result = erase(db, seed, '393336667799');

    expect(result.residualSuspected).toBeGreaterThan(0);
    expect(result.localDeletion).toBe('manual_review_required');
    // L'ambiguita' locale non inquina lo stato del debito remoto.
    expect(result.pendingObligations).toBe(0);
    expect(result.manualRequired).toBe(0);
  });

  it("l'audit registra l'esito locale vero, senza il numero del cliente", () => {
    const seed = seedCustomer(db, { phone: '3336667711' });
    erase(db, seed, '393336667711');

    const metadata = auditRows(db, seed.tenantId)[0]?.metadata as Record<string, unknown>;

    expect(metadata.localDeletion).toBe('manual_review_required');
    expect(metadata).not.toHaveProperty('customerPhone');
    expect(JSON.stringify(metadata)).not.toContain('3336667711');
  });

  // -------------------------------------------------------------------------
  // Sopravvivenza del debito
  // -------------------------------------------------------------------------

  it('tenant_ref non ha nessuna foreign key', () => {
    const fks = db.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'public.erasure_obligations'::regclass and contype = 'f'`,
    );

    // Con una FK verso tenants, il debito sparirebbe nell'istante esatto in cui
    // si perde l'autorita' per onorarlo.
    expect(fks).toEqual([]);
  });

  it('le obbligazioni sopravvivono al hard delete del tenant', () => {
    const seed = seedCustomer(db, { phone: '393331120000', withGoogleEvent: true });
    erase(db, seed, '393331120000');

    db.exec(`delete from public.tenants where id = '${seed.tenantId}';`);

    const survived = db.query<{ status: string; external_event_id: string }>(
      `select status, external_event_id from public.erasure_obligations where tenant_ref = '${seed.tenantId}'`,
    );

    expect(survived).toHaveLength(1);
    expect(survived[0]?.status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // Permessi
  // -------------------------------------------------------------------------

  it("RLS e' attivo sulla tabella delle obbligazioni", () => {
    const rows = db.query<{ relrowsecurity: boolean; policies: number }>(
      `select c.relrowsecurity,
              (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c where c.oid = 'public.erasure_obligations'::regclass`,
    );

    expect(rows[0]?.relrowsecurity).toBe(true);
    // Nessuna policy: RLS attivo senza policy nega tutto a chi non bypassa.
    expect(Number(rows[0]?.policies)).toBe(0);
  });

  it("la funzione e' SECURITY INVOKER", () => {
    const rows = db.query<{ prosecdef: boolean }>(
      `select prosecdef from pg_proc where proname = 'erase_customer_data'`,
    );

    expect(rows[0]?.prosecdef).toBe(false);
  });

  it('anon e authenticated non possono eseguire la cancellazione', () => {
    const seed = seedCustomer(db, { phone: '393331121000' });

    for (const role of ['anon', 'authenticated']) {
      const attempt = db.execAs(role, eraseSql(seed, '393331121000'));
      expect(attempt.ok).toBe(false);
      expect(attempt.error).toContain('permission denied');
    }

    expect(count(db, 'conversations', seed.tenantId)).toBe(1);
  });

  it("service_role puo' eseguire la cancellazione", () => {
    const seed = seedCustomer(db, { phone: '393331122000' });

    const attempt = db.execAs('service_role', eraseSql(seed, '393331122000'));

    expect(attempt.ok).toBe(true);
    expect(count(db, 'conversations', seed.tenantId)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it("scrive l'audit nella stessa transazione, senza il numero del cliente", () => {
    const seed = seedCustomer(db, { phone: '393331123000', withGoogleEvent: true });
    const result = erase(db, seed, '393331123000');

    const rows = auditRows(db, seed.tenantId);
    expect(rows).toHaveLength(1);

    const metadata = rows[0]?.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('customerPhone');
    expect(metadata.requestId).toBe(result.requestId);
    expect(metadata.pendingObligations).toBe(1);

    // Nessun campo dell'audit contiene il numero, in nessuna forma.
    expect(JSON.stringify(rows[0])).not.toContain('393331123000');
  });

  it('la bonifica storica toglie il telefono da ENTRAMBE le azioni GDPR', () => {
    const tenantId = seedTenantOnly(db);

    for (const action of ['gdpr.customer.deletion.executed', 'gdpr.customer.export.requested']) {
      db.exec(`
        insert into public.audit_log (tenant_id, action, resource_type, metadata)
        values ('${tenantId}', '${action}', 'customer',
                '{"customerPhone":"393331124000","totalRows":4}'::jsonb);
      `);
    }

    // Si esegue lo statement preso dalla migration stessa, non una sua copia
    // riscritta nel test.
    const scrub = extractScrubStatement();
    db.exec(`${scrub}`);

    const remaining = db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log
        where tenant_id = '${tenantId}' and metadata ? 'customerPhone'`,
    );
    expect(Number(remaining[0]?.n)).toBe(0);

    // Le righe restano: e' un registro di conformita', non va cancellato.
    const kept = db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log where tenant_id = '${tenantId}'`,
    );
    expect(Number(kept[0]?.n)).toBe(2);

    // Ripetibile.
    db.exec(`${scrub}`);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eraseSql(seed: Pick<Seed, 'tenantId' | 'userId'>, phone: string): string {
  return `select public.erase_customer_data('${seed.tenantId}'::uuid, '${phone}', '${randomUUID()}'::uuid, '${seed.userId}'::uuid, null, 'Vitest')`;
}

function erase(db: TestDatabase, seed: Seed, phone: string): ErasureResult {
  const rows = db.query<{ result: ErasureResult }>(
    `select ${eraseSql(seed, phone).replace(/^select /, '')} as result`,
  );

  const result = rows[0]?.result;

  if (!result) {
    throw new Error('erase_customer_data returned no result');
  }

  return result;
}

function count(db: TestDatabase, table: string, tenantId: string): number {
  const rows = db.query<{ n: number }>(
    `select count(*)::int as n from public.${table} where tenant_id = '${tenantId}'`,
  );
  return Number(rows[0]?.n ?? 0);
}

function auditRows(
  db: TestDatabase,
  tenantId: string,
): Array<{ action: string; metadata: unknown }> {
  return db.query<{ action: string; metadata: unknown }>(
    `select action, metadata from public.audit_log
      where tenant_id = '${tenantId}' and action = 'gdpr.customer.deletion.executed'`,
  );
}

function seedTenantOnly(db: TestDatabase): string {
  const tenantId = randomUUID();
  db.exec(`
    insert into public.tenants (id, name, slug, billing_email)
    values ('${tenantId}', 'Studio Test', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');
  `);
  return tenantId;
}

function seedCustomer(
  db: TestDatabase,
  options: { phone: string; withGoogleEvent?: boolean | 'missing-id' },
): Seed {
  const tenantId = seedTenantOnly(db);
  const userId = randomUUID();
  const conversationId = randomUUID();
  const appointmentId = randomUUID();
  const messageIds = [randomUUID(), randomUUID()];
  const phone = options.phone.replace(/'/g, "''");

  const calendarProvider = options.withGoogleEvent ? `'google_calendar'` : 'null';
  const calendarEventId = options.withGoogleEvent === true ? `'apt00000000001'` : 'null';

  db.exec(`
    insert into auth.users (id) values ('${userId}');
    insert into public.users (id, tenant_id, role) values ('${userId}', '${tenantId}', 'owner');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', 'active',
            '{"calendar_id":"${CALENDAR_ID}"}'::jsonb);

    insert into public.conversations (id, tenant_id, channel, customer_identifier)
    values ('${conversationId}', '${tenantId}', 'whatsapp', '${phone}');

    insert into public.messages (id, tenant_id, conversation_id, direction, sender_type, content)
    values ('${messageIds[0]}', '${tenantId}', '${conversationId}', 'inbound', 'customer', 'ciao'),
           ('${messageIds[1]}', '${tenantId}', '${conversationId}', 'outbound', 'ai', 'buongiorno');

    insert into public.voice_events (tenant_id, message_id, direction, model)
    values ('${tenantId}', '${messageIds[0]}', 'stt', 'scribe_v1');

    insert into public.scheduling_decisions
      (tenant_id, conversation_id, request, ranking_version, candidates)
    values ('${tenantId}', '${conversationId}', '{"q":"domani"}'::jsonb, 'v1', '[]'::jsonb);

    insert into public.appointments
      (id, tenant_id, conversation_id, customer_identifier, customer_name, customer_phone,
       scheduled_at, calendar_provider, calendar_event_id)
    values ('${appointmentId}', '${tenantId}', '${conversationId}', '${phone}', 'Mario Rossi',
            '${phone}', now() + interval '2 days', ${calendarProvider}, ${calendarEventId});

    insert into public.opt_outs (tenant_id, channel, customer_identifier)
    values ('${tenantId}', 'whatsapp', '${phone}');
  `);

  return { tenantId, userId, conversationId, appointmentId, messageIds };
}

/**
 * Un solo appuntamento Google, con autorita' e provenienza controllabili.
 *
 * Serve alla matrice R2: le due variabili che decidono se un evento noto sia
 * un debito eseguibile o il lavoro di un operatore sono esattamente queste.
 */
function seedGoogleCase(
  db: TestDatabase,
  options: {
    phone: string;
    integrationStatus: 'active' | 'revoked';
    storedProvenance: string | null;
  },
): Seed {
  const tenantId = seedTenantOnly(db);
  const userId = randomUUID();
  const conversationId = randomUUID();
  const appointmentId = randomUUID();
  const provenance = options.storedProvenance === null ? 'null' : `'${options.storedProvenance}'`;

  db.exec(`
    insert into auth.users (id) values ('${userId}');
    insert into public.users (id, tenant_id, role) values ('${userId}', '${tenantId}', 'owner');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', '${options.integrationStatus}',
            '{"calendar_id":"${CALENDAR_ID}"}'::jsonb);

    insert into public.conversations (id, tenant_id, channel, customer_identifier)
    values ('${conversationId}', '${tenantId}', 'whatsapp', '${options.phone}');

    insert into public.appointments
      (id, tenant_id, conversation_id, customer_identifier, customer_name, customer_phone,
       scheduled_at, calendar_provider, calendar_event_id, calendar_event_calendar_id)
    values ('${appointmentId}', '${tenantId}', '${conversationId}', '${options.phone}',
            'Mario Rossi', '${options.phone}', now() + interval '2 days',
            'google_calendar', 'evt_${options.phone}', ${provenance});
  `);

  return { tenantId, userId, conversationId, appointmentId, messageIds: [] };
}

/** L'unica obbligazione del tenant, per asserire stato e calendario insieme. */
function obligation(
  db: TestDatabase,
  tenantId: string,
): { status: string; calendar_id: string | null } {
  const rows = db.query<{ status: string; calendar_id: string | null }>(
    `select status, calendar_id from public.erasure_obligations where tenant_ref = '${tenantId}'`,
  );

  expect(rows).toHaveLength(1);

  return rows[0] as { status: string; calendar_id: string | null };
}

/** Estrae la UPDATE di bonifica dalla migration, per testare quella vera. */
function extractScrubStatement(): string {
  const sql = readFileSync('supabase/migrations/202608250001_erasure_obligations.sql', 'utf8');
  const start = sql.lastIndexOf('update public.audit_log');

  if (start < 0) {
    throw new Error('scrub statement not found in migration');
  }

  return sql.slice(start);
}
