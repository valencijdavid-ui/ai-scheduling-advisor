// PILOT-P0-3C-i — REGRESSIONE. Concorrenza di settle su PostgreSQL vero.
//
// Questo file nasce in P0-3C come CARATTERIZZAZIONE: ogni test restava verde
// affermando una realta' SBAGLIATA, e serviva al Second Architect per sapere
// cosa rompere. C-i l'ha rotta. Le scene restano identiche e le asserzioni si
// rovesciano.
//
// Girano contro PostgreSQL vero con le migration vere, perche' il difetto
// centrale — un UPDATE che non trova nessuna riga e non lo dice a nessuno — e'
// un fatto di semantica SQL e di confine PostgREST. Un repository finto in
// memoria lo assumerebbe invece di dimostrarlo. Per la stessa ragione le
// chiamate passano dalle primitive di PRODUZIONE (`SupabaseCalendarWriteStore`)
// attraverso il ponte PostgREST, non da SQL scritto a mano nel test.
//
// Se non c'e' un PostgreSQL locale la suite si salta invece di fallire.

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestDatabase,
  openSession,
  postgresAvailable,
  waitUntilBlockedOnLock,
  type PgSession,
  type TestDatabase,
} from '../../helpers/postgres';
import { createPostgrestBridge, type PostgrestBridge } from '../../helpers/postgrest-bridge';
import { FakeGoogleCalendar } from '../../fixtures/fake-google-calendar';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

let bridge: PostgrestBridge | null = null;

// Il client Supabase e' costruito dentro i repository (campo privato), quindi
// l'unico modo di consegnargli il ponte e' sostituire la factory.
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => {
    if (!bridge) {
      throw new Error('PostgREST bridge is not ready');
    }

    return bridge.client;
  },
}));

const { SupabaseCalendarReconcilerRepository, CalendarSyncReconciler } =
  await import('@/server/appointments/calendar-reconciler');
const { SupabaseCalendarWriteStore } = await import('@/server/appointments/calendar-write-intents');
const { CALENDAR_SYNC_LEASE_MS, CALENDAR_SYNC_MAX_ATTEMPTS, deriveCalendarEventId } =
  await import('@/server/appointments/calendar-convergence');

const NOW = new Date('2026-04-27T07:00:00.000Z');
const CUSTOMER_PHONE = '393331112233';

type Seed = { tenantId: string; appointmentId: string; eventId: string };

