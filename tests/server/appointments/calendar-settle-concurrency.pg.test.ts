// PILOT-P0-3C — CARATTERIZZAZIONE. Non e' una specifica di comportamento
// desiderato: e' la fotografia eseguibile di cio' che il codice fa OGGI.
//
// Ogni test di questo file resta verde affermando una realta' SBAGLIATA.
// Serve al Second Architect per sapere cosa deve rompere.
//
// Girano contro PostgreSQL vero con le migration vere, perche' il difetto
// centrale — un UPDATE che non trova nessuna riga e non lo dice a nessuno —
// e' un fatto di semantica SQL e di confine PostgREST. Un repository finto in
// memoria lo assumerebbe invece di dimostrarlo.
//
// Se non c'e' un PostgreSQL locale la suite si salta invece di fallire.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase, postgresAvailable, type TestDatabase } from '../../helpers/postgres';
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

const { SupabaseAppointmentBookingRepository } = await import('@/server/appointments/booking');
const { SupabaseCalendarReconcilerRepository, CalendarSyncReconciler } =
  await import('@/server/appointments/calendar-reconciler');
const { CALENDAR_SYNC_LEASE_MS, deriveCalendarEventId } =
  await import('@/server/appointments/calendar-convergence');

const NOW = new Date('2026-04-27T07:00:00.000Z');
const CUSTOMER_PHONE = '393331112233';

type Seed = { tenantId: string; appointmentId: string; eventId: string };

