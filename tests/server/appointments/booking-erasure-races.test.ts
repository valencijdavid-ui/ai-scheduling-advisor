// PILOT-P0-3C-i — REGRESSIONE. Corse fra i percorsi di scrittura e la
// cancellazione GDPR di un cliente.
//
// Questo file nasce in P0-3C come CARATTERIZZAZIONE: le stesse scene di adesso
// restavano verdi AFFERMANDO due comportamenti sbagliati della matrice R1/R6:
//
//   C3 — la cancellazione proseguiva verso Google anche quando l'UPDATE
//        autorevole non aveva trovato nessuna riga;
//   C5 — una prenotazione gia' in volo poteva RIMATERIALIZZARE localmente e su
//        Google l'identita' di un cliente appena cancellato.
//
// C-i chiude entrambi. Le scene e gli innesti restano identici — stessa
// finestra, stesso punto di caduta — e cambiano solo le asserzioni: da "il
// difetto e' qui" a "il difetto non puo' piu' accadere".
//
// L'ordinamento resta deterministico: nessun thread, nessuna sleep, nessuna
// dipendenza dallo scheduler. La cancellazione viene fatta cadere in un punto
// preciso attraverso un innesto della primitiva di scrittura FINTA — l'unico
// seam usato — e l'ordine dei passi del servizio resta quello di produzione.
//
// La meta' di C5 che riguarda la CATTURA del debito vive in
// `tests/server/gdpr/erasure-rematerialization.pg.test.ts`, su Postgres vero.

import { describe, expect, it, vi } from 'vitest';

import {
  AppointmentBookingService,
  type AppointmentBookingRepository,
  type AppointmentForChange,
  type AppointmentNotificationEnqueuer,
  type BookingServiceContext,
} from '@/server/appointments/booking';
import { deriveCalendarEventId } from '@/server/appointments/calendar-convergence';
import { GoogleCalendarProvider, type CalendarBusyInterval } from '@/server/calendar/google';
import { FakeGoogleCalendar } from '../../fixtures/fake-google-calendar';
import {
  FakeCalendarWriteStore,
  type FakeStoredAppointment,
} from '../../fixtures/fake-calendar-write-store';

const NOW = new Date('2026-04-27T07:00:00.000Z');
const SLOT_START = new Date('2026-04-27T09:00:00.000Z');
const APPOINTMENT_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const DERIVED_EVENT_ID = deriveCalendarEventId(APPOINTMENT_ID);
const ERASED_PHONE = '393331112233';

/** Epoca osservata dal turno che sta prenotando. */
const TURN_EPOCH = 4;