describePg('PILOT-P0-3C-i — concorrenza di settle', () => {
  let db: TestDatabase;
  const openSessions: PgSession[] = [];

  beforeAll(() => {
    db = createTestDatabase();
    bridge = createPostgrestBridge(db);
  }, 120_000);

  afterAll(() => {
    db?.drop();
  });

  beforeEach(() => {
    bridge?.reset();
  });

  afterEach(async () => {
    while (openSessions.length > 0) {
      await openSessions.pop()?.close();
    }
  });

  /**
   * Sessione psql viva, con la sua transazione.
   *
   * Serve solo alle corse che sono proprieta' di LOCK: il ponte PostgREST
   * parla con `execFileSync`, che bloccherebbe il processo di test insieme
   * alla query e renderebbe impossibile osservare l'attesa.
   */
  const session = async (): Promise<PgSession> => {
    const created = await openSession(db);
    openSessions.push(created);
    return created;
  };

  /**
   * La riparazione di riconvergenza scatta per una riga con QUESTI tentativi?
   *
   * La scena e' sempre la stessa — una CAS persa per generazione — e l'unica
   * variabile e' il contatore dei tentativi: e' cosi' che si misura la soglia
   * effettiva della funzione SQL invece di leggerla nel sorgente.
   */
  const staleSettleMarksReconvergence = async (attempts: number): Promise<boolean> => {
    const seed = seedSyncableAppointment(db);
    const store = new SupabaseCalendarWriteStore();

    db.exec(
      `update public.appointments
          set calendar_sync_attempts = ${attempts}
        where id = '${seed.appointmentId}';`,
    );

    const older = await store.openIntent({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      expectedDesiredVersion: 0,
      operation: 'update',
      externalEventId: seed.eventId,
      target: null,
    });
    const newer = await store.openIntent({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      expectedDesiredVersion: 0,
      operation: 'update',
      externalEventId: seed.eventId,
      target: null,
    });

    if (older.outcome !== 'opened' || newer.outcome !== 'opened') {
      throw new Error('the intents were not opened');
    }

    const stale = await store.settle({
      ...authorization(older),
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      calendarSyncStatus: 'synced',
      eventId: seed.eventId,
      errorMessage: null,
      attempts,
      nextAttemptAt: null,
      lastAttemptAt: NOW,
      intentState: 'settled',
      remoteEvidence: 'write_confirmed',
    });

    // La riparazione vive SOLO sul ramo della CAS persa: se l'esito cambiasse,
    // questo helper starebbe misurando un'altra cosa senza dirlo.
    expect(stale.outcome).toBe('write_generation_changed');

    return stale.reconvergenceMarked;
  };

  // -------------------------------------------------------------------------
  // C1 — il settle a zero righe e' TIPIZZATO, non silenzioso
  // -------------------------------------------------------------------------

  it('reports appointment_gone instead of staying silent when the row is gone', async () => {
    const seed = seedSyncableAppointment(db);
    const store = new SupabaseCalendarWriteStore();

    const opened = await store.openIntent({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      expectedDesiredVersion: 0,
      operation: 'update',
      externalEventId: seed.eventId,
      target: { calendarId: 'studio@example.com', identitySource: 'current_config' },
    });
    expect(opened.outcome).toBe('opened');

    // L'appuntamento sparisce: e' cio' che fa la cancellazione GDPR di P0-3A,
    // che cancella la riga dentro la transazione di `erase_customer_data`.
    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    const settled = await store.settle({
      ...authorization(opened),
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      calendarSyncStatus: 'synced',
      eventId: seed.eventId,
      htmlLink: 'https://calendar.google.com/event?eid=x',
      errorMessage: null,
      attempts: 0,
      nextAttemptAt: null,
      lastAttemptAt: NOW,
      intentState: 'settled',
      remoteEvidence: 'write_confirmed',
    });

    // LA PROPRIETA'. Zero righe non e' piu' `undefined`: e' un fatto nominato.
    expect(settled.outcome).toBe('appointment_gone');

    // E l'intento sopravvive alla riga: e' l'evidenza che C-ii dovra' trovare.
    expect(
      db.query(
        `select id from public.calendar_write_intents where appointment_ref = '${seed.appointmentId}'`,
      ),
    ).toHaveLength(1);
  });

  it('distinguishes zero rows from one row as different observable outcomes', async () => {
    // La prova che il silenzio e' finito: i due casi, che prima consegnavano
    // al chiamante lo stesso identico valore, adesso si distinguono.
    const store = new SupabaseCalendarWriteStore();

    const settleFor = async (target: Seed, remove: boolean) => {
      const opened = await store.openIntent({
        tenantId: target.tenantId,
        appointmentId: target.appointmentId,
        expectedProjectionEpoch: 0,
        expectedDesiredVersion: 0,
        operation: 'update',
        externalEventId: target.eventId,
        target: null,
      });

      if (opened.outcome !== 'opened') {
        throw new Error(`open failed: ${opened.outcome}`);
      }

      if (remove) {
        db.exec(`delete from public.appointments where id = '${target.appointmentId}';`);
      }

      return store.settle({
        ...authorization(opened),
        tenantId: target.tenantId,
        appointmentId: target.appointmentId,
        calendarSyncStatus: 'synced',
        eventId: target.eventId,
        errorMessage: null,
        attempts: 0,
        nextAttemptAt: null,
        lastAttemptAt: NOW,
        intentState: 'settled',
        remoteEvidence: 'write_confirmed',
      });
    };

    const hit = await settleFor(seedSyncableAppointment(db), false);
    const miss = await settleFor(seedSyncableAppointment(db), true);

    expect(hit.outcome).toBe('settled_current');
    expect(miss.outcome).toBe('appointment_gone');
    expect(hit.outcome).not.toBe(miss.outcome);
  });

  // -------------------------------------------------------------------------
  // C2 — un settle stantio NON puo' sovrascrivere uno stato piu' recente
  // -------------------------------------------------------------------------

  it('refuses a stale worker settle and leaves the newer reschedule reconvergent', async () => {
    const seed = seedSyncableAppointment(db);
    const reconcilerRepository = new SupabaseCalendarReconcilerRepository();
    const store = new SupabaseCalendarWriteStore();

    // 1. Worker A vede la riga, la rivendica e apre il proprio intento sotto
    //    lo stato desiderato CORRENTE.
    const due = await reconcilerRepository.listDueCalendarSyncs({ now: NOW, limit: 10 });
    const claimedRow = due.find((row) => row.appointmentId === seed.appointmentId);
    expect(claimedRow).toBeDefined();

    const claimed = await reconcilerRepository.claimCalendarSync({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      observedAttempts: claimedRow?.attempts ?? 0,
      leaseUntil: new Date(NOW.getTime() + CALENDAR_SYNC_LEASE_MS),
      lastAttemptAt: NOW,
    });
    expect(claimed).toBe(true);

    const opened = await store.openIntent({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      expectedDesiredVersion: claimedRow?.desiredVersion ?? 0,
      operation: 'update',
      externalEventId: seed.eventId,
      target: null,
    });
    expect(opened.outcome).toBe('opened');

    const staleDesiredStart = claimedRow?.scheduledAt;

    // 2. Il lease scade mentre Worker A e' ancora dentro la scrittura remota.
    //    Nel frattempo arriva una riprogrammazione legittima, che incrementa
    //    ATOMICAMENTE lo stato desiderato.
    const newStart = new Date(NOW.getTime() + 6 * 60 * 60_000);
    const rescheduled = await store.rescheduleGuarded({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      scheduledAt: newStart,
      durationMinutes: 30,
      notes: null,
      calendarProvider: 'google_calendar',
      calendarSyncStatus: 'pending',
      calendarSyncNextAttemptAt: new Date(NOW.getTime() + CALENDAR_SYNC_LEASE_MS + 1000),
    });
    expect(rescheduled.outcome).toBe('rescheduled');

    // 3. Worker A finisce e prova a registrare il proprio esito.
    const settled = await store.settle({
      ...authorization(opened),
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      calendarSyncStatus: 'synced',
      eventId: seed.eventId,
      errorMessage: null,
      attempts: (claimedRow?.attempts ?? 0) + 1,
      nextAttemptAt: null,
      lastAttemptAt: NOW,
      intentState: 'settled',
      remoteEvidence: 'write_confirmed',
    });

    // LA PROPRIETA'. Lo scrittore vecchio ha perso: non ha scritto niente.
    expect(settled.outcome).toBe('desired_version_changed');
    expect(settled.reconvergenceMarked).toBe(true);

    const row = readRow(db, seed.appointmentId);

    // Lo stato desiderato piu' recente e' intatto...
    expect(new Date(String(row.scheduled_at)).toISOString()).toBe(newStart.toISOString());
    expect(row.calendar_sync_status).toBe('pending');
    // ...e cio' che Worker A aveva scritto su Google era quello VECCHIO.
    expect(staleDesiredStart?.toISOString()).not.toBe(newStart.toISOString());

    // 4. E la riga resta VISIBILE allo scanner, quindi la proiezione corrente
    //    verra' riparata. Si usa il predicato VERO del reconciler.
    //
    //    Il testimone esclude una lettura vacua: dimostra che con quello
    //    stesso `now` lo scanner restituisce righe.
    const witness = seedSyncableAppointment(db);
    // Dopo la scadenza del lease riscritto dalla riprogrammazione, e prima
    // dell'orario NUOVO: lo scanner esclude gli appuntamenti gia' passati, e
    // guardare oltre `newStart` misurerebbe quello invece della visibilita'.
    const later = new Date(NOW.getTime() + 3 * 60 * 60_000);
    const dueAfter = await reconcilerRepository.listDueCalendarSyncs({ now: later, limit: 100 });

    expect(dueAfter.map((r) => r.appointmentId)).toContain(witness.appointmentId);
    expect(dueAfter.map((r) => r.appointmentId)).toContain(seed.appointmentId);
  });

  // -------------------------------------------------------------------------
  // GENERAZIONE DI SCRITTURA — perche' `desired_version` da sola non basta
  // -------------------------------------------------------------------------

  it('refuses a settle from an older write generation at the same desired version', async () => {
    const seed = seedSyncableAppointment(db);
    const store = new SupabaseCalendarWriteStore();

    // Due scrittori sullo STESSO stato desiderato. E' il caso reale del
    // reconciler che ritenta mentre il percorso inline sta ancora lavorando:
    // nessuno dei due ha spostato l'appuntamento, quindi `desired_version` e'
    // identica e non li distingue. Se fosse lei l'unica autorita' di settle, il
    // piu' vecchio potrebbe registrare il proprio esito sopra il piu' recente —
    // e dichiarare `synced` una proiezione costruita su dati che nel frattempo
    // un altro scrittore ha gia' sostituito.
    const older = await store.openIntent({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      expectedDesiredVersion: 0,
      operation: 'update',
      externalEventId: seed.eventId,
      target: { calendarId: 'studio@example.com', identitySource: 'current_config' },
    });
    const newer = await store.openIntent({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      expectedDesiredVersion: 0,
      operation: 'update',
      externalEventId: seed.eventId,
      target: { calendarId: 'studio@example.com', identitySource: 'current_config' },
    });

    if (older.outcome !== 'opened' || newer.outcome !== 'opened') {
      throw new Error('the intents were not opened');
    }

    // Lo stato desiderato e' lo stesso; a cambiare e' solo la generazione.
    expect(newer.desiredVersion).toBe(older.desiredVersion);
    expect(newer.writeGeneration).toBe(older.writeGeneration + 1);

    // Il vecchio scrittore finisce e prova a registrare. Porta una provenienza
    // TUTTA SUA: se riuscisse a scrivere qualcosa, si vedrebbe qui.
    const stale = await store.settle({
      ...authorization(older),
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      calendarSyncStatus: 'synced',
      eventId: seed.eventId,
      eventCalendarId: 'stale-calendar@example.com',
      htmlLink: 'https://calendar.google.com/event?eid=stale',
      errorMessage: null,
      attempts: 1,
      nextAttemptAt: null,
      lastAttemptAt: NOW,
      intentState: 'settled',
      remoteEvidence: 'write_confirmed',
    });

    // LA PROPRIETA'. La generazione piu' vecchia non possiede piu' l'autorita'.
    expect(stale.outcome).toBe('write_generation_changed');
    expect(stale.observedWriteGeneration).toBe(newer.writeGeneration);

    const afterStale = readRow(db, seed.appointmentId);

    // Niente e' stato scritto: ne' lo stato sincronizzato, ne' la provenienza,
    // ne' il link. E la proiezione corrente resta eleggibile.
    expect(afterStale.calendar_sync_status).not.toBe('synced');
    expect(afterStale.calendar_event_calendar_id).toBeNull();
    expect(afterStale.calendar_event_html_link).toBeNull();
    expect(afterStale.calendar_sync_next_attempt_at).not.toBeNull();
    expect(stale.reconvergenceMarked).toBe(true);

    // La generazione CORRENTE, invece, e' autorizzata: e' lei che comanda.
    const current = await store.settle({
      ...authorization(newer),
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      calendarSyncStatus: 'synced',
      eventId: seed.eventId,
      eventCalendarId: 'studio@example.com',
      htmlLink: 'https://calendar.google.com/event?eid=current',
      errorMessage: null,
      attempts: 1,
      nextAttemptAt: null,
      lastAttemptAt: NOW,
      intentState: 'settled',
      remoteEvidence: 'write_confirmed',
    });

    expect(current.outcome).toBe('settled_current');

    const afterCurrent = readRow(db, seed.appointmentId);

    expect(afterCurrent.calendar_sync_status).toBe('synced');
    expect(afterCurrent.calendar_event_calendar_id).toBe('studio@example.com');
  });

  it('repairs reconvergence up to exactly CALENDAR_SYNC_MAX_ATTEMPTS', async () => {
    // La soglia dei tentativi vive DUE VOLTE: in `CALENDAR_SYNC_MAX_ATTEMPTS`
    // e dentro il corpo SQL di `settle_calendar_write`. Postgres non puo'
    // leggere il TypeScript, quindi l'unico guardiano possibile e' un test che
    // MISURA la soglia effettiva della funzione e la confronta con la costante.
    //
    // Se le due divergono — in qualunque direzione — questo test fallisce. E
    // deve: con il TypeScript a 6 e l'SQL fermo a 5, una riga con 5 tentativi
    // resterebbe eleggibile per lo scanner ma fuori dalla riparazione, cioe'
    // `synced` sopra un evento remoto stantio, invisibile a chiunque.
    let effectiveCeiling: number | null = null;

    for (let attempts = 0; attempts <= CALENDAR_SYNC_MAX_ATTEMPTS + 2; attempts += 1) {
      if (!(await staleSettleMarksReconvergence(attempts))) {
        effectiveCeiling = attempts;
        break;
      }
    }

    expect(effectiveCeiling).toBe(CALENDAR_SYNC_MAX_ATTEMPTS);
  }, 60_000);

  // -------------------------------------------------------------------------
  // CAS PERSA — dire QUALE fatto e' successo, non il piu' comodo
  // -------------------------------------------------------------------------

  it('reports appointment_gone when the row disappears between diagnosis and CAS', async () => {
    const seed = seedSyncableAppointment(db);
    const opened = parseJson(
      db.scalar(
        `select public.open_calendar_write_intent(
           '${seed.tenantId}'::uuid, '${seed.appointmentId}'::uuid, 0, 0,
           'update', 'studio@example.com', 'current_config', '${seed.eventId}')`,
      ) ?? '',
    );

    expect(opened.outcome).toBe('opened');

    const deleter = await session();
    const settler = await session();

    // 1. La cancellazione prende il lock di riga e NON committa. Da questo
    //    istante l'appuntamento e' condannato ma ancora visibile a chi legge.
    await deleter.run('begin;');
    await deleter.run(`delete from public.appointments where id = '${seed.appointmentId}';`);

    // 2. Il settle parte. La sua diagnosi iniziale VEDE la riga — la delete non
    //    e' committata — e subito dopo la CAS si blocca sul lock. E' esattamente
    //    la finestra della corsa: fra il `select` che dice "c'e'" e l'`update`
    //    che scoprira' che non c'e' piu'.
    const settling = settler.send(
      settleSql({
        tenantId: seed.tenantId,
        appointmentId: seed.appointmentId,
        eventId: seed.eventId,
        writeGeneration: Number(opened.writeGeneration),
        intentId: String(opened.intentId),
      }),
    );

    await waitUntilBlockedOnLock(db, settler.backendPid);
    expect(settling.isSettled()).toBe(false);

    // 3. La cancellazione committa: la CAS riparte e non trova piu' niente.
    await deleter.run('commit;');

    const outcome = parseJson(await settling.done);

    // LA PROPRIETA'. Zero righe ha un NOME, ed e' quello vero. Chiamarlo
    // `write_generation_changed` descriverebbe un appuntamento vivo con uno
    // scrittore piu' recente: e' falso, e nasconderebbe l'unico fatto che
    // conta, cioe' che di quella riga non resta che l'intento.
    expect(outcome.outcome).toBe('appointment_gone');

    expect(
      db.query(`select id from public.appointments where id = '${seed.appointmentId}'`),
    ).toEqual([]);

    // L'evidenza durevole sopravvive alla riga, e dice perche'.
    const intents = db.query<{ external_event_id: string; last_error_code: string | null }>(
      `select external_event_id, last_error_code from public.calendar_write_intents
        where appointment_ref = '${seed.appointmentId}'`,
    );

    expect(intents).toEqual([
      { external_event_id: seed.eventId, last_error_code: 'appointment_gone' },
    ]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // C3a — la cancellazione a zero righe e' tipizzata (fondamenta di C3)
  // -------------------------------------------------------------------------

  it('reports not_confirmed when the guarded cancel matches no row', async () => {
    const seed = seedSyncableAppointment(db);
    const store = new SupabaseCalendarWriteStore();

    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    const cancelled = await store.cancelGuarded({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      calendarSyncStatus: 'pending',
      calendarSyncNextAttemptAt: NOW,
    });

    // Prima era `undefined`, indistinguibile da un annullamento riuscito.
    expect(cancelled.outcome).toBe('not_confirmed');
  });

  it('reports not_confirmed for the guarded reschedule on the same race', async () => {
    const seed = seedSyncableAppointment(db);
    const store = new SupabaseCalendarWriteStore();

    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    const rescheduled = await store.rescheduleGuarded({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      expectedProjectionEpoch: 0,
      scheduledAt: new Date(NOW.getTime() + 3 * 60 * 60_000),
      durationMinutes: 30,
      notes: null,
      calendarProvider: 'google_calendar',
      calendarSyncStatus: 'pending',
      calendarSyncNextAttemptAt: NOW,
    });

    expect(rescheduled.outcome).toBe('not_confirmed');
  });

  // -------------------------------------------------------------------------
  // C5 — il fence rifiuta una creazione partita sotto un'epoca vecchia
  // -------------------------------------------------------------------------

  it('rejects a create whose captured epoch is older than the tenant authority', async () => {
    const seed = seedSyncableAppointment(db);
    const store = new SupabaseCalendarWriteStore();

    // La cancellazione GDPR fa avanzare l'epoca di proiezione del tenant.
    db.exec(
      `select public.erase_customer_data('${seed.tenantId}'::uuid, '${CUSTOMER_PHONE}',
         gen_random_uuid(), null, null, 'Vitest');`,
    );

    const epoch = Number(
      db.scalar(`select public.read_tenant_projection_epoch('${seed.tenantId}'::uuid)`),
    );
    expect(epoch).toBeGreaterThan(0);

    const newId = randomUUID();
    const created = await store.createAppointmentWithIntent({
      id: newId,
      tenantId: seed.tenantId,
      // Il turno aveva catturato l'epoca PRIMA della cancellazione.
      expectedProjectionEpoch: 0,
      conversationId: null,
      serviceId: null,
      serviceName: 'Prima visita',
      customerIdentifier: CUSTOMER_PHONE,
      customerName: 'Mario Rossi',
      customerPhone: CUSTOMER_PHONE,
      scheduledAt: new Date(NOW.getTime() + 72 * 60 * 60_000),
      durationMinutes: 30,
      notes: null,
      bookingSource: 'whatsapp_ai',
      calendarProvider: 'google_calendar',
      calendarSyncStatus: 'pending',
      calendarEventId: deriveCalendarEventId(newId),
      calendarSyncNextAttemptAt: NOW,
      target: { calendarId: 'studio@example.com', identitySource: 'current_config' },
    });

    expect(created.outcome).toBe('stale_projection_epoch');

    // Nessuna riga, nessun intento: la transazione non ha superato il fence.
    expect(db.query(`select id from public.appointments where id = '${newId}'`)).toEqual([]);
    expect(
      db.query(`select id from public.calendar_write_intents where appointment_ref = '${newId}'`),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // C7 — claim del reconciler, poi cancellazione, poi scrittura Google
  // -------------------------------------------------------------------------

  it('does not report synced for an appointment erased mid-flight, and keeps the evidence', async () => {
    // Lo scanner e' globale e il database e' condiviso con i test precedenti:
    // si rendono non dovute le righe residue, cosi' il ciclo lavora solo su
    // quella sotto esame e l'innesto scatta dove serve.
    db.exec('update public.appointments set calendar_sync_next_attempt_at = null;');

    const seed = seedSyncableAppointment(db);
    const google = new FakeGoogleCalendar([], 'studio@example.com');
    // Seam di test: la cancellazione GDPR VERA cade DOPO il claim e DOPO
    // l'apertura dell'intento, PRIMA della scrittura remota.
    const provider = new ProviderWithHook(google, () => {
      db.exec(
        `select public.erase_customer_data('${seed.tenantId}'::uuid, '${CUSTOMER_PHONE}',
           gen_random_uuid(), null, null, 'Vitest');`,
      );
    });
    const reconciler = new CalendarSyncReconciler(
      new SupabaseCalendarReconcilerRepository(),
      provider,
      new SupabaseCalendarWriteStore(),
    );

    const result = await reconciler.processDueSyncs({ now: NOW, limit: 10 });

    // LA PROPRIETA'. Il job NON dichiara sincronizzata una riga che non c'e'
    // piu': l'esito e' un ritentativo, non un successo.
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.synced).toBe(0);

    // La riga non c'e'.
    expect(
      db.query(`select id from public.appointments where id = '${seed.appointmentId}'`),
    ).toEqual([]);

    // L'obbligazione catturata dalla cancellazione copre l'evento remoto...
    const obligations = db.query<{
      status: string;
      external_event_id: string | null;
    }>(
      `select status, external_event_id
         from public.erasure_obligations where tenant_ref = '${seed.tenantId}'`,
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.external_event_id).toBe(seed.eventId);

    // ...e l'INTENTO sopravvive alla riga cancellata. E' l'evidenza durevole
    // che C-ii spazzera': qui resta visibile e non risolta, che e' lo stato
    // atteso alla fine di C-i.
    const intents = db.query<{ state: string; external_event_id: string }>(
      `select state, external_event_id from public.calendar_write_intents
        where appointment_ref = '${seed.appointmentId}'`,
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.external_event_id).toBe(seed.eventId);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Delegante con un innesto prima della prima lettura remota.
 *
 * E' un seam di TEST: non esiste nessun hook equivalente in produzione, e
 * nessuno e' stato aggiunto per rendere possibile questo test.
 */
class ProviderWithHook {
  constructor(
    private readonly inner: FakeGoogleCalendar,
    private readonly beforeFirstCall: () => void,
  ) {}

  private fired = false;

  private fire(): void {
    if (!this.fired) {
      this.fired = true;
      this.beforeFirstCall();
    }
  }

  async getEvent(input: Parameters<FakeGoogleCalendar['getEvent']>[0]) {
    this.fire();
    return this.inner.getEvent(input);
  }

  async createEvent(input: Parameters<FakeGoogleCalendar['createEvent']>[0]) {
    this.fire();
    return this.inner.createEvent(input);
  }

  async updateEvent(input: Parameters<FakeGoogleCalendar['updateEvent']>[0]) {
    this.fire();
    return this.inner.updateEvent(input);
  }

  async cancelEvent(input: Parameters<FakeGoogleCalendar['cancelEvent']>[0]) {
    this.fire();
    return this.inner.cancelEvent(input);
  }
}

/**
 * Argomenti di CAS estratti da un intento appena aperto.
 *
 * Sono i quattro valori che decidono se lo scrittore ha ancora il diritto di
 * scrivere. Il tipo stretto viene da `openIntent` solo nel ramo `opened`.
 */
function authorization(opened: { outcome: string } & Record<string, unknown>): {
  expectedProjectionEpoch: number;
  expectedDesiredVersion: number;
  expectedWriteGeneration: number;
  intentId: string;
} {
  if (opened.outcome !== 'opened') {
    throw new Error(`intent was not opened: ${opened.outcome}`);
  }

  return {
    expectedProjectionEpoch: opened.projectionEpoch as number,
    expectedDesiredVersion: opened.desiredVersion as number,
    expectedWriteGeneration: opened.writeGeneration as number,
    intentId: opened.intentId as string,
  };
}

function seedSyncableAppointment(db: TestDatabase): Seed {
  const tenantId = randomUUID();
  const appointmentId = randomUUID();
  // Stessa identita' che genera la produzione: derivata dall'id
  // dell'appuntamento, quindi unica per riga e stabile fra i tentativi.
  const eventId = deriveCalendarEventId(appointmentId);

  db.exec(`
    insert into public.tenants (id, name, slug, billing_email)
    values ('${tenantId}', 'Studio Test', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', 'active', '{"calendar_id":"studio@example.com"}'::jsonb);

    insert into public.appointments
      (id, tenant_id, customer_identifier, customer_name, customer_phone, scheduled_at,
       duration_minutes, service_type, status, calendar_provider, calendar_sync_status,
       calendar_event_id, calendar_sync_attempts, calendar_sync_next_attempt_at)
    values ('${appointmentId}', '${tenantId}', '${CUSTOMER_PHONE}', 'Mario Rossi', '${CUSTOMER_PHONE}',
            '${new Date(NOW.getTime() + 48 * 60 * 60_000).toISOString()}',
            30, 'Prima visita', 'confirmed', 'google_calendar', 'pending',
            '${eventId}', 0, '${NOW.toISOString()}');
  `);

  return { tenantId, appointmentId, eventId };
}

/**
 * Esito di una funzione che ritorna jsonb, letto da una sessione psql.
 *
 * Si prende l'ULTIMA riga: un `notice` o un messaggio d'errore precedente
 * finisce nello stesso flusso, ed e' un esito da asserire, non da nascondere.
 */
function parseJson(raw: string): Record<string, unknown> {
  const line = raw.trim().split('\n').at(-1) ?? '';

  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`psql did not return JSON: ${raw}`, { cause: error });
  }
}

/** Settle scritto in SQL: la corsa vive fra due sessioni, non nel ponte. */
function settleSql(input: {
  tenantId: string;
  appointmentId: string;
  eventId: string;
  writeGeneration: number;
  intentId: string;
}): string {
  return `select public.settle_calendar_write(
    p_tenant_id := '${input.tenantId}'::uuid,
    p_appointment_id := '${input.appointmentId}'::uuid,
    p_expected_projection_epoch := 0,
    p_expected_desired_version := 0,
    p_expected_write_generation := ${input.writeGeneration},
    p_calendar_sync_status := 'synced',
    p_calendar_sync_error := null,
    p_calendar_sync_attempts := 1,
    p_calendar_sync_next_attempt_at := null,
    p_calendar_sync_last_attempt_at := now(),
    p_calendar_event_id := '${input.eventId}',
    p_calendar_event_calendar_id := 'studio@example.com',
    p_calendar_event_html_link := null,
    p_set_html_link := false,
    p_intent_id := '${input.intentId}'::uuid,
    p_intent_state := 'settled',
    p_intent_error_code := null,
    p_remote_evidence := 'write_confirmed'
  );`;
}

function readRow(db: TestDatabase, appointmentId: string): Record<string, unknown> {
  const rows = db.query<Record<string, unknown>>(
    `select status, scheduled_at, calendar_sync_status, calendar_sync_attempts,
            calendar_sync_next_attempt_at, calendar_event_id,
            calendar_event_calendar_id, calendar_event_html_link
       from public.appointments where id = '${appointmentId}'`,
  );

  if (!rows[0]) {
    throw new Error(`appointment ${appointmentId} not found`);
  }

  return rows[0];
}
