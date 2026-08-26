import { describe, expect, it } from 'vitest';

import {
  AppointmentBookingService,
  LEGACY_MISSING_EVENT_ID_ERROR,
  type AppointmentBookingRepository,
  type AppointmentForChange,
  type AppointmentNotificationEnqueuer,
  type AppointmentStatus,
  type BookingServiceContext,
  type CalendarSyncStatus,
} from '@/server/appointments/booking';
import { AppError } from '@/lib/errors/app-error';
import {
  CalendarAvailabilityUnavailable,
  isCalendarAvailabilityUnavailable,
} from '@/server/calendar/availability-error';
import { deriveCalendarEventId } from '@/server/appointments/calendar-convergence';
import type { CalendarBusyInterval } from '@/server/calendar/google';
import { FakeGoogleCalendar, googleError } from '../../fixtures/fake-google-calendar';
import {
  FakeCalendarWriteStore,
  type FakeStoredAppointment,
} from '../../fixtures/fake-calendar-write-store';

const now = new Date('2026-04-27T07:00:00.000Z');

const APPOINTMENT_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const DERIVED_EVENT_ID = deriveCalendarEventId(APPOINTMENT_ID);
/** Id come lo generava Google prima dell'identita' derivata. */
const LEGACY_EVENT_ID = '6p1q8rs9tuv0abcd1234567890';

