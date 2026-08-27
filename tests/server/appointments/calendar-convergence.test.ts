import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors/app-error';
import {
  CALENDAR_SYNC_MAX_ATTEMPTS,
  CALENDAR_SYNC_TICK_MS,
  calculateCalendarSyncNextAttemptAt,
  convergeCalendarEvent,
  deriveCalendarEventId,
  isNonRetryableCalendarError,
  type CalendarConvergenceTarget,
} from '@/server/appointments/calendar-convergence';
import type { GoogleCalendarIntegration } from '@/server/calendar/google';
import { FakeGoogleCalendar, googleError } from '../../fixtures/fake-google-calendar';

const APPOINTMENT_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const EVENT_ID = 'apt3f2a1b4c5d6e4f708a91b2c3d4e5f607';

const integration: GoogleCalendarIntegration = {
  id: 'integration_1',
  tenantId: 'tenant_1',
  externalAccountId: null,
  credentials: { access_token: 'access_1' },
  config: { calendar_id: 'primary' },
};

describe('deriveCalendarEventId', () => {
  it('produces a stable id inside the base32hex alphabet Google requires', () => {
    const first = deriveCalendarEventId(APPOINTMENT_ID);
    const second = deriveCalendarEventId(APPOINTMENT_ID.toUpperCase());

    expect(first).toBe(EVENT_ID);
    expect(second).toBe(first);
    // Google ammette solo i caratteri base32hex (0-9, a-v), lunghezza 5-1024.
    expect(first).toMatch(/^[0-9a-v]+$/);
    expect(first.length).toBeGreaterThanOrEqual(5);
    expect(first.length).toBeLessThanOrEqual(1024);
  });

  it('refuses to invent an identity for a non-UUID appointment id', () => {
    expect(() => deriveCalendarEventId('appointment_1')).toThrow(AppError);
  });
});

describe('calculateCalendarSyncNextAttemptAt', () => {
  it('backs off in whole cron ticks and caps out', () => {
    const now = new Date('2026-04-27T09:00:00.000Z');
    const delays = [1, 2, 3, 4, 5].map(
      (attempt) => calculateCalendarSyncNextAttemptAt(now, attempt).getTime() - now.getTime(),
    );

    expect(delays).toEqual([
      CALENDAR_SYNC_TICK_MS,
      CALENDAR_SYNC_TICK_MS * 2,
      CALENDAR_SYNC_TICK_MS * 4,
      CALENDAR_SYNC_TICK_MS * 8,
      CALENDAR_SYNC_TICK_MS * 12,
    ]);
    // Sempre valorizzato, anche a tentativi esauriti: la terminalita' e' un
    // predicato su stato e contatore, mai l'assenza della colonna.
    expect(
      calculateCalendarSyncNextAttemptAt(now, CALENDAR_SYNC_MAX_ATTEMPTS).getTime(),
    ).toBeGreaterThan(now.getTime());
  });
});

describe('isNonRetryableCalendarError', () => {
  it('stops retrying on invalid credentials and rejected payloads', () => {
    expect(isNonRetryableCalendarError(googleError(401, 'Invalid Credentials'))).toBe(true);
    expect(isNonRetryableCalendarError(googleError(400, 'Bad Request'))).toBe(true);
  });

  it('keeps retrying on transient failures', () => {
    expect(isNonRetryableCalendarError(googleError(500, 'Backend Error'))).toBe(false);
    expect(isNonRetryableCalendarError(googleError(429, 'Rate Limit Exceeded'))).toBe(false);
    expect(isNonRetryableCalendarError(new Error('socket hang up'))).toBe(false);
  });

  // Google usa 403 anche per `rateLimitExceeded` e `userRateLimitExceeded`,
  // che sono temporanei per definizione. Trattarlo come definitivo
  // trasformerebbe un limite di frequenza nello stato che richiede un
  // intervento umano.
  it('keeps retrying on 403, which Google also uses for rate limits', () => {
    expect(isNonRetryableCalendarError(googleError(403, 'Rate Limit Exceeded'))).toBe(false);
    expect(isNonRetryableCalendarError(googleError(403, 'Forbidden'))).toBe(false);
  });
});

