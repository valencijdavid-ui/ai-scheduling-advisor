/* eslint-disable no-restricted-syntax -- Test fixtures: il fake mock del booking
service viene castato a `AppointmentBookingService` solo per soddisfare la
firma del costruttore. La validazione runtime non aggiungerebbe valore in test. */
import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_UNVERIFIABLE_CONFIRMATION_REPLY,
  AVAILABILITY_UNVERIFIABLE_REPLY,
  BookingBridgeService,
  PROJECTION_FENCE_RETRY_REPLY,
  type BookingBridgeRepository,
  type BookingServiceOption,
  type ConversationBookingState,
  type CustomerAppointmentForBridge,
} from '@/server/ai/booking-bridge';
import type {
  AppointmentBookingService,
  BookingSlot,
  CancelAppointmentInput,
  CreateAppointmentInput,
  RescheduleAppointmentInput,
} from '@/server/appointments/booking';
import type {
  SchedulingDecisionInput,
  SchedulingDecisionLedger,
} from '@/server/appointments/decision-ledger';
import { SLOT_RANKING_VERSION } from '@/server/appointments/slot-ranking';
import { AppError } from '@/lib/errors/app-error';
import { staleProjectionEpochError } from '@/server/appointments/projection-fence';
import { CalendarAvailabilityUnavailable } from '@/server/calendar/availability-error';

/** Epoca di proiezione osservata dal turno in ognuno di questi test. */
const TURN_EPOCH = 7;

const occurredAt = new Date('2026-04-27T07:00:00.000Z');

