// PILOT-P0-3C-i — semantica dell'esito remoto attraverso lo SCRITTORE VERO.
//
// Le proprieta' qui non sono del provider isolato: sono di cio' che il
// servizio di booking REGISTRA quando la rete si comporta in un certo modo.
// Per questo il trasporto e' finto ma il percorso e' quello di produzione —
// `AppointmentBookingService` → `convergeCalendarEvent` →
// `GoogleCalendarProvider` → settle unificato.
//
// La distinzione portante:
//
//   Google ha risposto con uno status   -> nessuna mutazione ha avuto effetto
//   timeout / guasto di trasporto       -> ESITO IGNOTO, puo' essere arrivata
//
// Collassare i due significherebbe, nel caso ambiguo, archiviare come "non
// fatto" una mutazione che potrebbe essere avvenuta — e quindi non tornarci
// piu' sopra.

import { describe, expect, it, vi } from 'vitest';

import {
  AppointmentBookingService,
  type AppointmentBookingRepository,
  type AppointmentForChange,
  type AppointmentNotificationEnqueuer,
  type BookingServiceContext,
} from '@/server/appointments/booking';
import { GoogleCalendarProvider, type CalendarBusyInterval } from '@/server/calendar/google';
import { deriveCalendarEventId } from '@/server/appointments/calendar-convergence';
import { FakeCalendarWriteStore } from '../../fixtures/fake-calendar-write-store';

const NOW = new Date('2026-04-27T07:00:00.000Z');
const SLOT_START = new Date('2026-04-27T09:00:00.000Z');
/** Orario NUOVO di una riprogrammazione: rende l'evento remoto divergente. */
const RESCHEDULED_SLOT = new Date('2026-04-27T10:00:00.000Z');
const APPOINTMENT_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const EVENT_ID = deriveCalendarEventId(APPOINTMENT_ID);
const CALENDAR_ID = 'studio@example.com';