describe('PILOT-P0-3C-i — corse prenotazione/erasure', () => {
  // -------------------------------------------------------------------------
  // C3 — la cancellazione a zero righe non raggiunge Google
  // -------------------------------------------------------------------------

  it('stops before Google when the authoritative cancel matched no row', async () => {
    const repository = new RaceBookingRepository();
    const google = new FakeGoogleCalendar();

    repository.seed(confirmedAppointment());
    google.events.set(DERIVED_EVENT_ID, {
      id: DERIVED_EVENT_ID,
      calendarId: 'primary',
      status: 'confirmed',
      start: SLOT_START,
      end: new Date(SLOT_START.getTime() + 30 * 60_000),
      summary: 'Studio Ambrogio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });

    // La cancellazione GDPR committa fra la lettura dell'appuntamento e
    // l'UPDATE guardato: e' esattamente la finestra della matrice R1.
    repository.writes.beforeCancel = async () => {
      repository.writes.rows.delete(APPOINTMENT_ID);
    };

    // Le chiamate a Google entrano nello stesso registro delle scritture, cosi'
    // l'ORDINE fra database e rete e' verificabile e non solo dedotto.
    google.trace = repository.writeOrder;

    const service = new AppointmentBookingService(
      repository,
      google,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    // L'annullamento autorevole non e' avvenuto, e il chiamante lo sa.
    await expect(
      service.cancelAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: TURN_EPOCH,
        appointmentId: APPOINTMENT_ID,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // LA PROPRIETA'. Zero mutazioni remote: senza autorita' sulla riga non c'e'
    // autorita' sull'evento.
    expect(google.deleteCount).toBe(0);
    expect(repository.writeOrder).toEqual(['cancel_not_confirmed']);

    // E nessun intento e' stato aperto: non esisteva niente da autorizzare.
    expect(repository.writes.intents).toHaveLength(0);
  });

  it('stops reschedule before Google too, when its guarded update matches no row', async () => {
    const repository = new RaceBookingRepository();
    const google = new FakeGoogleCalendar();

    repository.seed(confirmedAppointment());
    repository.writes.beforeReschedule = async () => {
      repository.writes.rows.delete(APPOINTMENT_ID);
    };

    const service = new AppointmentBookingService(
      repository,
      google,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await expect(
      service.rescheduleAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: TURN_EPOCH,
        appointmentId: APPOINTMENT_ID,
        scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(google.insertCount).toBe(0);
    expect(google.patchCount).toBe(0);
    expect(repository.writes.intents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // C5 — nessuna rimaterializzazione di un cliente appena cancellato
  // -------------------------------------------------------------------------

  it('refuses a booking in flight when the erasure advanced the projection epoch', async () => {
    const repository = new RaceBookingRepository();

    // Provider REALE con fetcher iniettato: serve a osservare se qualcosa
    // parte davvero verso Google, non un riassunto costruito dal fake.
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('/freeBusy')) {
        return jsonResponse({ calendars: { 'studio@example.com': { busy: [] } } });
      }

      if (method === 'GET') {
        return new Response(null, { status: 404 });
      }

      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });

      return jsonResponse({
        id: DERIVED_EVENT_ID,
        htmlLink: 'https://calendar.google.com/event?eid=x',
      });
    });
    const provider = new GoogleCalendarProvider({ fetcher });

    // La richiesta di prenotazione ha gia' in memoria i dati del cliente e ha
    // catturato la sua epoca all'inizio del turno. La cancellazione committa
    // DOPO quella cattura: l'epoca avanza, e l'autorita' sotto cui il turno
    // era partito non esiste piu'.
    let erasureCommitted = false;
    repository.writes.beforeCreate = () => {
      erasureCommitted = true;
      repository.writes.projectionEpoch = TURN_EPOCH + 1;
    };

    const service = new AppointmentBookingService(
      repository,
      provider,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await expect(
      service.createAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: TURN_EPOCH,
        serviceId: 'service_1',
        appointmentId: APPOINTMENT_ID,
        customerIdentifier: ERASED_PHONE,
        customerName: 'Mario Rossi',
        customerPhone: ERASED_PHONE,
        scheduledAt: SLOT_START,
        durationMinutes: 30,
        now: NOW,
        requireCalendarSync: false,
        sendConfirmation: false,
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: 'stale_projection_epoch' });

    expect(erasureCommitted).toBe(true);

    // 1. Nessuna riga locale con l'identita' appena cancellata.
    expect(repository.writes.rows.get(APPOINTMENT_ID)).toBeUndefined();

    // 2. Niente e' partito verso Google: nessuna richiesta di mutazione, e
    //    quindi nessun posto nuovo dove il telefono del cliente possa vivere.
    expect(requests).toEqual([]);

    // 3. Nessun intento: la transazione che avrebbe dovuto crearlo non ha
    //    superato il fence, quindi non ha lasciato niente dietro di se'.
    expect(repository.writes.intents).toEqual([]);
  });

  it('lets the booking through when the projection authority did not change', async () => {
    // Il controllo positivo della scena sopra: senza cancellazione concorrente
    // la stessa prenotazione arriva fino in fondo. Senza questo, il test
    // precedente sarebbe verde anche se il percorso fosse rotto per sempre.
    const repository = new RaceBookingRepository();
    const google = new FakeGoogleCalendar([], 'studio@example.com');

    const service = new AppointmentBookingService(
      repository,
      google,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const result = await service.createAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: TURN_EPOCH,
      serviceId: 'service_1',
      appointmentId: APPOINTMENT_ID,
      customerIdentifier: ERASED_PHONE,
      customerName: 'Mario Rossi',
      customerPhone: ERASED_PHONE,
      scheduledAt: SLOT_START,
      durationMinutes: 30,
      now: NOW,
      requireCalendarSync: false,
      sendConfirmation: false,
    });

    expect(result.calendarSyncStatus).toBe('synced');
    expect(google.insertCount).toBe(1);
    expect(repository.writes.rows.get(APPOINTMENT_ID)?.customerPhone).toBe(ERASED_PHONE);
  });

  it('routes the booking path through the projection fence, with the intent before Google', async () => {
    // La ragione per cui la corsa non e' piu' possibile: adesso ESISTE un punto
    // in cui il percorso di scrittura chiede sotto quale autorita' sta
    // scrivendo, e lo chiede sotto lock, dentro la stessa transazione
    // dell'insert.
    const repository = new RaceBookingRepository();
    const google = new FakeGoogleCalendar([], 'studio@example.com');

    google.trace = repository.writeOrder;

    const service = new AppointmentBookingService(
      repository,
      google,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await service.createAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: TURN_EPOCH,
      serviceId: 'service_1',
      appointmentId: APPOINTMENT_ID,
      customerIdentifier: ERASED_PHONE,
      customerName: 'Mario Rossi',
      customerPhone: ERASED_PHONE,
      scheduledAt: SLOT_START,
      durationMinutes: 30,
      now: NOW,
      requireCalendarSync: false,
      sendConfirmation: false,
    });

    // Il repository non ha piu' NESSUNA scrittura autorevole: legge contesto e
    // disponibilita' e basta.
    expect([...new Set(repository.methodsCalled)].sort()).toEqual([
      'getBookingContext',
      'listLocalBusyIntervals',
    ]);

    // L'epoca catturata dal turno e' arrivata fino alla primitiva, senza essere
    // riletta per strada.
    expect(repository.writes.createInputs[0]?.expectedProjectionEpoch).toBe(TURN_EPOCH);

    // E l'intento durevole precede la rete.
    expect(repository.writeOrder).toEqual(['insert', 'google', 'settle_settled_current']);
    expect(repository.writes.intents[0]).toMatchObject({
      operation: 'create',
      state: 'settled',
    });
  });
});

// ---------------------------------------------------------------------------
// Fake repository di sole LETTURE
// ---------------------------------------------------------------------------

/**
 * Dopo C-i questo repository non scrive piu' niente.
 *
 * Le quattro scritture autorevoli che aveva — insert, schedule, cancel e
 * settle — sono state rimosse dal port: erano le porte da cui si poteva mutare
 * lo stato senza fence, senza versione desiderata e senza sapere quante righe
 * si toccavano. Restano solo le letture, e le scritture vivono in
 * `FakeCalendarWriteStore`.
 */
class RaceBookingRepository implements AppointmentBookingRepository {
  readonly context: BookingServiceContext;
  readonly writeOrder: string[] = [];
  readonly methodsCalled: string[] = [];
  readonly writes: FakeCalendarWriteStore;

  constructor() {
    this.writes = new FakeCalendarWriteStore(new Map(), this.writeOrder);
    this.writes.projectionEpoch = TURN_EPOCH;
    this.context = {
      tenantId: 'tenant_1',
      timezone: 'UTC',
      studioName: 'Studio Ambrogio',
      address: 'Via Roma 1',
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
        config: { calendar_id: 'studio@example.com' },
      },
    };
  }

  seed(appointment: AppointmentForChange): void {
    this.writes.rows.set(appointment.id, {
      ...appointment,
      calendarSyncError: null,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: null,
      calendarSyncLastAttemptAt: null,
      desiredVersion: 0,
      writeGeneration: 0,
    } satisfies FakeStoredAppointment);
  }

  async getBookingContext(): Promise<BookingServiceContext | null> {
    this.methodsCalled.push('getBookingContext');
    return this.context;
  }

  async listLocalBusyIntervals(): Promise<CalendarBusyInterval[]> {
    this.methodsCalled.push('listLocalBusyIntervals');
    return [];
  }

  async getAppointmentForChange(input: {
    appointmentId: string;
  }): Promise<AppointmentForChange | null> {
    this.methodsCalled.push('getAppointmentForChange');
    return this.writes.rows.get(input.appointmentId) ?? null;
  }

  async updateGoogleCalendarAccessToken(): Promise<void> {}

  async markGoogleAvailabilityError(): Promise<void> {}

  async clearGoogleAvailabilityError(): Promise<void> {}
}

class FakeNotificationEnqueuer implements AppointmentNotificationEnqueuer {
  async enqueueNotification(): Promise<{ queued: boolean }> {
    return { queued: true };
  }
}

function confirmedAppointment(): AppointmentForChange {
  return {
    id: APPOINTMENT_ID,
    tenantId: 'tenant_1',
    conversationId: null,
    serviceId: 'service_1',
    serviceName: 'Prima visita',
    customerIdentifier: ERASED_PHONE,
    customerName: 'Mario Rossi',
    customerPhone: ERASED_PHONE,
    scheduledAt: SLOT_START,
    durationMinutes: 30,
    status: 'confirmed',
    calendarProvider: 'google_calendar',
    calendarSyncStatus: 'synced',
    calendarEventId: DERIVED_EVENT_ID,
    calendarEventCalendarId: null,
    calendarEventHtmlLink: 'https://calendar.google.com/event?eid=x',
    notes: null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
