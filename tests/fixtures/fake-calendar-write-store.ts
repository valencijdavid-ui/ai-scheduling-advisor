// PILOT-P0-3C-i — autorita' di scrittura in memoria.
//
// Non e' uno stub che registra chiamate. Modella le proprieta' da cui dipende
// tutto il contratto di C-i, perche' un fake che le semplificasse renderebbe
// i test ciechi proprio sulle distinzioni che devono dimostrare:
//
//   - il fence: epoca del tenant confrontata con quella catturata dal turno
//   - `calendar_desired_version`, incrementata dalle mutazioni autorevoli
//   - `calendar_write_generation`, allocata insieme all'intento
//   - il ciclo di vita dell'intento, che sopravvive alla riga
//   - gli esiti TIPIZZATI del settle, zero righe compreso
//   - il bersaglio di calendario e il suo valore di prova
//
// In particolare il settle applica il CAS vero: se epoca, versione desiderata
// o generazione non combaciano, NON scrive niente e lo dice.

import type {
  CalendarSettleResult,
  CalendarSyncStatus,
  CalendarWriteIntentState,
  CalendarWriteOperation,
  CalendarWriteStore,
  CancelAppointmentGuardedInput,
  CancelAppointmentGuardedResult,
  CreateAppointmentWithIntentInput,
  CreateAppointmentWithIntentResult,
  OpenCalendarWriteIntentInput,
  OpenCalendarWriteIntentResult,
  RescheduleAppointmentGuardedInput,
  RescheduleAppointmentGuardedResult,
  SettleCalendarWriteInput,
} from '@/server/appointments/calendar-write-intents';

export type FakeStoredAppointment = {
  id: string;
  tenantId: string;
  conversationId: string | null;
  serviceId: string | null;
  serviceName: string | null;
  customerIdentifier: string;
  customerName: string;
  customerPhone: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  calendarProvider: 'google_calendar' | null;
  calendarSyncStatus: CalendarSyncStatus;
  calendarEventId: string | null;
  calendarEventCalendarId: string | null;
  calendarEventHtmlLink: string | null;
  notes: string | null;
  calendarSyncError: string | null;
  calendarSyncAttempts: number;
  calendarSyncNextAttemptAt: Date | null;
  calendarSyncLastAttemptAt: Date | null;
  desiredVersion: number;
  writeGeneration: number;
};

export type FakeIntent = {
  id: string;
  tenantId: string;
  appointmentId: string;
  operation: CalendarWriteOperation;
  state: CalendarWriteIntentState;
  writeGeneration: number;
  desiredVersion: number;
  calendarId: string | null;
  identitySource: string;
  externalEventId: string | null;
  errorCode: string | null;
  evidence: string | null;
};

export class FakeCalendarWriteStore implements CalendarWriteStore {
  /** Epoca corrente del tenant. Una cancellazione la incrementa. */
  projectionEpoch = 0;
  /** `false` modella un tenant sparito: il fence non trova autorita'. */
  tenantPresent = true;

  /**
   * Il vincolo di esclusione di P0-7A, modellato come interruttore.
   *
   * Riprodurre l'algebra degli intervalli qui non proverebbe niente in piu':
   * il comportamento vero e' dimostrato su PostgreSQL reale. Qui serve solo
   * che il chiamante veda un `slot_conflict`.
   */
  slotConflict = false;

  readonly rows: Map<string, FakeStoredAppointment>;
  readonly intents: FakeIntent[] = [];
  /** Input ricevuti, per le asserzioni che guardano cosa e' stato chiesto. */
  readonly createInputs: CreateAppointmentWithIntentInput[] = [];
  readonly rescheduleInputs: RescheduleAppointmentGuardedInput[] = [];
  readonly cancelInputs: CancelAppointmentGuardedInput[] = [];
  readonly openedIntents: OpenCalendarWriteIntentInput[] = [];
  readonly settles: SettleCalendarWriteInput[] = [];
  readonly settleOutcomes: CalendarSettleResult[] = [];
  /** Ordine delle scritture autorevoli, per asserire la causalita'. */
  readonly writeOrder: string[];