describe('BookingBridgeService', () => {
  it('proposes real booking slots for a matched service', async () => {
    const repository = new FakeBookingBridgeRepository([
      {
        id: 'service_1',
        name: 'Prima visita',
        durationMinutes: 30,
        priceCents: 7000,
      },
    ]);
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    expect(reply).toMatchObject({
      handled: true,
      metadata: {
        bookingBridge: {
          action: 'slots_proposed',
          serviceId: 'service_1',
        },
      },
    });
    expect(reply.replyText).toContain('Ho trovato questi slot');
    expect(reply.replyText).toContain('confermo 1');
    expect(savedSlots(repository)).toHaveLength(3);
    expect(booking.availabilityCalls[0]).toMatchObject({
      tenantId: 'tenant_1',
      serviceId: 'service_1',
      maxSlots: 3,
    });
  });

  it('uses extracted date and time preferences when proposing slots', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = [
      slot('2026-04-28T09:00:00.000Z', '2026-04-28T09:30:00.000Z'),
      slot('2026-04-28T14:00:00.000Z', '2026-04-28T14:30:00.000Z'),
      slot('2026-04-28T16:00:00.000Z', '2026-04-28T16:30:00.000Z'),
      slot('2026-04-28T19:00:00.000Z', '2026-04-28T19:30:00.000Z'),
    ];
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare prima visita domani pomeriggio',
    });

    expect(booking.availabilityCalls[0]).toMatchObject({
      from: new Date('2026-04-28T13:00:00.000Z'),
      to: new Date('2026-04-28T18:00:00.000Z'),
      maxSlots: 20,
    });
    expect(savedSlots(repository).map((item) => item.start)).toEqual([
      '2026-04-28T14:00:00.000Z',
      '2026-04-28T16:00:00.000Z',
    ]);
    expect(reply.metadata).toMatchObject({
      bookingBridge: {
        request: {
          datePreference: {
            label: 'domani',
          },
          timePreference: {
            dayPart: 'afternoon',
          },
        },
      },
    });
  });

  it('asks which service when the request is ambiguous', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
      serviceOption('service_2', 'Igiene dentale'),
    ]);
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare',
    });

    expect(reply.replyText).toContain('Quale servizio ti interessa?');
    expect(reply.replyText).toContain('Prima visita');
    expect(reply.replyText).toContain('Igiene dentale');
    expect(booking.availabilityCalls).toHaveLength(0);
  });

  it('confirms a previously proposed slot and clears conversation state', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.savedState = stateWithSlots();
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Confermo 2',
    });

    expect(reply).toMatchObject({
      handled: true,
      metadata: {
        bookingBridge: {
          action: 'appointment_created',
          appointmentId: 'appointment_1',
        },
      },
    });
    expect(booking.createCalls[0]).toMatchObject({
      tenantId: 'tenant_1',
      serviceId: 'service_1',
      conversationId: 'conversation_1',
      customerIdentifier: '393331112233',
      customerPhone: '393331112233',
      scheduledAt: new Date('2026-04-28T10:00:00.000Z'),
      requireCalendarSync: false,
      sendConfirmation: true,
    });
    expect(repository.cleared).toBe(true);
    expect(reply.replyText).toContain('Perfetto, ho prenotato');
  });

  it('expires stale proposed slots before booking', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.savedState = {
      ...stateWithSlots(),
      expiresAt: '2026-04-27T06:00:00.000Z',
    };
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Confermo 1',
    });

    expect(reply.metadata).toMatchObject({
      bookingBridge: {
        action: 'slot_state_expired',
      },
    });
    expect(booking.createCalls).toHaveLength(0);
    expect(repository.cleared).toBe(true);
  });

  it('asks for a target date before rescheduling a single appointment', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [customerAppointment()];
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei spostare il mio appuntamento',
      intent: 'reschedule_request',
    });

    expect(reply).toMatchObject({
      handled: true,
      metadata: {
        bookingBridge: {
          action: 'reschedule_date_requested',
          appointmentId: 'appointment_1',
        },
      },
    });
    expect(reply.replyText).toContain('Per quale giorno');
    expect(repository.savedState).toMatchObject({
      status: 'reschedule_date_requested',
    });
  });

  it('proposes reschedule slots and confirms the selected new slot', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.savedState = {
      status: 'reschedule_date_requested',
      appointment: pendingAppointment(),
      proposedAt: '2026-04-27T07:00:00.000Z',
      expiresAt: '2026-04-27T07:30:00.000Z',
    };
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const slotsReply = await service.createBookingReply({
      ...baseInput(),
      text: 'domani mattina',
      intent: 'booking_request',
    });

    expect(slotsReply).toMatchObject({
      metadata: {
        bookingBridge: {
          action: 'reschedule_slots_proposed',
          appointmentId: 'appointment_1',
        },
      },
    });
    expect(booking.availabilityCalls[0]).toMatchObject({
      tenantId: 'tenant_1',
      serviceId: 'service_1',
      excludeAppointmentId: 'appointment_1',
      durationMinutes: 30,
      maxSlots: 20,
    });
    expect(repository.savedState).toMatchObject({
      status: 'reschedule_slots_proposed',
    });

    const confirmReply = await service.createBookingReply({
      ...baseInput(),
      text: 'confermo 2',
      intent: 'other',
    });

    expect(confirmReply).toMatchObject({
      metadata: {
        bookingBridge: {
          action: 'appointment_rescheduled',
          appointmentId: 'appointment_1',
        },
      },
    });
    expect(booking.rescheduleCalls[0]).toMatchObject({
      tenantId: 'tenant_1',
      appointmentId: 'appointment_1',
      scheduledAt: new Date('2026-04-28T10:00:00.000Z'),
      requireCalendarSync: false,
      sendConfirmation: true,
    });
    expect(repository.cleared).toBe(true);
  });

  it('cancels a single future appointment for the WhatsApp number', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [customerAppointment()];
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei annullare il mio appuntamento',
      intent: 'cancellation_request',
    });

    expect(reply).toMatchObject({
      metadata: {
        bookingBridge: {
          action: 'appointment_cancelled',
          appointmentId: 'appointment_1',
        },
      },
    });
    expect(booking.cancelCalls[0]).toMatchObject({
      tenantId: 'tenant_1',
      appointmentId: 'appointment_1',
      requireCalendarSync: false,
      sendCancellation: true,
    });
  });

  it('uses natural appointment hints to cancel the matching time', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [
      customerAppointment({ appointmentId: 'appointment_1' }),
      customerAppointment({
        appointmentId: 'appointment_2',
        scheduledAt: new Date('2026-04-28T15:00:00.000Z'),
      }),
    ];
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Annulla quello delle 15',
      intent: 'cancellation_request',
    });

    expect(reply.metadata).toMatchObject({
      bookingBridge: {
        action: 'appointment_cancelled',
        appointmentId: 'appointment_2',
      },
    });
    expect(booking.cancelCalls[0]).toMatchObject({
      appointmentId: 'appointment_2',
    });
  });

  it('uses natural appointment hints to cancel the matching customer name', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [
      customerAppointment({
        appointmentId: 'appointment_1',
        customerName: 'Luca',
      }),
      customerAppointment({
        appointmentId: 'appointment_2',
        customerName: 'Mario',
        scheduledAt: new Date('2026-04-29T09:00:00.000Z'),
      }),
    ];
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Annulla la visita di Mario',
      intent: 'cancellation_request',
    });

    expect(reply.metadata).toMatchObject({
      bookingBridge: {
        action: 'appointment_cancelled',
        appointmentId: 'appointment_2',
      },
    });
    expect(booking.cancelCalls[0]).toMatchObject({
      appointmentId: 'appointment_2',
    });
  });

  it('uses source-date hints for reschedule lookup before asking the target date', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [
      customerAppointment({
        appointmentId: 'appointment_1',
        scheduledAt: new Date('2026-04-28T09:00:00.000Z'),
      }),
      customerAppointment({
        appointmentId: 'appointment_2',
        scheduledAt: new Date('2026-04-29T09:00:00.000Z'),
      }),
    ];
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei spostare quello di domani',
      intent: 'reschedule_request',
    });

    expect(reply.metadata).toMatchObject({
      bookingBridge: {
        action: 'reschedule_date_requested',
        appointmentId: 'appointment_1',
      },
    });
    expect(reply.replyText).toContain('Per quale giorno');
    expect(booking.availabilityCalls).toHaveLength(0);
    expect(repository.savedState).toMatchObject({
      status: 'reschedule_date_requested',
      appointment: {
        appointmentId: 'appointment_1',
      },
    });
  });

  it('keeps source customer and target date separate during reschedule', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [
      customerAppointment({
        appointmentId: 'appointment_1',
        customerName: 'Luca',
      }),
      customerAppointment({
        appointmentId: 'appointment_2',
        customerName: 'Mario',
      }),
    ];
    const booking = new FakeAppointmentBookingService();
    booking.slots = [
      slot('2026-05-01T09:00:00.000Z', '2026-05-01T09:30:00.000Z'),
      slot('2026-05-01T10:00:00.000Z', '2026-05-01T10:30:00.000Z'),
    ];
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Sposta la visita di Mario a venerdi mattina',
      intent: 'reschedule_request',
    });

    expect(reply.metadata).toMatchObject({
      bookingBridge: {
        action: 'reschedule_slots_proposed',
        appointmentId: 'appointment_2',
        request: {
          datePreference: {
            label: 'venerdi',
          },
          timePreference: {
            dayPart: 'morning',
          },
        },
      },
    });
    expect(booking.availabilityCalls[0]).toMatchObject({
      tenantId: 'tenant_1',
      serviceId: 'service_1',
      excludeAppointmentId: 'appointment_2',
      from: new Date('2026-05-01T08:00:00.000Z'),
      to: new Date('2026-05-01T13:00:00.000Z'),
    });
    expect(repository.savedState).toMatchObject({
      status: 'reschedule_slots_proposed',
      appointment: {
        appointmentId: 'appointment_2',
      },
    });
  });

  it('keeps source date and target date separate during reschedule', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [
      customerAppointment({
        appointmentId: 'appointment_1',
        scheduledAt: new Date('2026-04-28T09:00:00.000Z'),
      }),
      customerAppointment({
        appointmentId: 'appointment_2',
        scheduledAt: new Date('2026-04-29T09:00:00.000Z'),
      }),
    ];
    const booking = new FakeAppointmentBookingService();
    booking.slots = [
      slot('2026-05-01T09:00:00.000Z', '2026-05-01T09:30:00.000Z'),
      slot('2026-05-01T10:00:00.000Z', '2026-05-01T10:30:00.000Z'),
    ];
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Sposta quello di domani a venerdi mattina',
      intent: 'reschedule_request',
    });

    expect(reply.metadata).toMatchObject({
      bookingBridge: {
        action: 'reschedule_slots_proposed',
        appointmentId: 'appointment_1',
        request: {
          datePreference: {
            label: 'venerdi',
          },
          timePreference: {
            dayPart: 'morning',
          },
        },
      },
    });
    expect(booking.availabilityCalls[0]).toMatchObject({
      excludeAppointmentId: 'appointment_1',
      from: new Date('2026-05-01T08:00:00.000Z'),
      to: new Date('2026-05-01T13:00:00.000Z'),
    });
    expect(repository.savedState).toMatchObject({
      status: 'reschedule_slots_proposed',
      appointment: {
        appointmentId: 'appointment_1',
      },
    });
  });

  it('asks which appointment to cancel when multiple future appointments match', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    repository.appointments = [
      customerAppointment({ appointmentId: 'appointment_1' }),
      customerAppointment({
        appointmentId: 'appointment_2',
        scheduledAt: new Date('2026-04-29T09:00:00.000Z'),
      }),
    ];
    const booking = new FakeAppointmentBookingService();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const selectionReply = await service.createBookingReply({
      ...baseInput(),
      text: 'Annulla appuntamento',
      intent: 'cancellation_request',
    });

    expect(selectionReply.replyText).toContain('Quale vuoi annullare?');
    expect(repository.savedState).toMatchObject({
      status: 'cancellation_selection',
    });

    const confirmReply = await service.createBookingReply({
      ...baseInput(),
      text: 'annulla 2',
      intent: 'other',
    });

    expect(confirmReply.metadata).toMatchObject({
      bookingBridge: {
        action: 'appointment_cancelled',
        appointmentId: 'appointment_2',
      },
    });
    expect(booking.cancelCalls[0]).toMatchObject({
      appointmentId: 'appointment_2',
    });
  });
});