describe('AppointmentBookingService', () => {
  it('returns business-hour slots excluding local and Google busy intervals', async () => {
    const repository = new FakeBookingRepository();
    repository.localBusy = [busy('2026-04-27T09:30:00.000Z', '2026-04-27T10:00:00.000Z')];
    const calendar = new FakeGoogleCalendar([
      busy('2026-04-27T10:30:00.000Z', '2026-04-27T11:00:00.000Z'),
    ]);
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const slots = await service.getAvailableSlots({
      tenantId: 'tenant_1',
      serviceId: 'service_1',
      from: new Date('2026-04-27T09:00:00.000Z'),
      to: new Date('2026-04-27T12:00:00.000Z'),
      now,
      maxSlots: 10,
      slotStepMinutes: 30,
    });

    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-04-27T09:00:00.000Z',
      '2026-04-27T10:00:00.000Z',
      '2026-04-27T11:00:00.000Z',
      '2026-04-27T11:30:00.000Z',
    ]);
  });

  it('creates an appointment, syncs Google Calendar and queues confirmation', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    const notifications = new FakeNotificationEnqueuer();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      notifications,
      repository.writes,
    );

    const result = await service.createAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      serviceId: 'service_1',
      appointmentId: APPOINTMENT_ID,
      customerIdentifier: '393331112233',
      customerName: 'Mario Rossi',
      scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
      now,
    });

    expect(result).toMatchObject({
      appointmentId: APPOINTMENT_ID,
      calendarSyncStatus: 'synced',
      calendarEventId: DERIVED_EVENT_ID,
      confirmationQueued: true,
    });
    expect(calendar.insertCount).toBe(1);
    expect(repository.row(APPOINTMENT_ID)).toMatchObject({
      calendarSyncStatus: 'synced',
      calendarEventId: DERIVED_EVENT_ID,
      calendarSyncNextAttemptAt: null,
      calendarSyncError: null,
    });
  });

  // Il vincolo di esclusione in Postgres resta l'unica cosa che impedisce due
  // impegni sovrapposti, e non dipende da Google in nessun modo.
  it('rejects a conflicting slot before any row is written', async () => {
    const repository = new FakeBookingRepository();
    repository.localBusy = [busy('2026-04-27T09:00:00.000Z', '2026-04-27T09:30:00.000Z')];
    const service = new AppointmentBookingService(
      repository,
      new FakeGoogleCalendar(),
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await expect(
      service.createAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        serviceId: 'service_1',
        customerIdentifier: '393331112233',
        customerName: 'Mario Rossi',
        scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
        now,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Requested appointment slot is unavailable',
    });
    expect(repository.insertedAppointments).toHaveLength(0);
  });

  it('persists the appointment and its calendar identity before calling Google', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    // Google e' giu' prima ancora della lettura: nessuna chiamata puo'
    // riuscire, quindi cio' che resta e' esattamente cio' che l'insert ha
    // scritto.
    calendar.getError = googleError(503, 'Service Unavailable');
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const result = await service.createAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      serviceId: 'service_1',
      appointmentId: APPOINTMENT_ID,
      customerIdentifier: '393331112233',
      customerName: 'Mario Rossi',
      scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
      requireCalendarSync: false,
      now,
    });

    expect(result.calendarSyncStatus).toBe('failed');
    // La prenotazione sopravvive al guasto: e' la garanzia che il cliente ha
    // ricevuto quando gli e' stato detto che l'appuntamento era preso.
    expect(repository.row(APPOINTMENT_ID)).toBeTruthy();

    const inserted = repository.insertedAppointments[0];
    expect(inserted).toMatchObject({
      calendarSyncStatus: 'pending',
      calendarEventId: DERIVED_EVENT_ID,
    });
    // L'identita' e lo stato di recupero sono nello STESSO insert: se il
    // processo muore qui, lo scanner trova comunque la riga.
    expect(inserted?.calendarSyncNextAttemptAt).toEqual(now);
    expect(calendar.insertCount).toBe(0);
  });

  it('never clears the stored calendar event id when a sync attempt fails', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    // L'evento viene creato davvero su Google e la risposta si perde: e' il
    // caso che prima azzerava il puntatore e rendeva inevitabile il duplicato.
    calendar.createThenFail = googleError(504, 'Gateway Timeout');

    await service.createAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      serviceId: 'service_1',
      appointmentId: APPOINTMENT_ID,
      customerIdentifier: '393331112233',
      customerName: 'Mario Rossi',
      scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
      requireCalendarSync: false,
      now,
    });

    const row = repository.row(APPOINTMENT_ID);
    expect(row).toMatchObject({
      calendarSyncStatus: 'failed',
      calendarEventId: DERIVED_EVENT_ID,
    });
    expect(row?.calendarSyncAttempts).toBe(1);
    // Ogni transizione verso pending/failed lascia una riga recuperabile.
    expect(row?.calendarSyncNextAttemptAt).not.toBeNull();
    expect(calendar.insertCount).toBe(1);
  });

  it('still throws for callers that require calendar sync', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    calendar.getError = googleError(500, 'Backend Error');
    const notifications = new FakeNotificationEnqueuer();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      notifications,
      repository.writes,
    );

    await expect(
      service.createAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        serviceId: 'service_1',
        appointmentId: APPOINTMENT_ID,
        customerIdentifier: '393331112233',
        customerName: 'Mario Rossi',
        scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
        now,
      }),
    ).rejects.toMatchObject({ code: 'upstream_error' });

    expect(notifications.calls).toHaveLength(0);
    // Anche qui la riga resta, e resta riconciliabile.
    expect(repository.row(APPOINTMENT_ID)?.calendarSyncStatus).toBe('failed');
  });

  it('supports tenants without Google Calendar integration', async () => {
    const repository = new FakeBookingRepository({ googleCalendarIntegration: null });
    const calendar = new FakeGoogleCalendar();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const result = await service.createAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      serviceId: 'service_1',
      appointmentId: APPOINTMENT_ID,
      customerIdentifier: '393331112233',
      customerName: 'Mario Rossi',
      scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
      now,
    });

    expect(result).toMatchObject({
      calendarSyncStatus: 'not_configured',
      calendarEventId: null,
      confirmationQueued: true,
    });
    expect(repository.insertedAppointments[0]?.calendarSyncNextAttemptAt).toBeNull();
    expect(calendar.insertCount).toBe(0);
  });

  it('reschedules an appointment, patches Google Calendar and queues a scoped confirmation', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    repository.seed(appointmentForChange());
    calendar.events.set(DERIVED_EVENT_ID, {
      id: DERIVED_EVENT_ID,
      calendarId: 'primary',
      status: 'confirmed',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      summary: 'Studio Ambrogio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });
    const notifications = new FakeNotificationEnqueuer();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      notifications,
      repository.writes,
    );

    const result = await service.rescheduleAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
      now,
    });

    expect(result).toMatchObject({
      appointmentId: APPOINTMENT_ID,
      status: 'confirmed',
      calendarSyncStatus: 'synced',
      calendarEventId: DERIVED_EVENT_ID,
      notificationQueued: true,
    });
    // Postgres per primo: la riga passa da `pending` prima che Google sappia
    // qualcosa.
    expect(repository.scheduleUpdates[0]).toMatchObject({
      calendarSyncStatus: 'pending',
    });
    expect(repository.scheduleUpdates[0]?.calendarSyncNextAttemptAt).toEqual(now);
    expect(calendar.patchCount).toBe(1);
    expect(calendar.insertCount).toBe(0);
    expect(calendar.events.get(DERIVED_EVENT_ID)?.start).toEqual(
      new Date('2026-04-27T10:00:00.000Z'),
    );
    expect(notifications.calls[0]).toMatchObject({
      kind: 'confirmation',
      idempotencyScope: 'rescheduled:2026-04-27T10:00:00.000Z',
    });
  });

  it('lets the latest Postgres time win when an earlier create never reached Google', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    // La creazione non e' mai arrivata: nessun evento remoto, riga in failed
    // con la sua identita' intatta.
    repository.seed(
      appointmentForChange({
        calendarSyncStatus: 'failed',
        calendarEventHtmlLink: null,
      }),
    );
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await service.rescheduleAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
      now,
    });
    await service.rescheduleAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      scheduledAt: new Date('2026-04-27T11:00:00.000Z'),
      now,
    });

    // Un solo evento, all'ultimo orario: la convergenza non riesegue la
    // storia, porta il calendario allo stato attuale.
    expect(calendar.activeEvents()).toHaveLength(1);
    expect(calendar.events.get(DERIVED_EVENT_ID)?.start).toEqual(
      new Date('2026-04-27T11:00:00.000Z'),
    );
    expect(repository.row(APPOINTMENT_ID)?.calendarSyncStatus).toBe('synced');
  });

  it('operates the stored legacy event id instead of deriving a new one', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    repository.seed(appointmentForChange({ calendarEventId: LEGACY_EVENT_ID }));
    calendar.events.set(LEGACY_EVENT_ID, {
      id: LEGACY_EVENT_ID,
      calendarId: 'primary',
      status: 'confirmed',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      summary: 'Studio Ambrogio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=legacy',
    });
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const result = await service.rescheduleAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
      now,
    });

    expect(result.calendarEventId).toBe(LEGACY_EVENT_ID);
    // Nessun evento nuovo con l'id derivato: sarebbe il doppione.
    expect(calendar.events.has(DERIVED_EVENT_ID)).toBe(false);
    expect(calendar.activeEvents()).toHaveLength(1);
    expect(calendar.events.get(LEGACY_EVENT_ID)?.start).toEqual(
      new Date('2026-04-27T10:00:00.000Z'),
    );
  });

  it('refuses to invent an event for a legacy row that has no stored identity', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    repository.seed(appointmentForChange({ calendarEventId: null, calendarEventHtmlLink: null }));
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const result = await service.rescheduleAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
      requireCalendarSync: false,
      now,
    });

    expect(result.calendarSyncStatus).toBe('failed');
    // Nessuna scrittura su Google: potrebbe esistere gia' un evento che non
    // sappiamo indirizzare, e crearne un altro sarebbe il duplicato.
    expect(calendar.insertCount).toBe(0);
    expect(calendar.patchCount).toBe(0);

    const row = repository.row(APPOINTMENT_ID);
    expect(row?.calendarSyncError).toBe(LEGACY_MISSING_EVENT_ID_ERROR);
    // Terminale per predicato: passa all'operatore, non al retry automatico.
    expect(row?.calendarSyncAttempts).toBeGreaterThanOrEqual(5);
    // Lo spostamento in Postgres e' comunque avvenuto.
    expect(row?.scheduledAt).toEqual(new Date('2026-04-27T10:00:00.000Z'));
  });

  it('cancels the appointment in Postgres before touching Google', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    repository.seed(appointmentForChange());
    calendar.events.set(DERIVED_EVENT_ID, {
      id: DERIVED_EVENT_ID,
      calendarId: 'primary',
      status: 'confirmed',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      summary: 'Studio Ambrogio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });
    const notifications = new FakeNotificationEnqueuer();
    calendar.trace = repository.writeOrder;
    const service = new AppointmentBookingService(
      repository,
      calendar,
      notifications,
      repository.writes,
    );

    const result = await service.cancelAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      now,
    });

    expect(result).toMatchObject({
      status: 'cancelled',
      calendarSyncStatus: 'synced',
      notificationQueued: true,
    });
    // L'ordine e' la correzione centrale: la riga e' gia' `cancelled` e
    // `pending` prima che parta la DELETE.
    // La sequenza e' piu' ricca di prima e dice una cosa in piu': fra
    // l'annullamento autorevole e la DELETE remota c'e' un INTENTO DUREVOLE
    // COMMITTATO. Se il processo muore fra `intent_delete` e `google`, resta
    // scritto che una cancellazione remota era stata autorizzata — che e'
    // l'unica cosa capace di far ritrovare l'evento a chi verra' dopo.
    expect(repository.writeOrder).toEqual([
      'cancel',
      'intent_delete',
      'google',
      'settle_settled_current',
    ]);
    expect(repository.cancelUpdates[0]).toMatchObject({ calendarSyncStatus: 'pending' });
    expect(repository.cancelUpdates[0]?.calendarSyncNextAttemptAt).toEqual(now);
    expect(calendar.activeEvents()).toHaveLength(0);
    expect(notifications.calls[0]).toMatchObject({ kind: 'cancellation' });
  });

  it('keeps a failed cancellation retryable instead of losing the Google event', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    repository.seed(appointmentForChange());
    calendar.events.set(DERIVED_EVENT_ID, {
      id: DERIVED_EVENT_ID,
      calendarId: 'primary',
      status: 'confirmed',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      summary: 'Studio Ambrogio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });
    calendar.cancelError = googleError(503, 'Service Unavailable');
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const result = await service.cancelAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      requireCalendarSync: false,
      now,
    });

    expect(result.calendarSyncStatus).toBe('failed');

    const row = repository.row(APPOINTMENT_ID);
    // L'annullamento e' definitivo lato prodotto...
    expect(row?.status).toBe('cancelled');
    // ...e la rimozione dell'evento resta dovuta: senza, l'evento fantasma
    // continuerebbe a occupare lo slot nel calcolo della disponibilita'.
    expect(row?.calendarSyncStatus).toBe('failed');
    expect(row?.calendarEventId).toBe(DERIVED_EVENT_ID);
    expect(row?.calendarSyncNextAttemptAt).not.toBeNull();
    expect(row?.calendarSyncAttempts).toBe(1);
  });

  it('reports a successful cancellation even when the caller required calendar sync', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    repository.seed(appointmentForChange());
    calendar.events.set(DERIVED_EVENT_ID, {
      id: DERIVED_EVENT_ID,
      calendarId: 'primary',
      status: 'confirmed',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      summary: 'Studio Ambrogio: Prima visita - Mario Rossi',
      htmlLink: 'https://calendar.google.com/event?eid=x',
    });
    calendar.cancelError = googleError(503, 'Service Unavailable');
    const notifications = new FakeNotificationEnqueuer();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      notifications,
      repository.writes,
    );

    // `requireCalendarSync` di default e' true: prima questo percorso sollevava
    // DOPO che la cancellazione autorevole era gia' committata, dicendo al
    // chiamante che l'operazione non era avvenuta quando invece era definitiva.
    const result = await service.cancelAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      appointmentId: APPOINTMENT_ID,
      requireCalendarSync: true,
      now,
    });

    expect(result.status).toBe('cancelled');
    expect(result.calendarSyncStatus).toBe('failed');
    // La notifica al cliente parte: l'annullamento e' reale.
    expect(result.notificationQueued).toBe(true);
    expect(notifications.calls[0]).toMatchObject({ kind: 'cancellation' });

    const row = repository.row(APPOINTMENT_ID);
    expect(row?.status).toBe('cancelled');
    // Google resta da riparare, e resta riparabile.
    expect(row?.calendarSyncStatus).toBe('failed');
    expect(row?.calendarEventId).toBe(DERIVED_EVENT_ID);
    expect(row?.calendarSyncNextAttemptAt).not.toBeNull();
    expect(row?.calendarSyncAttempts).toBeLessThan(5);
  });

  it('stops a reschedule whose guarded update lost the race to a cancellation', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    repository.seed(appointmentForChange());
    // L'annullamento concorrente ha gia' rimosso l'evento da Google.
    repository.beforeScheduleUpdate = async () => {
      const existing = repository.row(APPOINTMENT_ID);

      if (existing) {
        repository.rows.set(APPOINTMENT_ID, { ...existing, status: 'cancelled' });
      }
    };
    const notifications = new FakeNotificationEnqueuer();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      notifications,
      repository.writes,
    );

    await expect(
      service.rescheduleAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        appointmentId: APPOINTMENT_ID,
        scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
        requireCalendarSync: false,
        now,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // Il punto della correzione: senza il rilevamento delle zero righe, la
    // riprogrammazione sarebbe proseguita, la convergenza avrebbe trovato
    // l'evento assente e lo avrebbe RICREATO per un appuntamento annullato.
    expect(calendar.insertCount).toBe(0);
    expect(calendar.patchCount).toBe(0);
    expect(calendar.getCount).toBe(0);
    expect(calendar.activeEvents()).toHaveLength(0);

    const row = repository.row(APPOINTMENT_ID);
    expect(row?.status).toBe('cancelled');
    // Nessuna scrittura di esito: la riga non e' stata marcata sincronizzata,
    // quindi non e' stata sottratta al reconciler.
    expect(repository.calendarSyncUpdates).toHaveLength(0);
    expect(notifications.calls).toHaveLength(0);
  });
});

