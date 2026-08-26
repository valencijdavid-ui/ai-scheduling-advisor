// PILOT-P0-3C-i — durabilita', postura di sicurezza e semantica di settle
// degli intenti di scrittura, su PostgreSQL vero.
//
// Un intento esiste per una ragione sola: essere ancora li' quando tutto il
// resto e' sparito. Le proprieta' sotto sono quelle che lo rendono capace di
// farlo, e nessuna di esse e' dimostrabile leggendo il DDL:
//
//   - sopravvive alla cancellazione dell'appuntamento
//   - sopravvive alla cancellazione del tenant
//   - non ha nessuna colonna capace di contenere PII del cliente
//   - last_error_code accetta codici e rifiuta prosa
//   - anon/authenticated non lo vedono e non possono eseguirne le primitive

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, postgresAvailable, type TestDatabase } from '../../helpers/postgres';
import { createPostgrestBridge, type PostgrestBridge } from '../../helpers/postgrest-bridge';
import {
  SupabaseCalendarWriteStore,
  type CalendarWriteRpcClient,
} from '@/server/appointments/calendar-write-intents';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

const PHONE = '393331112233';
const CALENDAR_ID = 'studio@example.com';

/**
 * Colonne che, se esistessero, farebbero di questa tabella un secondo posto
 * dove la PII del cliente sopravvive alla cancellazione — cioe' esattamente
 * l'opposto del suo scopo.
 */
const FORBIDDEN_COLUMN_PATTERNS = [
  /customer/i,
  /phone/i,
  /email/i,
  /name/i,
  /notes?/i,
  /service/i,
  /token/i,
  /credential/i,
  /payload/i,
  /body/i,
  /request/i,
  /response/i,
  /message/i,
  /transcript/i,
];