/**
 * Ranking deterministico degli slot (flag SCHEDULING_RANKING_ENABLED).
 *
 * Il flag viene passato esplicitamente al costruttore: i test non dipendono
 * dall'ambiente, e la regressione "flag spento = comportamento di prima" resta
 * verificabile anche su una macchina che ha il flag acceso in .env.local.
 */
describe('BookingBridgeService — slot ranking', () => {
  /**
   * Slot volutamente fuori ordine cronologico: con il ranking spento devono
   * uscire nell'ordine in cui li produce il motore di disponibilità, con il
   * ranking acceso nell'ordine deciso dal ranker.
   */
  function unorderedSlots(): BookingSlot[] {
    return [
      slot('2026-04-30T09:00:00.000Z', '2026-04-30T09:30:00.000Z'),
      slot('2026-04-28T09:00:00.000Z', '2026-04-28T09:30:00.000Z'),
      slot('2026-04-29T09:00:00.000Z', '2026-04-29T09:30:00.000Z'),
      slot('2026-05-02T09:00:00.000Z', '2026-05-02T09:30:00.000Z'),
    ];
  }

  it('keeps the existing first-three selection when the flag is off', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = unorderedSlots();
    const ledger = new FakeSchedulingDecisionLedger();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
      undefined,
      { rankingEnabled: false, decisionLedger: ledger },
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    expect(reply.metadata).toMatchObject({ bookingBridge: { action: 'slots_proposed' } });
    expect(savedSlots(repository).map((item) => item.start)).toEqual([
      '2026-04-30T09:00:00.000Z',
      '2026-04-28T09:00:00.000Z',
      '2026-04-29T09:00:00.000Z',
    ]);
    expect(ledger.records).toEqual([]);
  });

  it('proposes the top three ranked slots when the flag is on', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = unorderedSlots();
    const ledger = new FakeSchedulingDecisionLedger();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
      undefined,
      { rankingEnabled: true, decisionLedger: ledger },
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    expect(reply.metadata).toMatchObject({ bookingBridge: { action: 'slots_proposed' } });
    expect(savedSlots(repository).map((item) => item.start)).toEqual([
      '2026-04-28T09:00:00.000Z',
      '2026-04-29T09:00:00.000Z',
      '2026-04-30T09:00:00.000Z',
    ]);
  });

  it('keeps the pending slot shape unchanged when ranking', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = unorderedSlots();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
      undefined,
      { rankingEnabled: true, decisionLedger: new FakeSchedulingDecisionLedger() },
    );

    await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    expect(savedSlots(repository)[0]).toEqual({
      serviceId: 'service_1',
      serviceName: 'Prima visita',
      start: '2026-04-28T09:00:00.000Z',
      end: '2026-04-28T09:30:00.000Z',
      durationMinutes: 30,
      timezone: 'UTC',
    });
  });

  it('persists every scored candidate in ranked order', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = unorderedSlots();
    const ledger = new FakeSchedulingDecisionLedger();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
      undefined,
      { rankingEnabled: true, decisionLedger: ledger },
    );

    await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    expect(ledger.records).toHaveLength(1);
    const decision = ledger.records[0];
    expect(decision).toMatchObject({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      rankingVersion: SLOT_RANKING_VERSION,
    });
    // Tutti e quattro i candidati valutati, non solo i tre proposti.
    expect(decision?.candidates.map((candidate) => candidate.start)).toEqual([
      '2026-04-28T09:00:00.000Z',
      '2026-04-29T09:00:00.000Z',
      '2026-04-30T09:00:00.000Z',
      '2026-05-02T09:00:00.000Z',
    ]);
    // I primi tre candidati SONO gli slot proposti: nessuna colonna "selected".
    expect(decision?.candidates.slice(0, 3).map((candidate) => candidate.start)).toEqual(
      savedSlots(repository).map((item) => item.start),
    );

    for (const candidate of decision?.candidates ?? []) {
      expect(candidate.reasons.reduce((total, reason) => total + reason.points, 0)).toBe(
        candidate.score,
      );
    }

    expect(decision?.explanation).toContain(SLOT_RANKING_VERSION);
  });

  it('records the decision even when no slot survives filtering', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = [];
    const ledger = new FakeSchedulingDecisionLedger();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
      undefined,
      { rankingEnabled: true, decisionLedger: ledger },
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    expect(reply.metadata).toMatchObject({ bookingBridge: { action: 'no_slots_available' } });
    expect(ledger.records[0]?.candidates).toEqual([]);
    expect(ledger.records[0]?.explanation).toBeNull();
  });

  it('answers normally when the ledger write fails', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = unorderedSlots();
    const ledger = new FakeSchedulingDecisionLedger();
    ledger.failure = new Error('ledger unavailable');
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
      undefined,
      { rankingEnabled: true, decisionLedger: ledger },
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    expect(reply.handled).toBe(true);
    expect(reply.replyText).toContain('Ho trovato questi slot');
    expect(savedSlots(repository)).toHaveLength(3);
  });

  it('confirms exactly the ranked slot stored in conversation state', async () => {
    const repository = new FakeBookingBridgeRepository([
      serviceOption('service_1', 'Prima visita'),
    ]);
    const booking = new FakeAppointmentBookingService();
    booking.slots = unorderedSlots();
    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
      undefined,
      { rankingEnabled: true, decisionLedger: new FakeSchedulingDecisionLedger() },
    );

    await service.createBookingReply({
      ...baseInput(),
      text: 'Vorrei prenotare una prima visita',
    });

    const proposed = savedSlots(repository);

    const confirmReply = await service.createBookingReply({
      ...baseInput(),
      text: 'confermo 2',
    });

    expect(confirmReply.metadata).toMatchObject({
      bookingBridge: { action: 'appointment_created' },
    });
    expect(booking.createCalls).toHaveLength(1);
    expect(booking.createCalls[0]?.scheduledAt.toISOString()).toBe(proposed[1]?.start);
    expect(proposed[1]?.start).toBe('2026-04-29T09:00:00.000Z');
  });
});