/**
 * PILOT-P0-2 — il servizio non ha il permesso di indovinare.
 *
 * Quando il tenant ha Google collegato, ogni esito di `getAvailableSlots` che
 * non sia "Google ha confermato" deve essere un errore. Le due alternative che
 * questi test escludono — lista vuota e sole fasce locali — sono entrambe
 * risposte che sembrano corrette e producono prenotazioni sopra impegni veri.
 */
describe('AppointmentBookingService availability verification (PILOT-P0-2)', () => {
  it('never falls back to local-only slots when Google availability is unverifiable', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    calendar.listBusyError = transientAvailabilityFailure();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const error = await service
      .getAvailableSlots({
        tenantId: 'tenant_1',
        serviceId: 'service_1',
        from: new Date('2026-04-27T09:00:00.000Z'),
        to: new Date('2026-04-27T12:00:00.000Z'),
        now,
        maxSlots: 10,
        slotStepMinutes: 30,
      })
      .then((slots) => slots)
      .catch((caught: unknown) => caught);

    expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
    expect(Array.isArray(error)).toBe(false);
  });

  it('inserts zero appointments when create-time revalidation cannot be verified', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    calendar.listBusyError = transientAvailabilityFailure();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await expect(
      service.createAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        serviceId: 'service_1',
        appointmentId: APPOINTMENT_ID,
        customerIdentifier: '393331112233',
        customerName: 'Mario Rossi',
        scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
        now,
      }),
    ).rejects.toBeInstanceOf(CalendarAvailabilityUnavailable);

    // La prova che conta: nessuna riga scritta, quindi nessuna promessa fatta
    // al cliente che il calendario non conosca.
    expect(repository.insertedAppointments).toHaveLength(0);
    expect(calendar.insertCount).toBe(0);
  });

  it('leaves the existing schedule untouched when reschedule revalidation fails', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const created = await service.createAppointment({
      tenantId: 'tenant_1',
      expectedProjectionEpoch: 0,
      serviceId: 'service_1',
      appointmentId: APPOINTMENT_ID,
      customerIdentifier: '393331112233',
      customerName: 'Mario Rossi',
      scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
      now,
    });
    const scheduleUpdatesBefore = repository.scheduleUpdates.length;

    calendar.listBusyError = transientAvailabilityFailure();

    await expect(
      service.rescheduleAppointment({
        tenantId: 'tenant_1',
        expectedProjectionEpoch: 0,
        appointmentId: created.appointmentId,
        scheduledAt: new Date('2026-04-27T11:00:00.000Z'),
        now,
      }),
    ).rejects.toBeInstanceOf(CalendarAvailabilityUnavailable);

    expect(repository.scheduleUpdates).toHaveLength(scheduleUpdatesBefore);
    expect(repository.row(APPOINTMENT_ID)?.scheduledAt.toISOString()).toBe(
      '2026-04-27T09:00:00.000Z',
    );
  });

  it('writes the health marker on a permanent integration auth failure', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    calendar.listBusyError = authAvailabilityFailure();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await expect(availability(service)).rejects.toBeInstanceOf(CalendarAvailabilityUnavailable);

    expect(repository.availabilityHealthWrites).toEqual([
      { integrationId: 'integration_1', errorCode: 'google_availability_auth' },
    ]);
  });

  it('does not write a permanent marker for a transient failure', async () => {
    const repository = new FakeBookingRepository();
    const calendar = new FakeGoogleCalendar();
    calendar.listBusyError = transientAvailabilityFailure();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await expect(availability(service)).rejects.toBeInstanceOf(CalendarAvailabilityUnavailable);

    // Un 429 descrive Google adesso, non l'integrazione del tenant: marcarlo
    // riempirebbe il watchdog di allarmi che si risolvono da soli.
    expect(repository.availabilityHealthWrites).toHaveLength(0);
  });

  it('keeps the original availability error when the health write fails', async () => {
    const repository = new FakeBookingRepository();
    repository.failAvailabilityHealthWrite = true;
    const calendar = new FakeGoogleCalendar();
    calendar.listBusyError = authAvailabilityFailure();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const error = await availability(service).catch((caught: unknown) => caught);

    // Sostituire l'errore originale con quello dell'osservabilita' perderebbe
    // la ragione vera del guasto e cambierebbe la risposta al cliente.
    expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
    expect((error as CalendarAvailabilityUnavailable).kind).toBe('auth');
  });

  it('clears an existing marker after a verified success', async () => {
    const repository = new FakeBookingRepository({
      googleAvailabilityErrorCode: 'google_availability_auth',
    });
    const service = new AppointmentBookingService(
      repository,
      new FakeGoogleCalendar(),
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await availability(service);

    expect(repository.availabilityHealthClears).toEqual(['integration_1']);
  });

  it('performs no health UPDATE on a verified success without an existing marker', async () => {
    const repository = new FakeBookingRepository();
    const service = new AppointmentBookingService(
      repository,
      new FakeGoogleCalendar(),
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    await availability(service);

    // Senza questa condizione ogni turno di prenotazione andato bene
    // scriverebbe su `integrations` per azzerare due colonne gia' nulle.
    expect(repository.availabilityHealthClears).toHaveLength(0);
  });

  it('keeps verified availability valid when clearing the marker fails', async () => {
    const repository = new FakeBookingRepository({
      googleAvailabilityErrorCode: 'google_availability_auth',
    });
    repository.failAvailabilityHealthClear = true;
    const service = new AppointmentBookingService(
      repository,
      new FakeGoogleCalendar(),
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    // Il peggio che accade e' un allarme che sopravvive un giro di troppo.
    await expect(availability(service)).resolves.toBeInstanceOf(Array);
  });

  it('keeps Postgres-only availability for a tenant without a Google integration', async () => {
    const repository = new FakeBookingRepository({ googleCalendarIntegration: null });
    repository.localBusy = [busy('2026-04-27T09:30:00.000Z', '2026-04-27T10:00:00.000Z')];
    const calendar = new FakeGoogleCalendar();
    // Anche con Google guasto: senza integrazione, Google non viene interrogato.
    calendar.listBusyError = transientAvailabilityFailure();
    const service = new AppointmentBookingService(
      repository,
      calendar,
      new FakeNotificationEnqueuer(),
      repository.writes,
    );

    const slots = await service.getAvailableSlots({
      tenantId: 'tenant_1',
      serviceId: 'service_1',
      from: new Date('2026-04-27T09:00:00.000Z'),
      to: new Date('2026-04-27T12:00:00.000Z'),
      now,
      maxSlots: 10,
      slotStepMinutes: 30,
    });

    expect(calendar.listBusyCount).toBe(0);
    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-04-27T09:00:00.000Z',
      '2026-04-27T10:00:00.000Z',
      '2026-04-27T10:30:00.000Z',
      '2026-04-27T11:00:00.000Z',
      '2026-04-27T11:30:00.000Z',
    ]);
  });
});

