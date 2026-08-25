// PILOT-P0-3C — CARATTERIZZAZIONE. Corse fra i percorsi di scrittura e la
// cancellazione GDPR di un cliente.
//
// I test restano verdi affermando un comportamento SBAGLIATO. Sono la
// fotografia eseguibile di due esiti della matrice R1/R6 del report P0-3C:
//
//   C3 — la cancellazione prosegue verso Google anche quando l'UPDATE
//        autorevole non ha trovato nessuna riga;
//   C5 — una prenotazione gia' in volo puo' RIMATERIALIZZARE localmente e su
//        Google l'identita' di un cliente appena cancellato, senza che la
//        cancellazione abbia potuto catturarne il debito remoto.
//
// L'ordinamento e' deterministico: nessun thread, nessuna sleep, nessuna
// dipendenza dallo scheduler. La cancellazione viene fatta cadere in un punto
// preciso attraverso un innesto del repository FINTO — l'unico seam usato — e
// l'ordine dei passi del servizio resta quello di produzione.
//
// La meta' di C5 che riguarda la CATTURA del debito vive in
// `tests/server/gdpr/erasure-rematerialization.pg.test.ts`, su Postgres vero:
// e' li' che si dimostra che una cancellazione senza appuntamenti non produce
// nessuna obbligazione.

import { describe, expect, it, vi } from 'vitest';

import {
  AppointmentBookingService,
  type AppointmentBookingRepository,
  type AppointmentForChange,
  type AppointmentNotificationEnqueuer,
  type BookingServiceContext,
  type CalendarSyncStatus,
  type CreatedAppointment,
  type InsertAppointmentInput,
} from '@/server/appointments/booking';
import { deriveCalendarEventId } from '@/server/appointments/calendar-convergence';
import { GoogleCalendarProvider, type CalendarBusyInterval } from '@/server/calendar/google';
import { FakeGoogleCalendar } from '../../fixtures/fake-google-calendar';

const NOW = new Date('2026-04-27T07:00:00.000Z');
const SLOT_START = new Date('2026-04-27T09:00:00.000Z');
const APPOINTMENT_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const DERIVED_EVENT_ID = deriveCalendarEventId(APPOINTMENT_ID);
const ERASED_PHONE = '393331112233';