/**
 * PILOT-P0-2 — degradazione deterministica ai quattro confini di prodotto.
 *
 * La proprieta' condivisa: un guasto della verifica non puo' ne' proporre
 * orari, ne' dire "non ci sono orari", ne' finire al modello. `handled: true`
 * con testo costante e' l'unica forma in cui il turno puo' uscire, perche' e'
 * l'unica che non afferma qualcosa che non sappiamo.
 */
describe('BookingBridgeService availability degradation (PILOT-P0-2)', () => {
  describe('new booking discovery', () => {
    it('answers with the exact degraded constant instead of proposing slots', async () => {
      const { service, repository, booking } = discoveryHarness();
      booking.availabilityError = availabilityFailure();

      const reply = await service.createBookingReply({
        ...baseInput(),
        text: 'Vorrei prenotare una prima visita',
      });

      expect(reply.handled).toBe(true);
      // Byte a byte: e' l'unica asserzione che dimostra che il testo non e'
      // stato composto dal modello.
      expect(reply.replyText).toBe(AVAILABILITY_UNVERIFIABLE_REPLY);
      expect(reply.metadata).toMatchObject({
        bookingBridge: { action: 'availability_unverifiable', availabilityKind: 'transient' },
      });
      expect(repository.savedState).toBeNull();
      expect(repository.cleared).toBe(false);
    });

    it('never reaches the no_slots_available branch', async () => {
      const { service, booking } = discoveryHarness();
      booking.availabilityError = availabilityFailure();

      const reply = await service.createBookingReply({
        ...baseInput(),
        text: 'Vorrei prenotare una prima visita',
      });

      // `no_slots_available` afferma che la disponibilita' e' stata verificata
      // e non ha prodotto orari: e' proprio l'affermazione che qui manca.
      expect(bridgeAction(reply)).not.toBe('no_slots_available');
      expect(reply.replyText).not.toContain('non vedo slot liberi');
    });

    it('still propagates an unrelated failure', async () => {
      const { service, booking } = discoveryHarness();
      booking.availabilityError = new AppError('internal', 'unrelated boom', { expose: false });

      await expect(
        service.createBookingReply({ ...baseInput(), text: 'Vorrei prenotare una prima visita' }),
      ).rejects.toMatchObject({ code: 'internal' });
    });
  });

  describe('booking confirmation', () => {
    it('answers with the exact degraded confirmation constant and books nothing', async () => {
      const { service, repository, booking } = confirmationHarness();
      booking.createError = availabilityFailure();

      const reply = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      expect(reply.handled).toBe(true);
      expect(reply.replyText).toBe(AVAILABILITY_UNVERIFIABLE_CONFIRMATION_REPLY);
      expect(bridgeAction(reply)).toBe('availability_unverifiable_confirmation');
      expect(repository.cleared).toBe(false);
    });

    it('preserves the proposal state and its original expiry', async () => {
      const { service, repository, booking } = confirmationHarness();
      const before = repository.savedState;
      booking.createError = availabilityFailure();

      await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      // Il cliente ha ancora esattamente le opzioni che aveva un istante prima:
      // nessuna scadenza estesa, nessuna scadenza accorciata, niente perso.
      expect(repository.savedState).toBe(before);
      expect(repository.savedState?.expiresAt).toBe('2026-04-27T07:30:00.000Z');
    });

    it('books on an explicit customer retry once verification recovers', async () => {
      const { service, repository, booking } = confirmationHarness();
      booking.createError = availabilityFailure();

      await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      // Il recupero e' un gesto esplicito del cliente, non un job differito.
      booking.createError = null;
      const retry = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      expect(bridgeAction(retry)).toBe('appointment_created');
      expect(booking.createCalls).toHaveLength(2);
      expect(repository.cleared).toBe(true);
    });

    it('keeps a genuine conflict distinct, and first', async () => {
      const { service, repository, booking } = confirmationHarness();
      booking.createError = new AppError('conflict', 'Requested appointment slot is unavailable');

      const reply = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      // Il conflitto e' l'esito in cui la disponibilita' E' stata verificata:
      // raccontarlo come guasto del provider — o viceversa — direbbe al
      // cliente una cosa falsa in entrambe le direzioni.
      expect(bridgeAction(reply)).toBe('slot_conflict');
      expect(reply.replyText).toContain('non risulta piu disponibile');
      expect(reply.replyText).not.toBe(AVAILABILITY_UNVERIFIABLE_CONFIRMATION_REPLY);
      expect(repository.cleared).toBe(true);
    });
  });

  describe('reschedule discovery', () => {
    it('answers with the exact degraded constant and guesses no replacement times', async () => {
      const { service, repository, booking } = rescheduleDiscoveryHarness();
      booking.availabilityError = availabilityFailure();

      const reply = await service.createBookingReply({
        ...baseInput(),
        text: 'domani mattina',
        intent: 'booking_request',
      });

      expect(reply.handled).toBe(true);
      expect(reply.replyText).toBe(AVAILABILITY_UNVERIFIABLE_REPLY);
      expect(bridgeAction(reply)).toBe('reschedule_availability_unverifiable');
      // Lo stato precedente non viene sostituito da una proposta inventata.
      expect(repository.savedState?.status).toBe('reschedule_date_requested');
    });

    it('never reaches the reschedule_no_slots_available branch', async () => {
      const { service, booking } = rescheduleDiscoveryHarness();
      booking.availabilityError = availabilityFailure();

      const reply = await service.createBookingReply({
        ...baseInput(),
        text: 'domani mattina',
        intent: 'booking_request',
      });

      expect(bridgeAction(reply)).not.toBe('reschedule_no_slots_available');
      expect(reply.replyText).not.toContain('Non vedo slot liberi in quella fascia');
    });
  });

  describe('reschedule confirmation', () => {
    it('answers with the exact degraded confirmation constant and moves nothing', async () => {
      const { service, repository, booking } = rescheduleConfirmationHarness();
      booking.rescheduleError = availabilityFailure();

      const reply = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      expect(reply.handled).toBe(true);
      expect(reply.replyText).toBe(AVAILABILITY_UNVERIFIABLE_CONFIRMATION_REPLY);
      expect(bridgeAction(reply)).toBe('reschedule_availability_unverifiable_confirmation');
      expect(repository.cleared).toBe(false);
    });

    it('preserves the reschedule proposal state and expiry', async () => {
      const { service, repository, booking } = rescheduleConfirmationHarness();
      const before = repository.savedState;
      booking.rescheduleError = availabilityFailure();

      await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      expect(repository.savedState).toBe(before);
      expect(repository.savedState?.expiresAt).toBe('2026-04-27T07:30:00.000Z');
    });

    it('keeps a genuine reschedule conflict distinct, and first', async () => {
      const { service, repository, booking } = rescheduleConfirmationHarness();
      booking.rescheduleError = new AppError(
        'conflict',
        'Requested appointment slot is unavailable',
      );

      const reply = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

      expect(bridgeAction(reply)).toBe('reschedule_slot_conflict');
      expect(reply.replyText).not.toBe(AVAILABILITY_UNVERIFIABLE_CONFIRMATION_REPLY);
      expect(repository.cleared).toBe(true);
    });
  });

  it('never answers a degraded turn with handled:false', async () => {
    // `handled: false` restituirebbe il piano di risposta del modello, che di
    // fronte a un calendario guasto non sa di esserlo: e' il percorso da cui
    // uscirebbero orari inventati con tono sicuro.
    const harnesses = [
      {
        harness: discoveryHarness(),
        text: 'Vorrei prenotare una prima visita',
        field: 'availabilityError' as const,
      },
      { harness: confirmationHarness(), text: 'confermo 1', field: 'createError' as const },
      {
        harness: rescheduleConfirmationHarness(),
        text: 'confermo 1',
        field: 'rescheduleError' as const,
      },
    ];

    for (const entry of harnesses) {
      entry.harness.booking[entry.field] = availabilityFailure();

      const reply = await entry.harness.service.createBookingReply({
        ...baseInput(),
        text: entry.text,
      });

      expect(reply.handled).toBe(true);
      expect([
        AVAILABILITY_UNVERIFIABLE_REPLY,
        AVAILABILITY_UNVERIFIABLE_CONFIRMATION_REPLY,
      ]).toContain(reply.replyText);
    }
  });
});