describe('PILOT-P0-3C-i — esito remoto registrato dallo scrittore', () => {
  it('records unknown_outcome when the mutation may have been transmitted', async () => {
    // Il POST parte e non torna: la richiesta puo' essere arrivata a Google ed
    // essere stata eseguita. Nessuno lo sa, e l'unica affermazione onesta e'
    // che nessuno lo sa.
    const harness = createHarness(async (input, init) => {
      const method = init?.method ?? 'GET';

      if (String(input).includes('/freeBusy')) {
        return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
      }

      if (method === 'GET') {
        return new Response(null, { status: 404 });
      }

      throw new TypeError('fetch failed');
    });

    await expect(harness.book()).rejects.toBeTruthy();

    const intent = harness.writes.intents.at(-1);

    expect(intent?.state).toBe('unknown_outcome');
    // Non `no_remote_mutation`: quello direbbe che la mutazione non e' partita.
    expect(intent?.state).not.toBe('no_remote_mutation');
    // E non un successo pulito.
    expect(harness.writes.row(APPOINTMENT_ID)?.calendarSyncStatus).toBe('failed');
  });

  it('records no_remote_mutation when Google REJECTED the mutation with a 4xx', async () => {
    // Il contrasto. Un 4xx prova che Google ha VALUTATO la richiesta e l'ha
    // respinta: non ha applicato niente, e quel fatto e' conosciuto.
    // Archiviarlo come ignoto sprecherebbe l'unica informazione utile che
    // abbiamo, e manderebbe un giorno lo spazzino di C-ii a cercare un evento
    // che non e' mai nato.
    const harness = createHarness(async (input, init) => {
      const method = init?.method ?? 'GET';

      if (String(input).includes('/freeBusy')) {
        return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
      }

      if (method === 'GET') {
        return new Response(null, { status: 404 });
      }

      return jsonResponse({ error: { code: 400 } }, 400);
    });

    await expect(harness.book()).rejects.toBeTruthy();

    const intent = harness.writes.intents.at(-1);

    expect(intent?.state).toBe('no_remote_mutation');
    expect(intent?.errorCode).toBe('google_http_400');
  });

  // -------------------------------------------------------------------------
  // 5xx SU UNA MUTAZIONE — trasmessa, esito non dimostrato
  // -------------------------------------------------------------------------
  //
  // Un 5xx non e' un rifiuto: e' Google che ha RICEVUTO la richiesta e ha
  // fallito nel raccontare come e' finita. Un 500 su una POST non dimostra che
  // l'evento non sia stato creato — puo' essere esploso dopo averlo scritto — e
  // archiviarlo come "nessuna mutazione" butterebbe via l'unica traccia di un
  // evento che potrebbe esistere davvero, con dentro il telefono del cliente.
  //
  // Le tre mutazioni hanno tre percorsi diversi (insert, patch, delete) e
  // vanno provate separatamente: la classificazione vive sul singolo sito che
  // costruisce l'errore, non su un ramo comune.

  it('records unknown_outcome when an insert answers 500, without a second POST', async () => {
    const mutations: string[] = [];
    const harness = createHarness(async (input, init) => {
      const method = init?.method ?? 'GET';

      if (String(input).includes('/freeBusy')) {
        return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
      }

      if (method === 'GET') {
        return new Response(null, { status: 404 });
      }

      mutations.push(method);

      return jsonResponse({ error: { code: 500 } }, 500);
    });

    await expect(harness.book()).rejects.toBeTruthy();

    const intent = harness.writes.intents.at(-1);

    expect(intent?.state).toBe('unknown_outcome');
    expect(intent?.state).not.toBe('no_remote_mutation');
    expect(intent?.errorCode).toBe('google_http_500');
    // Ignoto non vuol dire rispedito: il ritentativo appartiene al livello
    // dell'intento durevole, mai al livello HTTP.
    expect(mutations).toEqual(['POST']);
  });

  it('records unknown_outcome when a patch answers 503, without a second PATCH', async () => {
    const mutations: string[] = [];
    const harness = createHarness(
      async (input, init) => {
        const method = init?.method ?? 'GET';

        if (String(input).includes('/freeBusy')) {
          return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
        }

        // L'evento esiste ma e' all'orario VECCHIO: e' cio' che rende la
        // convergenza divergente e fa partire la PATCH.
        if (method === 'GET') {
          return jsonResponse({
            id: EVENT_ID,
            status: 'confirmed',
            start: { dateTime: SLOT_START.toISOString() },
            end: { dateTime: new Date(SLOT_START.getTime() + 30 * 60_000).toISOString() },
          });
        }

        mutations.push(method);

        return jsonResponse({ error: { code: 503 } }, 503);
      },
      { seedAppointment: true },
    );

    await harness.reschedule();

    const intent = harness.writes.intents.at(-1);

    expect(intent?.operation).toBe('update');
    expect(intent?.state).toBe('unknown_outcome');
    expect(intent?.errorCode).toBe('google_http_503');
    expect(mutations).toEqual(['PATCH']);
  });

  it('records unknown_outcome when a delete answers 500, without a second DELETE', async () => {
    const mutations: string[] = [];
    const harness = createHarness(
      async (input, init) => {
        const method = init?.method ?? 'GET';

        if (String(input).includes('/freeBusy')) {
          return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
        }

        mutations.push(method);

        return jsonResponse({ error: { code: 500 } }, 500);
      },
      { seedAppointment: true },
    );

    // L'annullamento autorevole e' gia' committato: il guasto di Google non lo
    // annulla, resta un debito di proiezione. Ma il debito deve dire la verita'.
    await harness.cancel();

    const intent = harness.writes.intents.at(-1);

    expect(intent?.operation).toBe('delete');
    expect(intent?.state).toBe('unknown_outcome');
    expect(intent?.errorCode).toBe('google_http_500');
    expect(mutations).toEqual(['DELETE']);
  });

  it('never retries a mutation at the HTTP layer', async () => {
    // Un ritentativo automatico su POST e' un secondo tentativo fatto senza
    // sapere se il primo e' arrivato. Il ritentativo appartiene al livello
    // dell'intento durevole, dove esiste una traccia di cosa era stato chiesto.
    const mutations: string[] = [];
    const harness = createHarness(async (input, init) => {
      const method = init?.method ?? 'GET';

      if (String(input).includes('/freeBusy')) {
        return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
      }

      if (method === 'GET') {
        return new Response(null, { status: 404 });
      }

      mutations.push(method);
      throw new TypeError('fetch failed');
    });

    await expect(harness.book()).rejects.toBeTruthy();

    expect(mutations).toEqual(['POST']);
  });

  it('settles the intent explicitly when the event was already correct', async () => {
    // Il no-op. La GET dimostra che la proiezione remota coincide gia' con lo
    // stato desiderato, quindi nessuna mutazione parte. L'intento NON puo'
    // restare `in_flight`: sarebbe evidenza di un debito che non esiste, e il
    // sweep di C-ii andrebbe a cercare qualcosa di gia' a posto.
    const mutations: string[] = [];
    const harness = createHarness(async (input, init) => {
      const method = init?.method ?? 'GET';

      if (String(input).includes('/freeBusy')) {
        return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
      }

      if (method === 'GET') {
        return jsonResponse({
          id: EVENT_ID,
          status: 'confirmed',
          htmlLink: 'https://calendar.google.com/event?eid=x',
          start: { dateTime: SLOT_START.toISOString() },
          end: { dateTime: new Date(SLOT_START.getTime() + 30 * 60_000).toISOString() },
        });
      }

      mutations.push(method);

      return jsonResponse({ id: EVENT_ID });
    });

    const result = await harness.book();

    expect(mutations).toEqual([]);
    expect(result.calendarSyncStatus).toBe('synced');

    const intent = harness.writes.intents.at(-1);

    expect(intent?.state).toBe('settled');
    // La prova e' un'OSSERVAZIONE, non una scrittura confermata.
    expect(intent?.evidence).toBe('event_observed');
    expect(harness.writes.unresolvedIntents()).toEqual([]);
  });

  it('writes provenance only from positive evidence', async () => {
    const harness = createHarness(async (input, init) => {
      const method = init?.method ?? 'GET';

      if (String(input).includes('/freeBusy')) {
        return jsonResponse({ calendars: { [CALENDAR_ID]: { busy: [] } } });
      }

      if (method === 'GET') {
        return new Response(null, { status: 404 });
      }

      return jsonResponse({ id: EVENT_ID, htmlLink: 'https://calendar.google.com/event?eid=x' });
    });

    await harness.book();

    // L'INSERT e' riuscito su questo calendario: adesso sappiamo dove vive.
    expect(harness.writes.row(APPOINTMENT_ID)?.calendarEventCalendarId).toBe(CALENDAR_ID);
    expect(harness.writes.intents.at(-1)?.evidence).toBe('write_confirmed');
  });
});