function availability(service: AppointmentBookingService) {
  return service.getAvailableSlots({
    tenantId: 'tenant_1',
    serviceId: 'service_1',
    from: new Date('2026-04-27T09:00:00.000Z'),
    to: new Date('2026-04-27T12:00:00.000Z'),
    now,
    maxSlots: 10,
    slotStepMinutes: 30,
  });
}

function transientAvailabilityFailure(): CalendarAvailabilityUnavailable {
  return new CalendarAvailabilityUnavailable('Google Calendar freeBusy failed (429)', {
    kind: 'transient',
    httpStatus: 429,
    reason: 'freebusy_http_429',
  });
}

function authAvailabilityFailure(): CalendarAvailabilityUnavailable {
  return new CalendarAvailabilityUnavailable('Google Calendar refresh token is no longer valid', {
    kind: 'auth',
    reason: 'invalid_grant',
  });
}

type StoredAppointment = FakeStoredAppointment;

/**
 * Repository in memoria che applica le patch come le applica il SQL reale.
 *
 * Le asserzioni interessanti riguardano cio' che RESTA nella riga dopo una
 * sequenza di scritture — per esempio che un fallimento non azzeri
 * `calendar_event_id` — e su un fake che si limitasse a registrare le
 * chiamate non sarebbero verificabili.
 */