function availabilityFailure(): CalendarAvailabilityUnavailable {
  return new CalendarAvailabilityUnavailable('Google Calendar freeBusy failed (429)', {
    kind: 'transient',
    httpStatus: 429,
    reason: 'freebusy_http_429',
  });
}

function bridgeAction(reply: { metadata: Record<string, unknown> }): unknown {
  const bridge = reply.metadata.bookingBridge as Record<string, unknown> | undefined;

  return bridge?.action;
}

function discoveryHarness() {
  const repository = new FakeBookingBridgeRepository([serviceOption('service_1', 'Prima visita')]);
  const booking = new FakeAppointmentBookingService();

  return {
    repository,
    booking,
    service: new BookingBridgeService(repository, booking as unknown as AppointmentBookingService),
  };
}

function confirmationHarness() {
  const harness = discoveryHarness();
  harness.repository.savedState = stateWithSlots();

  return harness;
}

function rescheduleDiscoveryHarness() {
  const harness = discoveryHarness();
  harness.repository.savedState = {
    status: 'reschedule_date_requested',
    appointment: pendingAppointment(),
    proposedAt: '2026-04-27T07:00:00.000Z',
    expiresAt: '2026-04-27T07:30:00.000Z',
  };

  return harness;
}

function rescheduleConfirmationHarness() {
  const harness = discoveryHarness();
  harness.repository.savedState = {
    status: 'reschedule_slots_proposed',
    appointment: pendingAppointment(),
    slots: [toPendingSlot(slot('2026-04-28T14:00:00.000Z', '2026-04-28T14:30:00.000Z'))],
    request: {},
    proposedAt: '2026-04-27T07:00:00.000Z',
    expiresAt: '2026-04-27T07:30:00.000Z',
  };

  return harness;
}