describePg('PILOT-P0-3C — caratterizzazione della concorrenza di settle', () => {
  let db: TestDatabase;

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

  // -------------------------------------------------------------------------
  // C1 — il settle a zero righe e' silenzioso, in ENTRAMBE le implementazioni
  // -------------------------------------------------------------------------

  it('characterizes the silent zero-row settle in the booking repository', async () => {
    const seed = seedSyncableAppointment(db);
    const repository = new SupabaseAppointmentBookingRepository();

    // L'appuntamento sparisce: e' cio' che fa la cancellazione GDPR di P0-3A,
    // che cancella la riga dentro la transazione di `erase_customer_data`.
    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    bridge?.reset();

    // Il settle arriva dopo. Non solleva.
    await expect(
      repository.updateAppointmentCalendarSync({
        tenantId: seed.tenantId,
        appointmentId: seed.appointmentId,
        status: 'synced',
        eventId: seed.eventId,
        htmlLink: 'https://calendar.google.com/event?eid=x',
        errorMessage: null,
        attempts: 0,
        nextAttemptAt: null,
        lastAttemptAt: NOW,
      }),
    ).resolves.toBeUndefined();

    const call = bridge?.calls.at(-1);

    // Verita' del database: zero righe toccate.
    expect(call?.verb).toBe('update');
    expect(call?.affectedRows).toBe(0);
    // Verita' del confine: il repository non ha MAI chiesto quante righe
    // avesse toccato, quindi non poteva accorgersene.
    expect(call?.selectRequested).toBe(false);

    // ZERO_ROW_SETTLE_CURRENTLY_SILENT = TRUE
  });

  it('characterizes the silent zero-row settle in the reconciler repository', async () => {
    const seed = seedSyncableAppointment(db);
    const repository = new SupabaseCalendarReconcilerRepository();

    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    bridge?.reset();

    await expect(
      repository.updateAppointmentCalendarSync({
        tenantId: seed.tenantId,
        appointmentId: seed.appointmentId,
        status: 'synced',
        eventId: seed.eventId,
        htmlLink: null,
        errorMessage: null,
        attempts: 1,
        nextAttemptAt: null,
        lastAttemptAt: NOW,
      }),
    ).resolves.toBeUndefined();

    const call = bridge?.calls.at(-1);

    expect(call?.affectedRows).toBe(0);
    expect(call?.selectRequested).toBe(false);
  });

  it('characterizes zero rows and one row as the same observable outcome', async () => {
    // La prova che il silenzio non e' "un errore ingoiato" ma un'AMBIGUITA':
    // il chiamante riceve lo stesso identico valore nei due casi, quindi
    // nessuna logica a valle puo' distinguerli.
    const present = seedSyncableAppointment(db);
    const repository = new SupabaseAppointmentBookingRepository();

    const settle = (target: Seed): Promise<void> =>
      repository.updateAppointmentCalendarSync({
        tenantId: target.tenantId,
        appointmentId: target.appointmentId,
        status: 'synced',
        eventId: target.eventId,
        htmlLink: null,
        errorMessage: null,
        attempts: 0,
        nextAttemptAt: null,
        lastAttemptAt: NOW,
      });

    bridge?.reset();
    const hit = await settle(present);

    const missing = seedSyncableAppointment(db);
    db.exec(`delete from public.appointments where id = '${missing.appointmentId}';`);
    const miss = await settle(missing);

    // Identici lato chiamante...
    expect(hit).toBeUndefined();
    expect(miss).toBeUndefined();
    // ...e diversi lato database. L'informazione esiste e viene buttata via.
    expect(bridge?.calls.map((call) => call.affectedRows)).toEqual([1, 0]);
  });

  // -------------------------------------------------------------------------
  // C2 — un settle stantio sovrascrive uno stato piu' recente e legittimo
  // -------------------------------------------------------------------------

  it('characterizes a stale worker settle clobbering a newer reschedule', async () => {
    const seed = seedSyncableAppointment(db);
    const reconcilerRepository = new SupabaseCalendarReconcilerRepository();
    const bookingRepository = new SupabaseAppointmentBookingRepository();

    // 1. Worker A vede la riga e la rivendica. La CAS sui tentativi funziona:
    //    e' l'unica parte di questo percorso che sia davvero guardata.
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

    // Worker A tiene in memoria lo stato desiderato VECCHIO (`claimedRow`) e
    // da qui in poi non rilegge piu' niente.
    const staleDesiredStart = claimedRow?.scheduledAt;

    // 2. Il lease scade mentre Worker A e' ancora dentro una scrittura Google
    //    non limitata (nessun bound: vedi il report P0-3C). Nel frattempo
    //    arriva una riprogrammazione legittima.
    const newStart = new Date(NOW.getTime() + 6 * 60 * 60_000);
    await bookingRepository.updateAppointmentSchedule({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      scheduledAt: newStart,
      durationMinutes: 30,
      notes: null,
      calendarProvider: 'google_calendar',
      calendarSyncStatus: 'pending',
      calendarSyncNextAttemptAt: new Date(NOW.getTime() + CALENDAR_SYNC_LEASE_MS + 1000),
    });

    const afterReschedule = readRow(db, seed.appointmentId);
    expect(afterReschedule.calendar_sync_status).toBe('pending');
    expect(Number(afterReschedule.calendar_sync_attempts)).toBe(0);
    expect(new Date(String(afterReschedule.scheduled_at)).toISOString()).toBe(
      newStart.toISOString(),
    );

    // 3. Worker A finisce e registra il proprio esito. Non c'e' nessuna CAS:
    //    il settle filtra solo su tenant_id e id.
    await reconcilerRepository.updateAppointmentCalendarSync({
      tenantId: seed.tenantId,
      appointmentId: seed.appointmentId,
      status: 'synced',
      eventId: seed.eventId,
      htmlLink: null,
      errorMessage: null,
      attempts: (claimedRow?.attempts ?? 0) + 1,
      nextAttemptAt: null,
      lastAttemptAt: NOW,
    });

    const clobbered = readRow(db, seed.appointmentId);

    // Lo stato piu' recente e' stato sovrascritto da quello piu' vecchio.
    expect(clobbered.calendar_sync_status).toBe('synced');
    expect(clobbered.calendar_sync_next_attempt_at).toBeNull();
    // L'orario autorevole e' quello NUOVO...
    expect(new Date(String(clobbered.scheduled_at)).toISOString()).toBe(newStart.toISOString());
    // ...mentre cio' che Worker A ha scritto su Google era quello VECCHIO.
    expect(staleDesiredStart?.toISOString()).not.toBe(newStart.toISOString());

    // 4. Il colpo di grazia: la riga non e' piu' visibile allo scanner, quindi
    //    nessun tick futuro riparera' l'evento sbagliato. Si usa il predicato
    //    VERO del reconciler, non una sua trascrizione.
    //
    //    Il testimone serve a escludere una lettura vacua: dimostra che con
    //    quello stesso `now` lo scanner E' in grado di restituire righe, e che
    //    l'assenza della riga sotto esame e' quindi un fatto sul suo stato.
    const witness = seedSyncableAppointment(db);
    const later = new Date(NOW.getTime() + 24 * 60 * 60_000);
    const dueAfter = await reconcilerRepository.listDueCalendarSyncs({ now: later, limit: 100 });

    expect(dueAfter.map((row) => row.appointmentId)).toContain(witness.appointmentId);
    expect(dueAfter.map((row) => row.appointmentId)).not.toContain(seed.appointmentId);

    // STALE_SETTLE_CLOBBER_CONFIRMED
  });

  // -------------------------------------------------------------------------
  // C3a — la cancellazione a zero righe non solleva (fondamenta di C3)
  // -------------------------------------------------------------------------

  it('characterizes cancelAppointmentRecord staying silent when it matches no row', async () => {
    const seed = seedSyncableAppointment(db);
    const repository = new SupabaseAppointmentBookingRepository();

    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    bridge?.reset();

    // Nessun `conflict`, a differenza di `updateAppointmentSchedule` che la
    // stessa classe di corsa la rileva e la rifiuta.
    await expect(
      repository.cancelAppointmentRecord({
        tenantId: seed.tenantId,
        appointmentId: seed.appointmentId,
        calendarSyncStatus: 'pending',
        calendarSyncNextAttemptAt: NOW,
      }),
    ).resolves.toBeUndefined();

    expect(bridge?.calls.at(-1)?.affectedRows).toBe(0);
    expect(bridge?.calls.at(-1)?.selectRequested).toBe(false);
  });

  it('contrasts the guarded reschedule, which does detect the same race', async () => {
    // Il contrasto e' il punto: la capacita' di rilevare zero righe ESISTE
    // gia' in questo repository. Non e' stata applicata al settle ne' alla
    // cancellazione.
    const seed = seedSyncableAppointment(db);
    const repository = new SupabaseAppointmentBookingRepository();

    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    await expect(
      repository.updateAppointmentSchedule({
        tenantId: seed.tenantId,
        appointmentId: seed.appointmentId,
        scheduledAt: new Date(NOW.getTime() + 3 * 60 * 60_000),
        durationMinutes: 30,
        notes: null,
        calendarProvider: 'google_calendar',
        calendarSyncStatus: 'pending',
        calendarSyncNextAttemptAt: NOW,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  // -------------------------------------------------------------------------
  // C7 — claim del reconciler, poi cancellazione, poi scrittura Google
  // -------------------------------------------------------------------------

  it('characterizes the reconciler reporting synced for an appointment erased mid-flight', async () => {
    // Lo scanner e' globale e il database e' condiviso con i test precedenti:
    // si rendono non dovute le righe residue, cosi' il ciclo lavora solo su
    // quella sotto esame e l'innesto scatta dove serve.
    db.exec('update public.appointments set calendar_sync_next_attempt_at = null;');

    const seed = seedSyncableAppointment(db);
    const google = new FakeGoogleCalendar();
    // Seam di test: la cancellazione GDPR VERA cade DOPO il claim e PRIMA
    // della scrittura remota. Si usa `erase_customer_data`, non una DELETE a
    // mano, perche' serve anche l'obbligazione che quella transazione cattura.
    const provider = new ProviderWithHook(google, () => {
      db.exec(
        `select public.erase_customer_data('${seed.tenantId}'::uuid, '${CUSTOMER_PHONE}',
           gen_random_uuid(), null, null, 'Vitest');`,
      );
    });
    const reconciler = new CalendarSyncReconciler(
      new SupabaseCalendarReconcilerRepository(),
      provider,
    );

    const result = await reconciler.processDueSyncs({ now: NOW, limit: 10 });

    // Il job dichiara successo...
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.synced).toBeGreaterThanOrEqual(1);
    expect(result.terminal).toBe(0);

    // ...avendo CREATO su Google l'evento di un appuntamento che in Postgres
    // non esiste piu'. L'asserzione e' sull'IDENTITA', non su un conteggio:
    // il database e' condiviso fra i test di questo file.
    expect(google.activeEvents().map((event) => event.id)).toContain(seed.eventId);

    // La riga non c'e'.
    expect(
      db.query(`select id from public.appointments where id = '${seed.appointmentId}'`),
    ).toEqual([]);

    // ...e il settle di QUESTA riga ha toccato zero righe senza dirlo.
    const settleCall = (bridge?.calls ?? [])
      .filter(
        (call) =>
          call.verb === 'update' &&
          call.sql.includes('calendar_sync_status') &&
          call.sql.includes(seed.appointmentId),
      )
      .at(-1);

    // L'obbligazione catturata dalla cancellazione copre proprio l'evento che
    // il reconciler ha appena RICREATO — e resta `pending` con
    // `next_attempt_at` NULL, cioe' deliberatamente non eseguibile.
    //
    // E' la riga R6 della matrice: il debito e' visibile ma inerte, e l'evento
    // remoto con dentro il telefono del cliente e' vivo.
    const obligations = db.query<{
      status: string;
      external_event_id: string | null;
      next_attempt_at: string | null;
    }>(
      `select status, external_event_id, next_attempt_at
         from public.erasure_obligations where tenant_ref = '${seed.tenantId}'`,
    );

    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      status: 'pending',
      external_event_id: seed.eventId,
      next_attempt_at: null,
    });

    expect(settleCall).toBeDefined();
    expect(settleCall?.affectedRows).toBe(0);
    expect(settleCall?.selectRequested).toBe(false);
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

function readRow(db: TestDatabase, appointmentId: string): Record<string, unknown> {
  const rows = db.query<Record<string, unknown>>(
    `select status, scheduled_at, calendar_sync_status, calendar_sync_attempts,
            calendar_sync_next_attempt_at, calendar_event_id
       from public.appointments where id = '${appointmentId}'`,
  );

  if (!rows[0]) {
    throw new Error(`appointment ${appointmentId} not found`);
  }

  return rows[0];
}