class FakeBookingRepository implements AppointmentBookingRepository {
  readonly context: BookingServiceContext;
  localBusy: CalendarBusyInterval[] = [];
  readonly rows = new Map<string, StoredAppointment>();
  readonly writeOrder: string[] = [];
  /**
   * Autorita' di scrittura del servizio.
   *
   * Condivide righe e ordine delle scritture con questo repository: le due
   * viste devono raccontare la stessa storia, come in produzione, dove sono
   * la stessa tabella.
   */
  readonly writes: FakeCalendarWriteStore;
  lastLocalBusyInput: {
    tenantId: string;
    from: Date;
    to: Date;
    excludeAppointmentId?: string;
  } | null = null;
  availabilityHealthWrites: Array<{ integrationId: string; errorCode: string }> = [];
  availabilityHealthClears: string[] = [];
  /** Innesto per simulare una scrittura di health fallita. */
  failAvailabilityHealthWrite = false;
  failAvailabilityHealthClear = false;

  constructor(overrides: Partial<BookingServiceContext> = {}) {
    this.context = {
      tenantId: 'tenant_1',
      timezone: 'UTC',
      studioName: 'Studio Ambrogio',
      address: 'Via Roma 1',
      bookingMinLeadMinutes: 0,
      bookingSlotStepMinutes: 30,
      bookingBufferMinutes: 0,
      bookingMaxDaysAhead: 30,
      service: {
        id: 'service_1',
        name: 'Prima visita',
        durationMinutes: 30,
        active: true,
      },
      businessHours: [{ weekday: 1, opensAt: '09:00:00', closesAt: '12:00:00' }],
      googleAvailabilityErrorCode: null,
      googleCalendarIntegration: {
        id: 'integration_1',
        tenantId: 'tenant_1',
        externalAccountId: null,
        credentials: { access_token: 'access_1' },
        config: { calendar_id: 'primary' },
      },
      ...overrides,
    };
    this.writes = new FakeCalendarWriteStore(this.rows, this.writeOrder);
  }