class FakeBookingBridgeRepository implements BookingBridgeRepository {
  clearedStates = 0;
  savedState: ConversationBookingState | null = null;
  cleared = false;
  appointments: CustomerAppointmentForBridge[] = [];

  constructor(private readonly services: BookingServiceOption[]) {}

  async getTenantTimezone(): Promise<string> {
    return 'UTC';
  }

  async listActiveServices(): Promise<BookingServiceOption[]> {
    return this.services;
  }

  async getConversationBookingState(): Promise<ConversationBookingState | null> {
    return this.savedState;
  }

  async saveConversationBookingState(input: { state: ConversationBookingState }): Promise<void> {
    this.savedState = input.state;
    this.cleared = false;
  }

  async clearConversationBookingState(): Promise<void> {
    this.savedState = null;
    this.cleared = true;
    this.clearedStates += 1;
  }

  async listCustomerAppointments(): Promise<CustomerAppointmentForBridge[]> {
    return this.appointments;
  }
}

class FakeSchedulingDecisionLedger implements SchedulingDecisionLedger {
  records: SchedulingDecisionInput[] = [];
  failure: Error | null = null;

  async record(input: SchedulingDecisionInput): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }

    this.records.push(input);
  }
}

describe('PILOT-P0-3C-i — degradazione del turno rifiutato dal fence', () => {
  // Il fence rifiuta quando il turno era partito sotto un'autorita' che nel
  // frattempo e' cambiata — nel caso che conta, perche' i dati del cliente
  // sono stati cancellati. La risposta deve essere deterministica e chiedere
  // un GESTO NUOVO: ritentare per conto proprio significherebbe riproiettare,
  // sotto l'autorita' nuova, la PII che il turno vecchio si portava dietro.

  it('asks for a new user turn instead of replaying the booking confirmation', async () => {
    const repository = new FakeBookingBridgeRepository(bridgeServices());
    repository.savedState = stateWithSlots();
    const booking = new FakeAppointmentBookingService();
    booking.createError = staleProjectionEpochError();

    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

    expect(reply.handled).toBe(true);
    expect(reply.replyText).toBe(PROJECTION_FENCE_RETRY_REPLY);
    expect(reply.metadata).toMatchObject({
      bookingBridge: { action: 'projection_fence_rejected' },
    });

    // Un solo tentativo: nessun replay automatico del turno vecchio.
    expect(booking.createCalls).toHaveLength(1);

    // E lo stato della proposta viene azzerato, cosi' il cliente non puo'
    // riconfermare uno slot che apparteneva a un turno senza autorita'.
    expect(repository.clearedStates).toBe(1);
  });

  it('never reports the fence rejection as a taken slot', async () => {
    // Entrambi sono `conflict`. Se l'ordine dei rami fosse sbagliato, il
    // cliente riceverebbe una spiegazione FALSA — "quello slot non e' piu'
    // disponibile" — di un fatto completamente diverso.
    const repository = new FakeBookingBridgeRepository(bridgeServices());
    repository.savedState = stateWithSlots();
    const booking = new FakeAppointmentBookingService();
    booking.createError = staleProjectionEpochError();

    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

    expect(reply.replyText).not.toMatch(/non risulta piu disponibile/i);
    expect(reply.metadata).not.toMatchObject({ bookingBridge: { action: 'slot_conflict' } });
  });

  it('degrades the cancellation turn too, without reporting a cancellation', async () => {
    const repository = new FakeBookingBridgeRepository(bridgeServices());
    repository.appointments = [customerAppointment({ appointmentId: 'appointment_1' })];
    const booking = new FakeAppointmentBookingService();
    booking.cancelError = staleProjectionEpochError();

    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({
      ...baseInput(),
      text: 'Annulla appuntamento',
      intent: 'cancellation_request',
    });

    expect(reply.replyText).toBe(PROJECTION_FENCE_RETRY_REPLY);
    // Non deve MAI dire "ho annullato" per un annullamento che non e' avvenuto.
    expect(reply.replyText).not.toMatch(/ho annullato/i);
  });

  it('leaks no epoch numbers to the customer', async () => {
    const repository = new FakeBookingBridgeRepository(bridgeServices());
    repository.savedState = stateWithSlots();
    const booking = new FakeAppointmentBookingService();
    booking.createError = staleProjectionEpochError();

    const service = new BookingBridgeService(
      repository,
      booking as unknown as AppointmentBookingService,
    );

    const reply = await service.createBookingReply({ ...baseInput(), text: 'confermo 1' });

    // L'epoca e' stato interno del fence: non significa niente per chi scrive,
    // e nominarla esporrebbe il ritmo delle cancellazioni del tenant.
    expect(reply.replyText).not.toMatch(/epoch|epoca|\d{2,}/i);
    expect(JSON.stringify(reply.metadata)).not.toMatch(/projectionEpoch/);
  });
});