  /** Innesti per far accadere qualcosa DENTRO la finestra di corsa. */
  beforeCreate: (() => void | Promise<void>) | null = null;
  beforeReschedule: (() => Promise<void>) | null = null;
  beforeCancel: (() => Promise<void>) | null = null;
  beforeSettle: (() => Promise<void>) | null = null;

  private nextIntentSeq = 1;

  constructor(rows: Map<string, FakeStoredAppointment> = new Map(), writeOrder: string[] = []) {
    this.rows = rows;
    this.writeOrder = writeOrder;
  }

  row(appointmentId: string): FakeStoredAppointment | undefined {
    return this.rows.get(appointmentId);
  }

  intent(intentId: string): FakeIntent {
    const found = this.intents.find((candidate) => candidate.id === intentId);

    if (!found) {
      throw new Error(`intent ${intentId} not found`);
    }

    return found;
  }

  /** Intenti mai risolti: l'evidenza che C-ii dovra' spazzare. */
  unresolvedIntents(): FakeIntent[] {
    return this.intents.filter((intent) => intent.state === 'in_flight');
  }

  // -------------------------------------------------------------------------
  // Mutazioni autorevoli
  // -------------------------------------------------------------------------

  async createAppointmentWithIntent(
    input: CreateAppointmentWithIntentInput,
  ): Promise<CreateAppointmentWithIntentResult> {
    this.createInputs.push(input);

    // La corsa si fa cadere QUI: fra la cattura dell'epoca da parte del turno
    // e il fence sotto lock. E' la finestra della matrice R1.
    await this.beforeCreate?.();

    const fenced = this.checkFence(input.expectedProjectionEpoch);

    if (fenced) {
      return fenced;
    }

    if (this.slotConflict) {
      // Riga e intento vivono nella stessa transazione: perdono insieme, e non
      // resta nessun intento orfano.
      this.writeOrder.push('create_slot_conflict');

      return { outcome: 'slot_conflict' };
    }

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
      calendarEventCalendarId: null,
      calendarEventHtmlLink: null,
      notes: input.notes,
      calendarSyncError: null,
      calendarSyncAttempts: 0,
      calendarSyncNextAttemptAt: input.calendarSyncNextAttemptAt,
      calendarSyncLastAttemptAt: null,
      desiredVersion: 0,
      writeGeneration: 1,
    });

    const hasCalendarIntent =
      input.calendarProvider === 'google_calendar' && input.calendarEventId !== null;
    const intent = hasCalendarIntent
      ? this.recordIntent({
          tenantId: input.tenantId,
          appointmentId: input.id,
          operation: 'create',
          desiredVersion: 0,
          writeGeneration: 1,
          calendarId: input.target?.calendarId ?? null,
          identitySource: input.target?.identitySource ?? 'unknown',
          externalEventId: input.calendarEventId,
        })
      : null;

    return {
      outcome: 'created',
      appointmentId: input.id,
      tenantId: input.tenantId,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      calendarSyncStatus: input.calendarSyncStatus,
      calendarEventId: input.calendarEventId,
      calendarEventHtmlLink: null,
      intentId: intent?.id ?? null,
      projectionEpoch: this.projectionEpoch,
      desiredVersion: 0,
      writeGeneration: 1,
    };
  }

  async rescheduleGuarded(
    input: RescheduleAppointmentGuardedInput,
  ): Promise<RescheduleAppointmentGuardedResult> {
    this.rescheduleInputs.push(input);

    await this.beforeReschedule?.();

    const fenced = this.checkFence(input.expectedProjectionEpoch);

    if (fenced) {
      return fenced;
    }

    if (this.slotConflict) {
      return { outcome: 'slot_conflict' };
    }

    const row = this.rows.get(input.appointmentId);

    // Il filtro `status = 'confirmed'` del SQL reale.
    if (!row || row.tenantId !== input.tenantId || row.status !== 'confirmed') {
      this.writeOrder.push('reschedule_not_confirmed');

      return { outcome: 'not_confirmed' };
    }

    this.writeOrder.push('reschedule');
    row.scheduledAt = input.scheduledAt;
    row.durationMinutes = input.durationMinutes;
    row.notes = input.notes;
    row.calendarProvider = input.calendarProvider;
    row.calendarSyncStatus = input.calendarSyncStatus;
    row.calendarSyncError = null;
    row.calendarSyncAttempts = 0;
    row.calendarSyncNextAttemptAt = input.calendarSyncNextAttemptAt;
    row.desiredVersion += 1;

    return {
      outcome: 'rescheduled',
      desiredVersion: row.desiredVersion,
      projectionEpoch: this.projectionEpoch,
    };
  }

  async cancelGuarded(
    input: CancelAppointmentGuardedInput,
  ): Promise<CancelAppointmentGuardedResult> {
    this.cancelInputs.push(input);

    await this.beforeCancel?.();

    const fenced = this.checkFence(input.expectedProjectionEpoch);

    if (fenced) {
      return fenced;
    }

    const row = this.rows.get(input.appointmentId);

    if (!row || row.tenantId !== input.tenantId || row.status !== 'confirmed') {
      // C3. Zero righe e' un esito, non un silenzio: il chiamante non ha
      // nessuna autorita' sull'evento remoto e non deve contattare Google.
      this.writeOrder.push('cancel_not_confirmed');

      return { outcome: 'not_confirmed' };
    }

    this.writeOrder.push('cancel');
    row.status = 'cancelled';
    row.calendarSyncStatus = input.calendarSyncStatus;
    row.calendarSyncError = null;
    row.calendarSyncAttempts = 0;
    row.calendarSyncNextAttemptAt = input.calendarSyncNextAttemptAt;
    row.desiredVersion += 1;

    return {
      outcome: 'cancelled',
      desiredVersion: row.desiredVersion,
      projectionEpoch: this.projectionEpoch,
    };
  }

  // -------------------------------------------------------------------------
  // Intento e settle
  // -------------------------------------------------------------------------

  async openIntent(input: OpenCalendarWriteIntentInput): Promise<OpenCalendarWriteIntentResult> {
    this.openedIntents.push(input);

    const fenced = this.checkFence(input.expectedProjectionEpoch);

    if (fenced) {
      return fenced;
    }

    const row = this.rows.get(input.appointmentId);

    if (!row || row.tenantId !== input.tenantId) {
      return { outcome: 'appointment_gone' };
    }

    if (row.desiredVersion !== input.expectedDesiredVersion) {
      return { outcome: 'desired_version_changed', observed: row.desiredVersion };
    }

    // La generazione si alloca INSIEME all'intento: e' cio' che impedisce a un
    // vecchio scrittore di far passare il proprio esito dopo uno piu' recente.
    row.writeGeneration += 1;

    const intent = this.recordIntent({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      operation: input.operation,
      desiredVersion: row.desiredVersion,
      writeGeneration: row.writeGeneration,
      calendarId: input.target?.calendarId ?? null,
      identitySource: input.target?.identitySource ?? 'unknown',
      externalEventId: input.externalEventId,
    });

    this.writeOrder.push(`intent_${input.operation}`);

    return {
      outcome: 'opened',
      intentId: intent.id,
      projectionEpoch: this.projectionEpoch,
      desiredVersion: row.desiredVersion,
      writeGeneration: row.writeGeneration,
    };
  }

  async settle(input: SettleCalendarWriteInput): Promise<CalendarSettleResult> {
    await this.beforeSettle?.();

    this.settles.push(input);

    const row = this.rows.get(input.appointmentId);
    const result = this.settleInto(row, input);

    this.settleOutcomes.push(result);
    this.writeOrder.push(`settle_${result.outcome}`);

    return result;
  }

  private settleInto(
    row: FakeStoredAppointment | undefined,
    input: SettleCalendarWriteInput,
  ): CalendarSettleResult {
    const markIntent = (state: CalendarWriteIntentState): void => {
      if (!input.intentId) {
        return;
      }

      const intent = this.intents.find((candidate) => candidate.id === input.intentId);

      if (intent) {
        intent.state = state;
        intent.errorCode = input.intentErrorCode ?? null;
        intent.evidence = input.remoteEvidence ?? null;
      }
    };

    if (!this.tenantPresent) {
      return this.rejected('tenant_gone', null);
    }

    if (this.projectionEpoch !== input.expectedProjectionEpoch) {
      // La proiezione e' avanzata: questo esito appartiene a un'autorita' che
      // non c'e' piu'.
      return this.rejected('projection_epoch_advanced', null, this.projectionEpoch);
    }

    if (!row || row.tenantId !== input.tenantId) {
      // L'appuntamento e' sparito sotto lo scrittore. L'intento resta come
      // evidenza: e' precisamente cio' che C-ii dovra' trovare.
      markIntent(input.intentState ?? 'settled');

      return this.rejected('appointment_gone', null);
    }

    if (row.desiredVersion !== input.expectedDesiredVersion) {
      markIntent(input.intentState ?? 'settled');

      // C2. Lo stato desiderato e' andato avanti: questo risultato NON deve
      // scrivere niente, e la proiezione corrente torna eleggibile.
      row.calendarSyncNextAttemptAt = row.calendarSyncNextAttemptAt ?? input.lastAttemptAt;

      return {
        outcome: 'desired_version_changed',
        observedDesiredVersion: row.desiredVersion,
        observedWriteGeneration: row.writeGeneration,
        observedProjectionEpoch: this.projectionEpoch,
        reconvergenceMarked: true,
      };
    }

    if (row.writeGeneration !== input.expectedWriteGeneration) {
      markIntent(input.intentState ?? 'settled');
      row.calendarSyncNextAttemptAt = row.calendarSyncNextAttemptAt ?? input.lastAttemptAt;

      return {
        outcome: 'write_generation_changed',
        observedDesiredVersion: row.desiredVersion,
        observedWriteGeneration: row.writeGeneration,
        observedProjectionEpoch: this.projectionEpoch,
        reconvergenceMarked: true,
      };
    }

    // Da qui in poi lo scrittore e' quello corrente: puo' scrivere.
    row.calendarSyncStatus = input.calendarSyncStatus;
    row.calendarSyncError = input.errorMessage;
    row.calendarSyncAttempts = input.attempts;
    row.calendarSyncNextAttemptAt = input.nextAttemptAt;
    row.calendarSyncLastAttemptAt = input.lastAttemptAt;

    // Identita' e provenienza si scrivono solo se passate: un fallimento non
    // le passa mai, e non puo' quindi cancellare il puntatore all'evento.
    if (input.eventId !== undefined) {
      row.calendarEventId = input.eventId;
    }

    if (input.eventCalendarId !== undefined) {
      row.calendarEventCalendarId = input.eventCalendarId;
    }

    if (input.htmlLink !== undefined) {
      row.calendarEventHtmlLink = input.htmlLink;
    }

    markIntent(input.intentState ?? 'settled');

    return {
      outcome: 'settled_current',
      observedDesiredVersion: row.desiredVersion,
      observedWriteGeneration: row.writeGeneration,
      observedProjectionEpoch: this.projectionEpoch,
      reconvergenceMarked: false,
    };
  }

  private rejected(
    outcome: CalendarSettleResult['outcome'],
    observed: number | null,
    epoch: number | null = null,
  ): CalendarSettleResult {
    return {
      outcome,
      observedDesiredVersion: observed,
      observedWriteGeneration: observed,
      observedProjectionEpoch: epoch,
      reconvergenceMarked: false,
    };
  }

  private checkFence(
    expectedProjectionEpoch: number,
  ): { outcome: 'tenant_gone' } | { outcome: 'stale_projection_epoch' } | null {
    if (!this.tenantPresent) {
      return { outcome: 'tenant_gone' };
    }

    return this.projectionEpoch === expectedProjectionEpoch
      ? null
      : { outcome: 'stale_projection_epoch' };
  }

  private recordIntent(input: {
    tenantId: string;
    appointmentId: string;
    operation: CalendarWriteOperation;
    desiredVersion: number;
    writeGeneration: number;
    calendarId: string | null;
    identitySource: string;
    externalEventId: string | null;
  }): FakeIntent {
    const intent: FakeIntent = {
      id: `intent_${this.nextIntentSeq++}`,
      state: 'in_flight',
      errorCode: null,
      evidence: null,
      ...input,
    };

    this.intents.push(intent);

    return intent;
  }
}