  // Accessori di lettura sulle scritture autorevoli. Restano qui perche' i
  // test parlano di "cosa ha fatto il repository", ma la semantica e' quella
  // della primitiva.
  get insertedAppointments(): FakeCalendarWriteStore['createInputs'] {
    return this.writes.createInputs;
  }

  get scheduleUpdates(): FakeCalendarWriteStore['rescheduleInputs'] {
    return this.writes.rescheduleInputs;
  }

  get cancelUpdates(): FakeCalendarWriteStore['cancelInputs'] {
    return this.writes.cancelInputs;
  }

  get calendarSyncUpdates(): FakeCalendarWriteStore['settles'] {
    return this.writes.settles;
  }

  /** Innesto per simulare una scrittura concorrente a meta' riprogrammazione. */
  set beforeScheduleUpdate(hook: (() => Promise<void>) | null) {
    this.writes.beforeReschedule = hook;
  }

  seed(appointment: AppointmentForChange): void {
    this.rows.set(appointment.id, {
      ...appointment,
      calendarSyncError: null,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: null,
      calendarSyncLastAttemptAt: null,
      // Una riga preesistente ha gia' uno stato desiderato e una generazione:
      // partire da zero nasconderebbe il fatto che il CAS li confronta.
      desiredVersion: 0,
      writeGeneration: 0,
    });
  }