class FakeAppointmentBookingService {
  availabilityCalls: Array<{
    tenantId: string;
    serviceId: string;
    from?: Date;
    to?: Date;
    maxSlots?: number;
    durationMinutes?: number;
    excludeAppointmentId?: string;
  }> = [];
  createCalls: CreateAppointmentInput[] = [];
  rescheduleCalls: RescheduleAppointmentInput[] = [];
  cancelCalls: CancelAppointmentInput[] = [];
  slots: BookingSlot[] = [
    slot('2026-04-28T09:00:00.000Z', '2026-04-28T09:30:00.000Z'),
    slot('2026-04-28T10:00:00.000Z', '2026-04-28T10:30:00.000Z'),
    slot('2026-04-28T11:00:00.000Z', '2026-04-28T11:30:00.000Z'),
  ];
  availabilityError: Error | null = null;
  createError: Error | null = null;
  rescheduleError: Error | null = null;

  async getAvailableSlots(input: {
    tenantId: string;
    serviceId: string;
    from?: Date;
    to?: Date;
    maxSlots?: number;
    durationMinutes?: number;
    excludeAppointmentId?: string;
  }): Promise<BookingSlot[]> {
    this.availabilityCalls.push(input);

    if (this.availabilityError) {
      throw this.availabilityError;
    }

    return this.slots;
  }

