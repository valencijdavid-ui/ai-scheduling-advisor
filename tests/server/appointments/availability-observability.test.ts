// PILOT-P0-2 — un evento di log stabile per ogni guasto tipizzato.
//
// I guasti passeggeri non mandano una mail per occorrenza: l'unica traccia che
// resta e' questa riga. Se il nome dell'evento cambiasse a ogni percorso, o se
// dentro ci finissero il cliente o il corpo grezzo di Google, la riga sarebbe
// contemporaneamente inutile da cercare e rischiosa da conservare.

import { FakeCalendarWriteStore } from '../../fixtures/fake-calendar-write-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logging/logger';
import {
  AppointmentBookingService,
  type AppointmentBookingRepository,
  type AppointmentNotificationEnqueuer,
  type BookingServiceContext,
} from '@/server/appointments/booking';
import { CalendarAvailabilityUnavailable } from '@/server/calendar/availability-error';
import { FakeGoogleCalendar } from '../../fixtures/fake-google-calendar';

const CUSTOMER_PHONE = '393331112233';
const CUSTOMER_NAME = 'Mario Rossi';

type LoggedEvent = { fields: Record<string, unknown>; message: unknown };

describe('availability failure observability (PILOT-P0-2)', () => {
  const logged: LoggedEvent[] = [];
  let errorSpy: { mockRestore: () => void };

  beforeEach(() => {
    logged.length = 0;
    errorSpy = vi
      .spyOn(logger, 'error')
      .mockImplementation((fields: unknown, message?: unknown): void => {
        logged.push({
          fields: (fields ?? {}) as Record<string, unknown>,
          message,
        });
      });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('emits one stable event carrying the operator-useful fields', async () => {
    const calendar = new FakeGoogleCalendar();
    calendar.listBusyError = new CalendarAvailabilityUnavailable(
      'Google Calendar freeBusy failed (503)',
      { kind: 'transient', httpStatus: 503, reason: 'freebusy_http_503' },
    );

    await expect(availability(calendar)).rejects.toBeInstanceOf(CalendarAvailabilityUnavailable);

    const events = availabilityEvents(logged);

    expect(events).toHaveLength(1);
    expect(events[0]?.fields).toMatchObject({
      tenantId: 'tenant_1',
      integrationId: 'integration_1',
      kind: 'transient',
      httpStatus: 503,
    });
  });

  it('logs neither customer identity nor the raw Google body or credentials', async () => {
    const calendar = new FakeGoogleCalendar();
    calendar.listBusyError = new CalendarAvailabilityUnavailable(
      'Google Calendar refresh token is no longer valid',
      {
        kind: 'auth',
        reason: 'invalid_grant',
        // Il vettore realistico: il corpo grezzo attaccato alla `cause`.
        cause: { body: { error: 'invalid_grant' }, refresh_token: 'refresh_secret' },
      },
    );

    await expect(availability(calendar)).rejects.toBeInstanceOf(CalendarAvailabilityUnavailable);

    const events = availabilityEvents(logged);
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain(CUSTOMER_PHONE);
    expect(serialized).not.toContain(CUSTOMER_NAME);
    expect(serialized).not.toContain('refresh_secret');
    // La `cause` — dove viaggiano corpo grezzo e credenziali — non entra
    // nell'evento. `reason` invece SI': e' la nostra classificazione stabile,
    // ed e' l'unica cosa che dice all'operatore cosa e' successo.
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain('"cause"');
    expect(serialized).not.toContain('"err"');
    expect(events[0]?.fields).toMatchObject({ reason: 'invalid_grant' });
  });
});

function availabilityEvents(events: LoggedEvent[]): LoggedEvent[] {
  return events.filter((event) => event.message === 'calendar_availability_unavailable');
}

function availability(calendar: FakeGoogleCalendar) {
  const service = new AppointmentBookingService(
    new StubBookingRepository(),
    calendar,
    new StubNotificationEnqueuer(),
    // Questi test riguardano solo la LETTURA di disponibilita': nessuna
    // scrittura autorevole viene esercitata qui.
    new FakeCalendarWriteStore(),
  );

  return service.getAvailableSlots({
    tenantId: 'tenant_1',
    serviceId: 'service_1',
    from: new Date('2026-04-27T09:00:00.000Z'),
    to: new Date('2026-04-27T12:00:00.000Z'),
    now: new Date('2026-04-27T07:00:00.000Z'),
  });
}

/** Repository minimo: qui interessa solo il percorso di lettura Google. */
class StubBookingRepository implements AppointmentBookingRepository {
  async getBookingContext(): Promise<BookingServiceContext> {
    return {
      tenantId: 'tenant_1',
      timezone: 'UTC',
      studioName: 'Studio Ambrogio',
      address: null,
      bookingMinLeadMinutes: 0,
      bookingSlotStepMinutes: 30,
      bookingBufferMinutes: 0,
      bookingMaxDaysAhead: 30,
      service: { id: 'service_1', name: 'Prima visita', durationMinutes: 30, active: true },
      businessHours: [{ weekday: 1, opensAt: '09:00:00', closesAt: '12:00:00' }],
      googleCalendarIntegration: {
        id: 'integration_1',
        tenantId: 'tenant_1',
        externalAccountId: null,
        credentials: { access_token: 'access_1' },
        config: { calendar_id: 'primary' },
      },
      googleAvailabilityErrorCode: null,
    };
  }

  async listLocalBusyIntervals() {
    return [];
  }

  async updateGoogleCalendarAccessToken(): Promise<void> {}

  async markGoogleAvailabilityError(): Promise<void> {}

  async clearGoogleAvailabilityError(): Promise<void> {}

  async getAppointmentForChange() {
    return null;
  }
}

class StubNotificationEnqueuer implements AppointmentNotificationEnqueuer {
  async enqueueNotification() {
    return { queued: false };
  }
}