  row(appointmentId: string): StoredAppointment | undefined {
    return this.rows.get(appointmentId);
  }

  async getBookingContext(): Promise<BookingServiceContext | null> {
    return this.context;
  }

  async listLocalBusyIntervals(input: {
    tenantId: string;
    from: Date;
    to: Date;
    excludeAppointmentId?: string;
  }): Promise<CalendarBusyInterval[]> {
    this.lastLocalBusyInput = input;
    return this.localBusy;
  }

  async updateGoogleCalendarAccessToken(): Promise<void> {}

  async markGoogleAvailabilityError(input: {
    integrationId: string;
    errorCode: string;
  }): Promise<void> {
    if (this.failAvailabilityHealthWrite) {
      throw new AppError('upstream_error', 'health write failed', { expose: false });
    }

    this.availabilityHealthWrites.push({
      integrationId: input.integrationId,
      errorCode: input.errorCode,
    });
  }

  async clearGoogleAvailabilityError(input: { integrationId: string }): Promise<void> {
    if (this.failAvailabilityHealthClear) {
      throw new AppError('upstream_error', 'health clear failed', { expose: false });
    }

    this.availabilityHealthClears.push(input.integrationId);
  }

  async getAppointmentForChange(input: {
    appointmentId: string;
  }): Promise<AppointmentForChange | null> {
    return this.rows.get(input.appointmentId) ?? null;
  }
}