  async createAppointment(input: CreateAppointmentInput): Promise<{ appointmentId: string }> {
    this.createCalls.push(input);

    if (this.createError) {
      throw this.createError;
    }

    return { appointmentId: 'appointment_1' };
  }

  async rescheduleAppointment(
    input: RescheduleAppointmentInput,
  ): Promise<{ appointmentId: string }> {
    this.rescheduleCalls.push(input);

    if (this.rescheduleError) {
      throw this.rescheduleError;
    }

    return { appointmentId: input.appointmentId };
  }

  cancelError: Error | null = null;

  async cancelAppointment(input: CancelAppointmentInput): Promise<{ appointmentId: string }> {
    this.cancelCalls.push(input);

    if (this.cancelError) {
      throw this.cancelError;
    }

    return { appointmentId: input.appointmentId };
  }
}

function baseInput() {
  return {
    tenantId: 'tenant_1',
    // Epoca catturata al confine del turno WhatsApp. Il servizio finto sotto
    // vive sulla stessa epoca: e' il caso normale, quello in cui l'autorita'
    // non e' cambiata durante il turno.
    expectedProjectionEpoch: TURN_EPOCH,
    conversationId: 'conversation_1',
    customerIdentifier: '393331112233',
    customerName: null,
    text: 'Vorrei prenotare',
    occurredAt,
  };
}

function serviceOption(id: string, name: string): BookingServiceOption {
  return {
    id,
    name,
    durationMinutes: 30,
    priceCents: null,
  };
}

function bridgeServices(): BookingServiceOption[] {
  return [serviceOption('service_1', 'Prima visita')];
}

function stateWithSlots(): ConversationBookingState {
  return {
    status: 'slots_proposed',
    serviceId: 'service_1',
    serviceName: 'Prima visita',
    proposedAt: '2026-04-27T07:00:00.000Z',
    expiresAt: '2026-04-27T07:30:00.000Z',
    slots: [
      toPendingSlot(slot('2026-04-28T09:00:00.000Z', '2026-04-28T09:30:00.000Z')),
      toPendingSlot(slot('2026-04-28T10:00:00.000Z', '2026-04-28T10:30:00.000Z')),
      toPendingSlot(slot('2026-04-28T11:00:00.000Z', '2026-04-28T11:30:00.000Z')),
    ],
  };
}

function slot(start: string, end: string): BookingSlot {
  return {
    tenantId: 'tenant_1',
    serviceId: 'service_1',
    serviceName: 'Prima visita',
    start,
    end,
    durationMinutes: 30,
    timezone: 'UTC',
  };
}

function toPendingSlot(slotInput: BookingSlot) {
  return {
    serviceId: slotInput.serviceId,
    serviceName: slotInput.serviceName,
    start: slotInput.start,
    end: slotInput.end,
    durationMinutes: slotInput.durationMinutes,
    timezone: slotInput.timezone,
  };
}

function customerAppointment(
  overrides: Partial<CustomerAppointmentForBridge> = {},
): CustomerAppointmentForBridge {
  return {
    appointmentId: 'appointment_1',
    serviceId: 'service_1',
    serviceName: 'Prima visita',
    customerName: 'Mario Rossi',
    scheduledAt: new Date('2026-04-28T09:00:00.000Z'),
    durationMinutes: 30,
    ...overrides,
  };
}

function pendingAppointment() {
  return {
    appointmentId: 'appointment_1',
    serviceId: 'service_1',
    serviceName: 'Prima visita',
    customerName: 'Mario Rossi',
    scheduledAt: '2026-04-28T09:00:00.000Z',
    durationMinutes: 30,
    timezone: 'UTC',
  };
}

function savedSlots(repository: FakeBookingBridgeRepository) {
  return repository.savedState?.status === 'slots_proposed' ? repository.savedState.slots : [];
}