// ---------------------------------------------------------------------------
// Harness: percorso di produzione, trasporto finto
// ---------------------------------------------------------------------------

function createHarness(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: { seedAppointment?: boolean } = {},
) {
  const seeded = options.seedAppointment ?? false;
  const writes = new FakeCalendarWriteStore();

  // Riprogrammazione e annullamento agiscono su una riga che ESISTE gia': la
  // primitiva guardata deve trovarla `confirmed`, altrimenti l'esito sarebbe
  // `not_confirmed` e non si arriverebbe mai alla rete — che e' precisamente
  // cio' che questi test devono osservare.
  if (seeded) {
    writes.rows.set(APPOINTMENT_ID, {
      id: APPOINTMENT_ID,
      tenantId: 'tenant_1',
      conversationId: null,
      serviceId: 'service_1',
      serviceName: 'Prima visita',
      customerIdentifier: '393331112233',
      customerName: 'Mario Rossi',
      customerPhone: '393331112233',
      scheduledAt: SLOT_START,
      durationMinutes: 30,
      status: 'confirmed',
      calendarProvider: 'google_calendar',
      calendarSyncStatus: 'synced',
      calendarEventId: EVENT_ID,
      calendarEventCalendarId: CALENDAR_ID,
      calendarEventHtmlLink: null,
      notes: null,
      calendarSyncError: null,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: null,
      calendarSyncLastAttemptAt: null,
      desiredVersion: 0,
      writeGeneration: 1,
    });
  }

  const repository = new ReadOnlyBookingRepository(seeded);
  const service = new AppointmentBookingService(
    repository,
    new GoogleCalendarProvider({ fetcher: vi.fn(fetcher) }),
    new NoopNotifications(),
    writes,
  );

  return {
    writes,
    book: () =>
      service.createAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        serviceId: 'service_1',
        appointmentId: APPOINTMENT_ID,
        customerIdentifier: '393331112233',
        customerName: 'Mario Rossi',
        customerPhone: '393331112233',
        scheduledAt: SLOT_START,
        durationMinutes: 30,
        now: NOW,
        sendConfirmation: false,
      }),
    reschedule: () =>
      service.rescheduleAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        appointmentId: APPOINTMENT_ID,
        scheduledAt: RESCHEDULED_SLOT,
        durationMinutes: 30,
        now: NOW,
        // Il guasto di Google non e' l'esito dell'operazione: qui interessa
        // cosa viene REGISTRATO, non come viene raccontato al chiamante.
        requireCalendarSync: false,
        sendConfirmation: false,
      }),
    cancel: () =>
      service.cancelAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        appointmentId: APPOINTMENT_ID,
        now: NOW,
        sendCancellation: false,
      }),
  };
}

class ReadOnlyBookingRepository implements AppointmentBookingRepository {
  constructor(private readonly seeded: boolean = false) {}

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
      googleAvailabilityErrorCode: null,
      googleCalendarIntegration: {
        id: 'integration_1',
        tenantId: 'tenant_1',
        externalAccountId: null,
        credentials: { access_token: 'access_1' },
        config: { calendar_id: CALENDAR_ID },
      },
    };
  }

  async listLocalBusyIntervals(): Promise<CalendarBusyInterval[]> {
    return [];
  }

  async getAppointmentForChange(): Promise<AppointmentForChange | null> {
    if (!this.seeded) {
      return null;
    }

    return {
      id: APPOINTMENT_ID,
      tenantId: 'tenant_1',
      conversationId: null,
      serviceId: 'service_1',
      serviceName: 'Prima visita',
      customerIdentifier: '393331112233',
      customerName: 'Mario Rossi',
      customerPhone: '393331112233',
      scheduledAt: SLOT_START,
      durationMinutes: 30,
      status: 'confirmed',
      calendarProvider: 'google_calendar',
      calendarSyncStatus: 'synced',
      calendarEventId: EVENT_ID,
      // Provenienza VERIFICATA: PATCH e DELETE devono raggiungere il
      // calendario su cui l'evento vive davvero.
      calendarEventCalendarId: CALENDAR_ID,
      calendarEventHtmlLink: null,
      notes: null,
    };
  }

  async updateGoogleCalendarAccessToken(): Promise<void> {}

  async markGoogleAvailabilityError(): Promise<void> {}

  async clearGoogleAvailabilityError(): Promise<void> {}
}

class NoopNotifications implements AppointmentNotificationEnqueuer {
  async enqueueNotification(): Promise<{ queued: boolean }> {
    return { queued: false };
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