class FakeNotificationEnqueuer implements AppointmentNotificationEnqueuer {
  calls: Array<{
    tenantId: string;
    appointmentId: string;
    kind: 'confirmation' | 'cancellation';
    idempotencyScope?: string;
    now?: Date;
  }> = [];

  async enqueueNotification(input: {
    tenantId: string;
    appointmentId: string;
    kind: 'confirmation' | 'cancellation';
    idempotencyScope?: string;
    now?: Date;
  }): Promise<{ queued: boolean }> {
    this.calls.push(input);
    return { queued: true };
  }
}

function busy(start: string, end: string): CalendarBusyInterval {
  return {
    start: new Date(start),
    end: new Date(end),
    source: 'local_appointment',
  };
}

function appointmentForChange(overrides: Partial<AppointmentForChange> = {}): AppointmentForChange {
  return {
    id: APPOINTMENT_ID,
    tenantId: 'tenant_1',
    conversationId: 'conversation_1',
    serviceId: 'service_1',
    serviceName: 'Prima visita',
    customerIdentifier: '393331112233',
    customerName: 'Mario Rossi',
    customerPhone: '393331112233',
    scheduledAt: new Date('2026-04-27T09:00:00.000Z'),
    durationMinutes: 30,
    status: 'confirmed' as AppointmentStatus,
    calendarProvider: 'google_calendar',
    calendarSyncStatus: 'synced',
    calendarEventId: DERIVED_EVENT_ID,
    // Provenienza NON verificata: e' la condizione di una riga che nessuna
    // osservazione remota positiva ha ancora confermato.
    calendarEventCalendarId: null,
    calendarEventHtmlLink: 'https://calendar.google.com/event?eid=x',
    notes: null,
    ...overrides,
  };
}