describe('convergeCalendarEvent', () => {
  it('inserts with the stored id when the event is absent', async () => {
    const google = new FakeGoogleCalendar();

    const result = await convergeCalendarEvent({
      provider: google,
      integration,
      target: target(),
    });

    expect(result.action).toBe('inserted');
    expect(result.eventId).toBe(EVENT_ID);
    expect(google.insertCount).toBe(1);
    expect(google.events.get(EVENT_ID)?.start).toEqual(new Date('2026-04-27T09:00:00.000Z'));
  });

  it('does nothing when the remote event already matches', async () => {
    const google = new FakeGoogleCalendar();
    await convergeCalendarEvent({ provider: google, integration, target: target() });

    const result = await convergeCalendarEvent({ provider: google, integration, target: target() });

    expect(result.action).toBe('unchanged');
    expect(google.insertCount).toBe(1);
    expect(google.patchCount).toBe(0);
  });

  it('patches the remote event toward Postgres when the time diverges', async () => {
    const google = new FakeGoogleCalendar();
    await convergeCalendarEvent({ provider: google, integration, target: target() });

    const moved = target({
      start: new Date('2026-04-27T15:00:00.000Z'),
      end: new Date('2026-04-27T15:30:00.000Z'),
    });
    const result = await convergeCalendarEvent({ provider: google, integration, target: moved });

    expect(result.action).toBe('patched');
    expect(google.insertCount).toBe(1);
    expect(google.events.get(EVENT_ID)?.start).toEqual(new Date('2026-04-27T15:00:00.000Z'));
  });

  it('revives an event an operator deleted by hand instead of marking it synced', async () => {
    const google = new FakeGoogleCalendar();
    google.events.set(EVENT_ID, {
      id: EVENT_ID,
      calendarId: 'primary',
      status: 'cancelled',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      summary: 'Studio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });

    const result = await convergeCalendarEvent({ provider: google, integration, target: target() });

    expect(result.action).toBe('patched');
    expect(google.events.get(EVENT_ID)?.status).toBe('confirmed');
  });

  // Il caso che giustifica l'ordine GET-first. Google documenta che il
  // rilevamento delle collisioni di id "non e' garantito al momento della
  // creazione": un disegno che si affida al 409 per non duplicare poggia su
  // una garanzia che il fornitore non da'.
  it('converges without a second event when a previous insert succeeded but its response was lost', async () => {
    const google = new FakeGoogleCalendar();
    google.createThenFail = googleError(504, 'Gateway Timeout');

    await expect(
      convergeCalendarEvent({ provider: google, integration, target: target() }),
    ).rejects.toMatchObject({ code: 'upstream_error' });

    expect(google.insertCount).toBe(1);

    google.createThenFail = null;
    const retry = await convergeCalendarEvent({ provider: google, integration, target: target() });

    expect(retry.action).toBe('unchanged');
    expect(google.insertCount).toBe(1);
    expect(google.activeEvents()).toHaveLength(1);
  });

  it('recovers from a 409 raced between the read and the insert', async () => {
    const google = new FakeGoogleCalendar();
    // L'evento non e' visibile alla GET ma esiste alla POST: e' la corsa che
    // il 409 intercetta.
    let firstRead = true;
    const racing = {
      ...google,
      getEvent: async (input: { eventId: string }) => {
        if (firstRead) {
          firstRead = false;
          return null;
        }
        return google.getEvent(input);
      },
      createEvent: google.createEvent.bind(google),
      updateEvent: google.updateEvent.bind(google),
      cancelEvent: google.cancelEvent.bind(google),
    };
    google.events.set(EVENT_ID, {
      id: EVENT_ID,
      calendarId: 'primary',
      status: 'confirmed',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      summary: 'Studio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });

    const result = await convergeCalendarEvent({
      provider: racing,
      integration,
      target: target(),
    });

    expect(result.action).toBe('unchanged');
    expect(google.insertCount).toBe(0);
    expect(google.activeEvents()).toHaveLength(1);
  });

  it('deletes the event for a cancelled appointment and calls the second pass absent', async () => {
    const google = new FakeGoogleCalendar();
    await convergeCalendarEvent({ provider: google, integration, target: target() });

    const cancelled = target({ status: 'cancelled' });
    const first = await convergeCalendarEvent({
      provider: google,
      integration,
      target: cancelled,
    });
    const second = await convergeCalendarEvent({
      provider: google,
      integration,
      target: cancelled,
    });

    // La prima passata cancella un evento che c'era. La seconda non cancella
    // niente: e' idempotente, ma non e' lo STESSO fatto, e chiamarlo `deleted`
    // significherebbe registrare una cancellazione mai avvenuta.
    expect(first.action).toBe('deleted');
    expect(first.calendarIdVerified).toBe(true);

    expect(second.action).toBe('already_absent');
    // Un'assenza non promuove il calendario contattato a provenienza: da qui
    // non si distingue "non esiste" da "non e' su QUESTO calendario".
    expect(second.calendarIdVerified).toBe(false);

    expect(google.activeEvents()).toHaveLength(0);
  });

  it('propagates a transient read failure instead of creating a duplicate', async () => {
    const google = new FakeGoogleCalendar();
    google.getError = googleError(503, 'Service Unavailable');

    await expect(
      convergeCalendarEvent({ provider: google, integration, target: target() }),
    ).rejects.toMatchObject({ code: 'upstream_error' });

    expect(google.insertCount).toBe(0);
  });
});

function target(overrides: Partial<CalendarConvergenceTarget> = {}): CalendarConvergenceTarget {
  return {
    tenantId: 'tenant_1',
    appointmentId: APPOINTMENT_ID,
    eventId: EVENT_ID,
    status: 'confirmed',
    start: new Date('2026-04-27T09:00:00.000Z'),
    end: new Date('2026-04-27T09:30:00.000Z'),
    timezone: 'Europe/Rome',
    summary: 'Studio: Prima visita - Mario Rossi',
    description: 'Prenotazione creata da Ambrogio.ai',
    customerName: 'Mario Rossi',
    customerPhone: '393331112233',
    ...overrides,
  };
}
