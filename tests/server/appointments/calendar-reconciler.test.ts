import { describe, expect, it } from 'vitest';

import {
  CALENDAR_SYNC_LEASE_MS,
  CALENDAR_SYNC_MAX_ATTEMPTS,
  CALENDAR_SYNC_TICK_MS,
  deriveCalendarEventId,
} from '@/server/appointments/calendar-convergence';
import {
  CalendarSyncReconciler,
  type CalendarReconcilerRepository,
  type DueCalendarSync,
  type TenantCalendarContext,
} from '@/server/appointments/calendar-reconciler';
import type { CalendarSyncStatus } from '@/server/appointments/booking';
import { FakeGoogleCalendar, googleError } from '../../fixtures/fake-google-calendar';

const APPOINTMENT_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const EVENT_ID = deriveCalendarEventId(APPOINTMENT_ID);
const now = new Date('2026-04-27T07:00:00.000Z');

describe('CalendarSyncReconciler', () => {
  it('converges a row whose inline sync never reached Google', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    const google = new FakeGoogleCalendar();
    const reconciler = new CalendarSyncReconciler(repository, google);

    const result = await reconciler.processDueSyncs({ now });

    expect(result).toMatchObject({ candidates: 1, claimed: 1, synced: 1, terminal: 0 });
    expect(google.insertCount).toBe(1);
    expect(repository.state(APPOINTMENT_ID)).toMatchObject({
      status: 'synced',
      eventId: EVENT_ID,
      nextAttemptAt: null,
      error: null,
    });
  });

  // Il caso ambiguo per eccellenza: l'evento esiste gia' perche' il tentativo
  // in linea lo aveva creato prima di perdere la risposta.
  it('does not create a second event when the remote one already exists', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow({ attempts: 1 }));
    const google = new FakeGoogleCalendar();
    google.events.set(EVENT_ID, {
      id: EVENT_ID,
      status: 'confirmed',
      start: new Date('2026-05-27T09:00:00.000Z'),
      end: new Date('2026-05-27T09:30:00.000Z'),
      summary: 'Studio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });
    const reconciler = new CalendarSyncReconciler(repository, google);

    await reconciler.processDueSyncs({ now });

    expect(google.insertCount).toBe(0);
    expect(google.activeEvents()).toHaveLength(1);
    expect(repository.state(APPOINTMENT_ID)?.status).toBe('synced');
  });

  it('deletes the Google event for a cancelled appointment', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow({ status: 'cancelled' }));
    const google = new FakeGoogleCalendar();
    google.events.set(EVENT_ID, {
      id: EVENT_ID,
      status: 'confirmed',
      start: new Date('2026-05-27T09:00:00.000Z'),
      end: new Date('2026-05-27T09:30:00.000Z'),
      summary: 'Studio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });
    const reconciler = new CalendarSyncReconciler(repository, google);

    await reconciler.processDueSyncs({ now });

    // Senza questo, l'evento fantasma continuerebbe a occupare lo slot nel
    // calcolo della disponibilita' letto da freeBusy.
    expect(google.activeEvents()).toHaveLength(0);
    expect(repository.state(APPOINTMENT_ID)?.status).toBe('synced');
  });

  it('lets exactly one of two concurrent workers claim a row', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    const google = new FakeGoogleCalendar();
    const first = new CalendarSyncReconciler(repository, google);
    const second = new CalendarSyncReconciler(repository, google);

    // Entrambi leggono la stessa riga prima che l'altro la rivendichi.
    const [a, b] = await Promise.all([
      first.processDueSyncs({ now }),
      second.processDueSyncs({ now }),
    ]);

    expect((a?.claimed ?? 0) + (b?.claimed ?? 0)).toBe(1);
    expect((a?.skipped ?? 0) + (b?.skipped ?? 0)).toBe(1);
    expect(google.insertCount).toBe(1);
  });

  it('makes a crashed claim retryable once the lease expires', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    const google = new FakeGoogleCalendar();
    const reconciler = new CalendarSyncReconciler(repository, google);

    // Il worker rivendica e poi muore: nessuna scrittura di esito.
    const claimed = await repository.claimCalendarSync({
      tenantId: 'tenant_1',
      appointmentId: APPOINTMENT_ID,
      observedAttempts: 0,
      leaseUntil: new Date(now.getTime() + CALENDAR_SYNC_LEASE_MS),
      lastAttemptAt: now,
    });
    expect(claimed).toBe(true);

    // Dentro il lease la riga non e' eleggibile.
    const during = await reconciler.processDueSyncs({ now });
    expect(during.candidates).toBe(0);

    // Scaduto il lease torna da sola nel giro: nessun processo di sblocco.
    const after = await reconciler.processDueSyncs({
      now: new Date(now.getTime() + CALENDAR_SYNC_LEASE_MS + 1000),
    });
    expect(after.synced).toBe(1);
  });

  it('walks a persistently failing row to terminal and then stops picking it up', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    const google = new FakeGoogleCalendar();
    google.getError = googleError(503, 'Service Unavailable');
    const reconciler = new CalendarSyncReconciler(repository, google);

    let clock = now;
    for (let round = 0; round < CALENDAR_SYNC_MAX_ATTEMPTS + 2; round += 1) {
      await reconciler.processDueSyncs({ now: clock });
      // Oltre il tetto del backoff (un'ora), cosi' ogni giro trova la riga
      // di nuovo dovuta.
      clock = new Date(clock.getTime() + 70 * 60_000);
    }

    const state = repository.state(APPOINTMENT_ID);
    expect(state?.status).toBe('failed');
    expect(state?.attempts).toBe(CALENDAR_SYNC_MAX_ATTEMPTS);
    // La colonna resta valorizzata: la terminalita' e' il predicato, non il NULL.
    expect(state?.nextAttemptAt).not.toBeNull();

    const afterTerminal = await reconciler.processDueSyncs({ now: clock });
    expect(afterTerminal.candidates).toBe(0);
  });

  it('terminates immediately when Google rejects the credentials', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    const google = new FakeGoogleCalendar();
    google.getError = googleError(401, 'Invalid Credentials');
    const reconciler = new CalendarSyncReconciler(repository, google);

    const result = await reconciler.processDueSyncs({ now });

    // Ritentare credenziali revocate ritarda solo l'unica cosa che risolve.
    expect(result.terminal).toBe(1);
    expect(repository.state(APPOINTMENT_ID)?.attempts).toBe(CALENDAR_SYNC_MAX_ATTEMPTS);
  });

  it('gives a 403 the normal retry budget instead of declaring it terminal', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    const google = new FakeGoogleCalendar();
    // Google restituisce 403 anche per `rateLimitExceeded`: un limite di
    // frequenza non deve consumare in un colpo solo tutto il budget e
    // chiamare un operatore.
    google.getError = googleError(403, 'Rate Limit Exceeded');
    const reconciler = new CalendarSyncReconciler(repository, google);

    const result = await reconciler.processDueSyncs({ now });

    expect(result.retried).toBe(1);
    expect(result.terminal).toBe(0);

    const state = repository.state(APPOINTMENT_ID);
    expect(state?.attempts).toBe(1);
    expect(state?.attempts).toBeLessThan(CALENDAR_SYNC_MAX_ATTEMPTS);
    expect(state?.nextAttemptAt).not.toBeNull();
    // Backoff normale: un tick dopo il tentativo, non un salto al termine.
    expect(state?.nextAttemptAt?.getTime()).toBe(now.getTime() + CALENDAR_SYNC_TICK_MS);
  });

  it('recovers on its own once a 403 rate limit clears', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    const google = new FakeGoogleCalendar();
    google.getError = googleError(403, 'Rate Limit Exceeded');
    const reconciler = new CalendarSyncReconciler(repository, google);

    await reconciler.processDueSyncs({ now });

    google.getError = null;
    const after = await reconciler.processDueSyncs({
      now: new Date(now.getTime() + CALENDAR_SYNC_TICK_MS),
    });

    expect(after.synced).toBe(1);
    expect(repository.state(APPOINTMENT_ID)?.status).toBe('synced');
    expect(google.activeEvents()).toHaveLength(1);
  });

  it('treats a disconnected integration as an ordinary retryable failure', async () => {
    const repository = new FakeReconcilerRepository();
    repository.seed(dueRow());
    repository.context = { ...repository.context, integration: null };
    const reconciler = new CalendarSyncReconciler(repository, new FakeGoogleCalendar());

    const result = await reconciler.processDueSyncs({ now });

    // Una disconnessione breve si ripara da sola entro il budget di tentativi;
    // una definitiva diventa terminale e quindi visibile all'operatore.
    expect(result.retried).toBe(1);
    expect(repository.state(APPOINTMENT_ID)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('ignores rows the scanner predicate excludes', async () => {
    const repository = new FakeReconcilerRepository();
    // Riga storica senza identita': mai riconciliata in automatico.
    repository.seed(dueRow(), { withoutIdentity: true });
    // Riga gia' terminale.
    repository.seed(dueRow({ appointmentId: 'other', attempts: CALENDAR_SYNC_MAX_ATTEMPTS }));
    const google = new FakeGoogleCalendar();
    const reconciler = new CalendarSyncReconciler(repository, google);

    const result = await reconciler.processDueSyncs({ now });

    expect(result.candidates).toBe(0);
    expect(google.insertCount).toBe(0);
  });
});

type ReconcilerState = {
  row: DueCalendarSync;
  status: CalendarSyncStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  eventId: string | null;
  error: string | null;
};

/**
 * Repository in memoria che riproduce il predicato dello scanner e la
 * semantica del confronto-e-scrittura sul contatore dei tentativi.
 *
 * La rivendicazione e' l'unica cosa che impedisce a due worker sovrapposti di
 * lavorare la stessa riga, quindi va verificata sulla sua meccanica reale e
 * non su una simulazione compiacente.
 */
class FakeReconcilerRepository implements CalendarReconcilerRepository {
  readonly states = new Map<string, ReconcilerState>();
  context: TenantCalendarContext = {
    timezone: 'Europe/Rome',
    studioName: 'Studio Ambrogio',
    address: 'Via Roma 1',
    integration: {
      id: 'integration_1',
      tenantId: 'tenant_1',
      externalAccountId: null,
      credentials: { access_token: 'access_1' },
      config: { calendar_id: 'primary' },
    },
  };

  /**
   * `withoutIdentity` riproduce la riga storica il cui `calendar_event_id` era
   * stato azzerato da un fallimento: lo scanner deve saltarla.
   */
  seed(row: DueCalendarSync, options: { withoutIdentity?: boolean } = {}): void {
    this.states.set(row.appointmentId, {
      row,
      status: 'pending',
      attempts: row.attempts,
      nextAttemptAt: now,
      eventId: options.withoutIdentity ? null : row.calendarEventId,
      error: null,
    });
  }

  state(appointmentId: string): ReconcilerState | undefined {
    return this.states.get(appointmentId);
  }

  async listDueCalendarSyncs(input: { now: Date; limit: number }): Promise<DueCalendarSync[]> {
    return [...this.states.values()]
      .filter(
        (state) =>
          (state.status === 'pending' || state.status === 'failed') &&
          state.eventId !== null &&
          state.nextAttemptAt !== null &&
          state.nextAttemptAt.getTime() <= input.now.getTime() &&
          state.attempts < CALENDAR_SYNC_MAX_ATTEMPTS &&
          state.row.scheduledAt.getTime() > input.now.getTime(),
      )
      .slice(0, input.limit)
      .map((state) => ({ ...state.row, attempts: state.attempts }));
  }

  async getTenantCalendarContext(): Promise<TenantCalendarContext | null> {
    return this.context;
  }

  async claimCalendarSync(input: {
    tenantId: string;
    appointmentId: string;
    observedAttempts: number;
    leaseUntil: Date;
    lastAttemptAt: Date;
  }): Promise<boolean> {
    const state = this.states.get(input.appointmentId);

    if (!state || state.attempts !== input.observedAttempts) {
      return false;
    }

    this.states.set(input.appointmentId, {
      ...state,
      attempts: state.attempts + 1,
      nextAttemptAt: input.leaseUntil,
    });

    return true;
  }

  async updateAppointmentCalendarSync(input: {
    tenantId: string;
    appointmentId: string;
    status: CalendarSyncStatus;
    eventId?: string;
    htmlLink?: string | null;
    errorMessage: string | null;
    attempts: number;
    nextAttemptAt: Date | null;
    lastAttemptAt: Date;
  }): Promise<void> {
    const state = this.states.get(input.appointmentId);

    if (!state) {
      return;
    }

    this.states.set(input.appointmentId, {
      ...state,
      status: input.status,
      attempts: input.attempts,
      nextAttemptAt: input.nextAttemptAt,
      error: input.errorMessage,
      ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    });
  }
}

function dueRow(overrides: Partial<DueCalendarSync> = {}): DueCalendarSync {
  return {
    tenantId: 'tenant_1',
    appointmentId: APPOINTMENT_ID,
    calendarEventId: EVENT_ID,
    status: 'confirmed',
    scheduledAt: new Date('2026-05-27T09:00:00.000Z'),
    durationMinutes: 30,
    serviceName: 'Prima visita',
    customerName: 'Mario Rossi',
    customerPhone: '393331112233',
    notes: null,
    attempts: 0,
    ...overrides,
  };
}