describe('PILOT-P0-3C — caratterizzazione delle corse prenotazione/erasure', () => {
  // -------------------------------------------------------------------------
  // C3 — la cancellazione a zero righe raggiunge comunque Google
  // -------------------------------------------------------------------------

  it('characterizes cancel reaching Google after its authoritative update matched no row', async () => {
    const repository = new RaceBookingRepository();
    const google = new FakeGoogleCalendar();

    repository.seed(confirmedAppointment());
    google.events.set(DERIVED_EVENT_ID, {
      id: DERIVED_EVENT_ID,
      status: 'confirmed',
      start: SLOT_START,
      end: new Date(SLOT_START.getTime() + 30 * 60_000),
      summary: 'Studio Ambrogio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });

    // La cancellazione GDPR committa fra la lettura dell'appuntamento e
    // l'UPDATE guardato: e' esattamente la finestra della matrice R1.
    repository.beforeCancelRecord = () => {
      repository.rows.delete(APPOINTMENT_ID);
    };

    // Le chiamate a Google entrano nello stesso registro delle scritture, cosi'
    // l'ORDINE fra database e rete e' verificabile e non solo dedotto.
    google.trace = repository.writeOrder;

    const service = new AppointmentBookingService(
      repository,
      google,
      new FakeNotificationEnqueuer(),
    );

    const result = await service.cancelAppointment({
      tenantId: 'tenant_1',
      appointmentId: APPOINTMENT_ID,
      now: NOW,
    });

    // L'UPDATE autorevole non ha trovato niente...
    expect(repository.cancelRecordAffectedRows).toBe(0);
    // ...e il servizio e' andato avanti fino a Google lo stesso.
    expect(google.deleteCount).toBe(1);
    expect(repository.writeOrder).toEqual(['cancel-record', 'google', 'settle']);

    // Il chiamante riceve un successo pieno per un'operazione che in Postgres
    // non ha toccato nessuna riga.
    expect(result.status).toBe('cancelled');
    expect(result.calendarSyncStatus).toBe('synced');

    // ZERO_ROW_CANCEL_PROCEEDS_TO_GOOGLE = TRUE
  });

  it('contrasts reschedule, which stops before Google when its guarded update matches no row', async () => {
    // Lo stesso innesto sul percorso di riprogrammazione produce l'esito
    // opposto: il difetto di C3 non e' inevitabile, e' non applicato.
    const repository = new RaceBookingRepository();
    const google = new FakeGoogleCalendar();

    repository.seed(confirmedAppointment());
    repository.beforeScheduleUpdate = () => {
      repository.rows.delete(APPOINTMENT_ID);
    };

    const service = new AppointmentBookingService(
      repository,
      google,
      new FakeNotificationEnqueuer(),
    );

    await expect(
      service.rescheduleAppointment({
        tenantId: 'tenant_1',
        appointmentId: APPOINTMENT_ID,
        scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(google.insertCount).toBe(0);
    expect(google.patchCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // C5 — rimaterializzazione di un cliente appena cancellato
  // -------------------------------------------------------------------------

  it('characterizes a booking in flight rematerializing an erased customer locally and on Google', async () => {
    const repository = new RaceBookingRepository();

    // Provider REALE con fetcher iniettato: serve a leggere il corpo che
    // parte davvero verso Google, non un riassunto costruito dal fake.
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('/freeBusy')) {
        return jsonResponse({ calendars: { 'studio@example.com': { busy: [] } } });
      }

      // La convergenza legge prima di scrivere: l'evento non esiste ancora,
      // quindi il ramo esercitato e' l'INSERT.
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

    // La richiesta di prenotazione ha gia' in memoria i dati del cliente.
    // La cancellazione committa mentre nessun appuntamento suo esiste ancora,
    // quindi non ha niente da cancellare e niente da catturare.
    let erasureCommitted = false;
    repository.beforeInsert = () => {
      erasureCommitted = true;
    };

    const service = new AppointmentBookingService(
      repository,
      provider,
      new FakeNotificationEnqueuer(),
    );

    const result = await service.createAppointment({
      tenantId: 'tenant_1',
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

    expect(erasureCommitted).toBe(true);

    // 1. Una riga locale NUOVA con l'identita' appena cancellata.
    const row = repository.rows.get(APPOINTMENT_ID);
    expect(row?.customerPhone).toBe(ERASED_PHONE);
    expect(row?.customerIdentifier).toBe(ERASED_PHONE);
    expect(row?.customerName).toBe('Mario Rossi');

    // 2. Quella stessa identita' e' partita verso Google, nel corpo della
    //    richiesta reale.
    expect(requests).toHaveLength(1);
    const sent = requests[0]?.body as {
      extendedProperties?: { private?: Record<string, unknown> };
    };
    expect(sent.extendedProperties?.private?.customerPhone).toBe(ERASED_PHONE);
    expect(result.calendarSyncStatus).toBe('synced');

    // 3. Nessuna obbligazione poteva nascere: al momento della cancellazione
    //    l'appuntamento non esisteva. La dimostrazione su Postgres vero sta in
    //    `erasure-rematerialization.pg.test.ts`.
    //
    // POST_ERASURE_REMATERIALIZATION_POSSIBLE = TRUE
  });

  it('characterizes the booking path never consulting any erasure or tenant-deletion state', async () => {
    // La ragione per cui la corsa sopra e' possibile: non c'e' nessun punto
    // in cui il percorso di scrittura chieda se questo cliente — o questo
    // tenant — sia stato cancellato. Il repository finto registra ogni metodo
    // invocato, e nessuno di essi riguarda la cancellazione.
    const repository = new RaceBookingRepository();
    const google = new FakeGoogleCalendar();
    const service = new AppointmentBookingService(
      repository,
      google,
      new FakeNotificationEnqueuer(),
    );

    await service.createAppointment({
      tenantId: 'tenant_1',
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

    // L'insieme dei metodi toccati e' esattamente questo: contesto,
    // disponibilita' locale, insert, settle.
    expect([...new Set(repository.methodsCalled)].sort()).toEqual([
      'getBookingContext',
      'insertAppointment',
      'listLocalBusyIntervals',
      'updateAppointmentCalendarSync',
    ]);
    // Nessuna lettura di stato di cancellazione, di fence o di finalizzazione:
    // non esiste il metodo, quindi non esiste la domanda.
    expect(repository.methodsCalled.join(' ')).not.toMatch(/eras|delet|fence|finaliz/i);
    // E nemmeno il CONTRATTO del repository ne prevede uno.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).join(' ')).not.toMatch(
      /eras|fence|finaliz/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Fake repository con innesti deterministici
// ---------------------------------------------------------------------------

type StoredAppointment = AppointmentForChange & {
  calendarSyncAttempts: number;
  calendarSyncNextAttemptAt: Date | null;
};

/**
 * Riproduce la semantica del repository Supabase VERA, inclusi i silenzi.
 *
 * `cancelAppointmentRecord` filtra su `status = 'confirmed'` e NON controlla
 * le righe toccate, esattamente come `SupabaseAppointmentBookingRepository`.
 * Quella fedelta' non e' assunta qui: e' dimostrata su Postgres reale in
 * `calendar-settle-concurrency.pg.test.ts`.
 */
class RaceBookingRepository implements AppointmentBookingRepository {
  readonly context: BookingServiceContext;
  readonly rows = new Map<string, StoredAppointment>();
  readonly writeOrder: string[] = [];
  readonly methodsCalled: string[] = [];

  /** Righe toccate dall'ultimo `cancelAppointmentRecord`. */
  cancelRecordAffectedRows = 0;

  beforeInsert: (() => void) | null = null;
  beforeCancelRecord: (() => void) | null = null;
  beforeScheduleUpdate: (() => void) | null = null;

  constructor() {
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
    this.rows.set(appointment.id, {
      ...appointment,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: null,
    });
  }

  async getBookingContext(): Promise<BookingServiceContext | null> {
    this.methodsCalled.push('getBookingContext');
    return this.context;
  }

  async listLocalBusyIntervals(): Promise<CalendarBusyInterval[]> {
    this.methodsCalled.push('listLocalBusyIntervals');
    return [];
  }

  async insertAppointment(input: InsertAppointmentInput): Promise<CreatedAppointment> {
    this.methodsCalled.push('insertAppointment');
    this.beforeInsert?.();
    this.writeOrder.push('insert');

    this.rows.set(input.id, {
      id: input.id,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      customerIdentifier: input.customerIdentifier,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      status: 'confirmed',
      calendarProvider: input.calendarProvider,
      calendarSyncStatus: input.calendarSyncStatus,
      calendarEventId: input.calendarEventId,
      calendarEventHtmlLink: null,
      notes: input.notes,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: input.calendarSyncNextAttemptAt,
    });

    return {
      id: input.id,
      tenantId: input.tenantId,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      calendarSyncStatus: input.calendarSyncStatus,
      calendarEventId: input.calendarEventId,
      calendarEventHtmlLink: null,
    };
  }

  async updateAppointmentCalendarSync(input: {
    appointmentId: string;
    status: CalendarSyncStatus;
    eventId?: string;
  }): Promise<void> {
    this.methodsCalled.push('updateAppointmentCalendarSync');
    this.writeOrder.push('settle');

    const existing = this.rows.get(input.appointmentId);

    // Zero righe: silenzio, come il SQL reale.
    if (!existing) {
      return;
    }

    this.rows.set(input.appointmentId, {
      ...existing,
      calendarSyncStatus: input.status,
      ...(input.eventId !== undefined ? { calendarEventId: input.eventId } : {}),
    });
  }

  async updateGoogleCalendarAccessToken(): Promise<void> {}

  async markGoogleAvailabilityError(): Promise<void> {}

  async clearGoogleAvailabilityError(): Promise<void> {}

  async getAppointmentForChange(input: {
    appointmentId: string;
  }): Promise<AppointmentForChange | null> {
    this.methodsCalled.push('getAppointmentForChange');
    return this.rows.get(input.appointmentId) ?? null;
  }

  async updateAppointmentSchedule(input: {
    appointmentId: string;
    scheduledAt: Date;
    durationMinutes: number;
    notes: string | null;
    calendarSyncStatus: CalendarSyncStatus;
    calendarSyncNextAttemptAt: Date | null;
  }): Promise<void> {
    this.methodsCalled.push('updateAppointmentSchedule');
    this.beforeScheduleUpdate?.();
    this.writeOrder.push('schedule');

    const existing = this.rows.get(input.appointmentId);

    // `.eq('status','confirmed').select('id')` + controllo su zero righe.
    if (!existing || existing.status !== 'confirmed') {
      const { AppError } = await import('@/lib/errors/app-error');
      throw new AppError('conflict', 'Appointment is no longer confirmed', { expose: false });
    }

    this.rows.set(input.appointmentId, {
      ...existing,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      notes: input.notes,
      calendarSyncStatus: input.calendarSyncStatus,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: input.calendarSyncNextAttemptAt,
    });
  }

  async cancelAppointmentRecord(input: {
    appointmentId: string;
    calendarSyncStatus: CalendarSyncStatus;
    calendarSyncNextAttemptAt: Date | null;
  }): Promise<void> {
    this.methodsCalled.push('cancelAppointmentRecord');
    this.beforeCancelRecord?.();
    this.writeOrder.push('cancel-record');

    const existing = this.rows.get(input.appointmentId);
    const matches = existing !== undefined && existing.status === 'confirmed';

    this.cancelRecordAffectedRows = matches ? 1 : 0;

    // Nessun controllo sulle righe toccate, nessun errore: il SQL reale non
    // chiama `.select()` e non puo' accorgersi di aver mancato il bersaglio.
    if (!matches || !existing) {
      return;
    }

    this.rows.set(input.appointmentId, {
      ...existing,
      status: 'cancelled',
      calendarSyncStatus: input.calendarSyncStatus,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: input.calendarSyncNextAttemptAt,
    });
  }
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
    calendarEventHtmlLink: null,
    notes: null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