describePg('PILOT-P0-3C-i — intenti di scrittura durevoli', () => {
  let db: TestDatabase;
  let bridge: PostgrestBridge;

  beforeAll(() => {
    db = createTestDatabase();
    bridge = createPostgrestBridge(db);
  }, 120_000);

  afterAll(() => {
    db?.drop();
  });

  // -------------------------------------------------------------------------
  // Durabilita'
  // -------------------------------------------------------------------------

  it('creates a local-only appointment through the production store without an intent', async () => {
    const tenantId = randomUUID();
    const appointmentId = randomUUID();
    db.exec(`
      insert into public.tenants (id, name, slug, billing_email)
      values ('${tenantId}', 'Studio locale', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');
    `);

    const store = new SupabaseCalendarWriteStore(bridge.client as CalendarWriteRpcClient);
    const created = await store.createAppointmentWithIntent({
      id: appointmentId,
      tenantId,
      expectedProjectionEpoch: 0,
      conversationId: null,
      serviceId: null,
      serviceName: 'Prima visita',
      customerIdentifier: PHONE,
      customerName: 'Mario Rossi',
      customerPhone: PHONE,
      scheduledAt: new Date('2026-04-29T09:00:00.000Z'),
      durationMinutes: 30,
      notes: null,
      bookingSource: 'manual',
      calendarProvider: null,
      calendarSyncStatus: 'not_configured',
      calendarEventId: null,
      calendarSyncNextAttemptAt: null,
      target: null,
    });

    expect(created).toMatchObject({
      outcome: 'created',
      appointmentId,
      calendarSyncStatus: 'not_configured',
      calendarEventId: null,
      intentId: null,
    });
    expect(
      db.query(
        `select id from public.calendar_write_intents where appointment_ref = '${appointmentId}'`,
      ),
    ).toEqual([]);
  });

  it('survives the deletion of the appointment it refers to', () => {
    const seed = seedAppointmentWithIntent(db);

    db.exec(`delete from public.appointments where id = '${seed.appointmentId}';`);

    const intents = db.query<{ state: string; external_event_id: string; calendar_id: string }>(
      `select state, external_event_id, calendar_id from public.calendar_write_intents
        where appointment_ref = '${seed.appointmentId}'`,
    );

    // E' il caso per cui la tabella esiste: la riga locale si portava via
    // l'unico puntatore all'evento remoto, e adesso non piu'.
    expect(intents).toEqual([
      { state: 'in_flight', external_event_id: seed.eventId, calendar_id: CALENDAR_ID },
    ]);
  });

  it('survives the hard deletion of the tenant that generated it', () => {
    const seed = seedAppointmentWithIntent(db);

    // Ogni tabella tenant-scoped e' ON DELETE CASCADE: se qui esistesse una FK
    // verso `tenants`, l'evidenza sparirebbe nell'istante in cui l'autorita'
    // per cancellare l'evento remoto viene persa per sempre.
    db.exec(`delete from public.tenants where id = '${seed.tenantId}';`);

    expect(
      db.query(
        `select id from public.calendar_write_intents where tenant_ref = '${seed.tenantId}'`,
      ),
    ).toHaveLength(1);
  });

  it('declares no foreign key toward tenants or appointments', () => {
    const foreignKeys = db.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'public.calendar_write_intents'::regclass and contype = 'f'`,
    );

    expect(foreignKeys).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Superficie: nessun posto dove la PII possa entrare
  // -------------------------------------------------------------------------

  it('has no column capable of holding customer PII', () => {
    const columns = db
      .query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'calendar_write_intents'`,
      )
      .map((row) => row.column_name);

    expect(columns.length).toBeGreaterThan(0);

    const offending = columns.filter((column) =>
      FORBIDDEN_COLUMN_PATTERNS.some((pattern) => pattern.test(column)),
    );

    expect(offending).toEqual([]);
  });

  it('bounds last_error_code to a code and rejects provider prose', () => {
    const seed = seedAppointmentWithIntent(db);
    const update = (value: string): string =>
      db.trySql(
        `update public.calendar_write_intents set last_error_code = ${value}
          where appointment_ref = '${seed.appointmentId}'`,
      );

    // Codici: ammessi.
    expect(update(`'google_401'`)).toBe('OK');
    expect(update(`'timeout'`)).toBe('OK');
    expect(update(`'stale_desired_version'`)).toBe('OK');
    expect(update('null')).toBe('OK');

    // Prosa, corpi di risposta, telefoni: rifiutati dal database, non da una
    // convenzione applicativa che la prossima riga di codice puo' ignorare.
    expect(update(`'Google Calendar said: the event is gone'`)).toBe('23514');
    expect(update(`'{"error":{"message":"+39 333 111 2233"}}'`)).toBe('23514');
    expect(update(`'` + 'x'.repeat(65) + `'`)).toBe('23514');
    expect(update(`''`)).toBe('23514');
  });

  // -------------------------------------------------------------------------
  // Postura di sicurezza: service-role soltanto
  // -------------------------------------------------------------------------

  it('enables RLS and declares no tenant policy', () => {
    const rls = db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.calendar_write_intents'::regclass`,
    );
    expect(rls[0]?.relrowsecurity).toBe(true);

    // RLS attivo SENZA policy nega tutto a chi non bypassa: e' la postura,
    // non una dimenticanza.
    expect(
      db.query(`select policyname from pg_policies where tablename = 'calendar_write_intents'`),
    ).toEqual([]);
  });

  it('denies anon and authenticated any access to the intents table', () => {
    seedAppointmentWithIntent(db);

    for (const role of ['anon', 'authenticated']) {
      const read = db.execAs(role, 'select count(*) from public.calendar_write_intents;');
      expect(read.ok).toBe(false);
      expect(read.error).toMatch(/permission denied/i);
    }
  });

  it('denies anon and authenticated the execution of every write primitive', () => {
    const primitives = [
      `public.lock_tenant_projection_fence('${randomUUID()}'::uuid)`,
      `public.read_tenant_projection_epoch('${randomUUID()}'::uuid)`,
      `public.open_calendar_write_intent('${randomUUID()}'::uuid, '${randomUUID()}'::uuid, 0, 0, 'update', 'c', 'current_config', 'e')`,
      `public.cancel_appointment_guarded('${randomUUID()}'::uuid, '${randomUUID()}'::uuid, 0, 'pending', now())`,
      `public.reschedule_appointment_guarded('${randomUUID()}'::uuid, '${randomUUID()}'::uuid, 0, now(), 30, null, 'google_calendar', 'pending', now())`,
    ];

    for (const role of ['anon', 'authenticated']) {
      for (const call of primitives) {
        const attempt = db.execAs(role, `select ${call};`);
        expect(attempt.ok).toBe(false);
        expect(attempt.error).toMatch(/permission denied/i);
      }
    }
  });

  it('lets the service role open and settle an intent end to end', () => {
    const seed = seedAppointmentWithIntent(db);
    const asService = db.execAs(
      'service_role',
      `select public.settle_calendar_write(
         '${seed.tenantId}'::uuid, '${seed.appointmentId}'::uuid, 0, 1, 1,
         'synced', null, 0, null, now(),
         '${seed.eventId}', '${CALENDAR_ID}', null, false,
         '${seed.intentId}'::uuid, 'settled', null, 'write_confirmed');`,
    );

    expect(asService.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Ciclo di vita
  // -------------------------------------------------------------------------

  it('opens an intent in_flight and resolves it only through a settle', () => {
    const seed = seedAppointmentWithIntent(db);

    expect(intentRow(db, seed.intentId)).toMatchObject({
      state: 'in_flight',
      remote_evidence: 'none',
      settled_at: null,
      attempts: 0,
    });

    settle(db, { ...seed, intentState: 'settled', evidence: 'write_confirmed' });

    const resolved = intentRow(db, seed.intentId);
    expect(resolved.state).toBe('settled');
    expect(resolved.remote_evidence).toBe('write_confirmed');
    expect(resolved.settled_at).not.toBeNull();
    expect(resolved.attempts).toBe(1);
    expect(resolved.last_error_code).toBeNull();
  });

  it('keeps an unknown outcome distinguishable from a failure', () => {
    const seed = seedAppointmentWithIntent(db);

    settle(db, {
      ...seed,
      status: 'failed',
      intentState: 'unknown_outcome',
      errorCode: 'timeout',
      evidence: 'none',
    });

    const resolved = intentRow(db, seed.intentId);

    // "Abbiamo smesso di aspettare" non e' "Google non lo ha applicato".
    expect(resolved.state).toBe('unknown_outcome');
    expect(resolved.last_error_code).toBe('timeout');
  });

  it('leaves a crashed writer intent in_flight, never auto-expired to settled', () => {
    const seed = seedAppointmentWithIntent(db);

    // Il processo muore fra il commit dell'intento e il settle: nessuno
    // scrive niente. E' precisamente l'evidenza che C-ii raccogliera'.
    expect(intentRow(db, seed.intentId).state).toBe('in_flight');

    // Nessun automatismo la fa scadere: la tabella non ha default, trigger o
    // job che tocchino lo stato.
    const triggers = db.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'public.calendar_write_intents'::regclass and not tgisinternal`,
    );
    expect(triggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Seed = { tenantId: string; appointmentId: string; eventId: string; intentId: string };

function seedAppointmentWithIntent(db: TestDatabase): Seed {
  const tenantId = randomUUID();
  const appointmentId = randomUUID();
  const eventId = `apt${appointmentId.replace(/-/g, '')}`;

  db.exec(`
    insert into public.tenants (id, name, slug, billing_email)
    values ('${tenantId}', 'Studio Test', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', 'active', '{"calendar_id":"${CALENDAR_ID}"}'::jsonb);
  `);

  // Si usa la primitiva VERA, non un insert scritto a mano nel test: e' la
  // primitiva che deve garantire l'atomicita' fra riga e intento.
  const created = JSON.parse(
    db.scalar(`select public.create_appointment_with_calendar_intent(
      p_id := '${appointmentId}'::uuid,
      p_tenant_id := '${tenantId}'::uuid,
      p_expected_projection_epoch := 0,
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
      p_calendar_event_id := '${eventId}',
      p_calendar_sync_next_attempt_at := now(),
      p_calendar_target := '${CALENDAR_ID}',
      p_calendar_identity_source := 'current_config'
    )`) ?? '{}',
  ) as { outcome: string; intentId: string };

  if (created.outcome !== 'created') {
    throw new Error(`seed failed: ${created.outcome}`);
  }

  return { tenantId, appointmentId, eventId, intentId: created.intentId };
}

function settle(
  db: TestDatabase,
  input: Seed & {
    status?: string;
    intentState: string;
    errorCode?: string;
    evidence: string;
  },
): void {
  db.exec(`select public.settle_calendar_write(
    '${input.tenantId}'::uuid, '${input.appointmentId}'::uuid, 0, 1, 1,
    '${input.status ?? 'synced'}', null, 0, null, now(),
    '${input.eventId}', '${CALENDAR_ID}', null, false,
    '${input.intentId}'::uuid, '${input.intentState}',
    ${input.errorCode ? `'${input.errorCode}'` : 'null'}, '${input.evidence}');`);
}

function intentRow(db: TestDatabase, intentId: string): Record<string, unknown> {
  const rows = db.query<Record<string, unknown>>(
    `select state, remote_evidence, settled_at, attempts, last_error_code
       from public.calendar_write_intents where id = '${intentId}'`,
  );

  if (!rows[0]) {
    throw new Error(`intent ${intentId} not found`);
  }

  return rows[0];
}
