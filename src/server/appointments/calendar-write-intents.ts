// PILOT-P0-3C-i — intenti di scrittura durevoli e settle unificato.
//
// Il contratto che questo modulo rende eseguibile:
//
//   INTENTO DUREVOLE COMMITTATO -> MUTAZIONE REMOTA -> SETTLE CONDIZIONALE
//
// Prima di qui esistevano DUE settle — uno nel repository di booking, uno in
// quello del reconciler — e nessuno dei due sapeva di aver toccato zero righe.
// Un UPDATE che non trova niente non e' un errore per Postgres, e non lo era
// nemmeno per il chiamante: zero righe e una riga erano lo stesso `undefined`.
// Da quel silenzio nascevano tre difetti distinti (C1, C2, C7), e ognuno
// veniva "risolto" nell'unico modo che il silenzio permette, cioe' credendo
// al risultato.
//
// Qui l'autorita' semantica e' UNA e vive nel database. Questo file e' il
// confine tipizzato verso quella primitiva: traduce, valida con Zod cio' che
// torna, e non aggiunge nessuna politica propria. La politica resta del
// chiamante — il booking inline e il reconciler ne hanno di diverse — ma il
// significato di "questo esito e' stato registrato" e' lo stesso per entrambi.

import { z } from 'zod';

import { AppError } from '@/lib/errors/app-error';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  googleStatusOf,
  type CalendarConvergenceAction,
} from '@/server/appointments/calendar-convergence';

/** Mutazione remota che l'intento autorizza. */
export type CalendarWriteOperation = 'create' | 'update' | 'delete';

/**
 * Stato di un intento.
 *
 * Le distinzioni qui non sono sfumature di uno stesso "fallito":
 *
 *   in_flight          committato, esito remoto ignoto. Un crash lascia QUI,
 *                      ed e' l'unica affermazione onesta possibile.
 *   settled            l'esito remoto e' stato osservato e registrato.
 *   unknown_outcome    timeout o guasto di trasporto DOPO una possibile
 *                      trasmissione. NON e' un fallimento: e' ignoranza.
 *   no_remote_mutation nessuna mutazione e' partita (Google ha risposto con
 *                      uno status, oppure il guasto e' caduto su una lettura).
 *   manual_required    serve un operatore.
 */
export type CalendarWriteIntentState =
  | 'in_flight'
  | 'settled'
  | 'unknown_outcome'
  | 'no_remote_mutation'
  | 'manual_required';

/**
 * Prova positiva raccolta sul calendario bersaglio.
 *
 * `absent_on_target` e' deliberatamente distinto da `write_confirmed`: un 404
 * dice "non l'ho trovato QUI", non "non esiste". Confonderli e' il difetto C6,
 * e conservarne la differenza e' cio' che permettera' a P0-3C-iii di decidere
 * senza riprogettare il provider.
 */
export type CalendarRemoteEvidence =
  | 'none'
  | 'event_observed'
  | 'write_confirmed'
  | 'absent_on_target';

/**
 * Quanto vale come prova il calendario che stiamo per contattare.
 *
 * `current_config` e' un'IPOTESI: la configurazione corrente dell'integrazione
 * non e' verita' storica, e un tenant che ha cambiato calendario la rende
 * falsa. Solo un'osservazione remota positiva puo' promuoverla.
 */
export type CalendarIdentitySource = 'stored_provenance' | 'current_config' | 'unknown';

/** Bersaglio esplicito di una operazione remota, con il suo valore di prova. */
export type CalendarTarget = {
  calendarId: string;
  identitySource: CalendarIdentitySource;
};

/**
 * Autorizzazione a mutare l'evento remoto.
 *
 * Solo la `writeGeneration` restituita qui puo' fare settle sulla riga: una
 * generazione piu' vecchia non puo' MAI sovrascrivere una piu' recente.
 */
export type CalendarWriteAuthorization = {
  intentId: string;
  projectionEpoch: number;
  desiredVersion: number;
  writeGeneration: number;
};

export type OpenCalendarWriteIntentInput = {
  tenantId: string;
  appointmentId: string;
  expectedProjectionEpoch: number;
  expectedDesiredVersion: number;
  operation: CalendarWriteOperation;
  target: CalendarTarget | null;
  externalEventId: string | null;
};

export type OpenCalendarWriteIntentResult =
  | ({ outcome: 'opened' } & CalendarWriteAuthorization)
  | { outcome: 'tenant_gone' }
  | { outcome: 'stale_projection_epoch' }
  | { outcome: 'appointment_gone' }
  | { outcome: 'desired_version_changed'; observed: number };

/**
 * Esiti TIPIZZATI del settle.
 *
 * Zero righe non e' mai un successo generico. Ognuno di questi e' un fatto
 * diverso, e i chiamanti ne fanno cose diverse.
 */
export type CalendarSettleOutcome =
  | 'settled_current'
  | 'appointment_gone'
  | 'desired_version_changed'
  | 'write_generation_changed'
  | 'projection_epoch_advanced'
  | 'tenant_gone';

export type CalendarSettleResult = {
  outcome: CalendarSettleOutcome;
  observedDesiredVersion: number | null;
  observedWriteGeneration: number | null;
  observedProjectionEpoch: number | null;
  /** `true` se la proiezione CORRENTE e' stata resa di nuovo eleggibile. */
  reconvergenceMarked: boolean;
};

export type SettleCalendarWriteInput = {
  tenantId: string;
  appointmentId: string;
  expectedProjectionEpoch: number;
  expectedDesiredVersion: number;
  expectedWriteGeneration: number;
  calendarSyncStatus: 'not_configured' | 'pending' | 'synced' | 'failed';
  errorMessage: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date;
  /** Scritto solo se passato: un esito di fallimento non azzera l'identita'. */
  eventId?: string;
  /** Provenienza VERIFICATA, mai la configurazione corrente riletta dopo. */
  eventCalendarId?: string;
  /** `undefined` = non toccare; `null` = azzerare esplicitamente. */
  htmlLink?: string | null;
  intentId?: string | null;
  intentState?: CalendarWriteIntentState;
  intentErrorCode?: string | null;
  remoteEvidence?: CalendarRemoteEvidence;
};

/**
 * Stato di sincronizzazione della proiezione, come lo conosce la riga.
 */
export type CalendarSyncStatus = 'not_configured' | 'pending' | 'synced' | 'failed';

export type CreateAppointmentWithIntentInput = {
  id: string;
  tenantId: string;
  /** Epoca CATTURATA PRESTO, al confine del turno. Mai riletta qui. */
  expectedProjectionEpoch: number;
  conversationId: string | null;
  serviceId: string | null;
  serviceName: string;
  customerIdentifier: string;
  customerName: string;
  customerPhone: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  notes: string | null;
  bookingSource: string;
  calendarProvider: 'google_calendar' | null;
  calendarSyncStatus: CalendarSyncStatus;
  /** Id deterministico dell'evento, deciso PRIMA di contattare Google. */
  calendarEventId: string | null;
  calendarSyncNextAttemptAt: Date | null;
  target: CalendarTarget | null;
};

export type CreatedAppointmentWithIntent = {
  outcome: 'created';
  appointmentId: string;
  tenantId: string;
  scheduledAt: Date;
  durationMinutes: number;
  calendarSyncStatus: CalendarSyncStatus;
  calendarEventId: string | null;
  calendarEventHtmlLink: string | null;
  /** Null when no remote calendar mutation was authorized. */
  intentId: string | null;
  projectionEpoch: number;
  desiredVersion: number;
  writeGeneration: number;
};

/**
 * `slot_conflict` e' l'esito del vincolo di esclusione riparato da P0-7A.
 *
 * E' un fatto di DOMINIO — lo slot e' stato preso da qualcun altro mentre
 * questa transazione era in volo — e va tenuto distinto sia da un guasto
 * d'infrastruttura sia da un rifiuto del fence. Confonderlo con
 * `stale_projection_epoch` direbbe al cliente di ricominciare per un motivo
 * che non e' successo; confonderlo con un guasto lo manderebbe in un retry
 * che non potra' mai riuscire.
 *
 * L'insert e l'intento vivono nella STESSA transazione: se l'insert perde la
 * corsa, l'intento non resta indietro. Nessun intento orfano.
 */
export type CreateAppointmentWithIntentResult =
  | CreatedAppointmentWithIntent
  | { outcome: 'tenant_gone' }
  | { outcome: 'stale_projection_epoch' }
  | { outcome: 'slot_conflict' };

export type RescheduleAppointmentGuardedInput = {
  tenantId: string;
  appointmentId: string;
  expectedProjectionEpoch: number;
  scheduledAt: Date;
  durationMinutes: number;
  notes: string | null;
  calendarProvider: 'google_calendar' | null;
  calendarSyncStatus: CalendarSyncStatus;
  calendarSyncNextAttemptAt: Date | null;
};

/**
 * `not_confirmed` e' zero righe TIPIZZATO.
 *
 * L'UPDATE filtra su `status = 'confirmed'`: se non trova niente, la riga e'
 * sparita o non e' piu' confermata. Per l'annullamento questo esito e'
 * load-bearing (C3): il chiamante NON puo' proseguire verso Google, perche'
 * non ha nessuna autorita' su quell'evento.
 */
export type RescheduleAppointmentGuardedResult =
  | { outcome: 'rescheduled'; desiredVersion: number; projectionEpoch: number }
  | { outcome: 'tenant_gone' }
  | { outcome: 'stale_projection_epoch' }
  | { outcome: 'not_confirmed' }
  | { outcome: 'slot_conflict' };

export type CancelAppointmentGuardedInput = {
  tenantId: string;
  appointmentId: string;
  expectedProjectionEpoch: number;
  calendarSyncStatus: CalendarSyncStatus;
  calendarSyncNextAttemptAt: Date | null;
};

export type CancelAppointmentGuardedResult =
  | { outcome: 'cancelled'; desiredVersion: number; projectionEpoch: number }
  | { outcome: 'tenant_gone' }
  | { outcome: 'stale_projection_epoch' }
  | { outcome: 'not_confirmed' };

export interface CalendarWriteStore {
  createAppointmentWithIntent(
    input: CreateAppointmentWithIntentInput,
  ): Promise<CreateAppointmentWithIntentResult>;
  rescheduleGuarded(
    input: RescheduleAppointmentGuardedInput,
  ): Promise<RescheduleAppointmentGuardedResult>;
  cancelGuarded(input: CancelAppointmentGuardedInput): Promise<CancelAppointmentGuardedResult>;
  openIntent(input: OpenCalendarWriteIntentInput): Promise<OpenCalendarWriteIntentResult>;
  settle(input: SettleCalendarWriteInput): Promise<CalendarSettleResult>;
}

const SyncStatusSchema = z.enum(['not_configured', 'pending', 'synced', 'failed']);

const CreateRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    appointmentId: z.string(),
    tenantId: z.string(),
    scheduledAt: z.string(),
    durationMinutes: z.number(),
    calendarSyncStatus: SyncStatusSchema,
    calendarEventId: z.string().nullable(),
    calendarEventHtmlLink: z.string().nullable(),
    projectionEpoch: z.number(),
    desiredVersion: z.number(),
    writeGeneration: z.number(),
    // A local-only appointment has no remote mutation to authorize, therefore
    // the SQL primitive correctly returns a null intent id.
    intentId: z.string().nullable(),
  }),
  z.object({ outcome: z.literal('tenant_gone') }),
  z.object({
    outcome: z.literal('stale_projection_epoch'),
    expected: z.number(),
    observed: z.number(),
  }),
]);

const RescheduleRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('rescheduled'),
    desiredVersion: z.number(),
    projectionEpoch: z.number(),
  }),
  z.object({ outcome: z.literal('tenant_gone') }),
  z.object({
    outcome: z.literal('stale_projection_epoch'),
    expected: z.number(),
    observed: z.number(),
  }),
  z.object({ outcome: z.literal('not_confirmed') }),
]);

const CancelRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('cancelled'),
    desiredVersion: z.number(),
    projectionEpoch: z.number(),
  }),
  z.object({ outcome: z.literal('tenant_gone') }),
  z.object({
    outcome: z.literal('stale_projection_epoch'),
    expected: z.number(),
    observed: z.number(),
  }),
  z.object({ outcome: z.literal('not_confirmed') }),
]);

/**
 * Violazione del vincolo di esclusione riparato da P0-7A, o della chiave unica.
 *
 * Riconosciuta sul CODICE Postgres e non sul messaggio: il testo di un
 * vincolo cambia, il codice no. Resta identica alla classificazione che il
 * booking gia' applicava agli stessi due codici — C-i non la riscrive, la
 * porta dentro il confine tipizzato.
 */
function isSlotConflict(error: { code?: string } | null): boolean {
  return error?.code === '23P01' || error?.code === '23505';
}

const OpenIntentRowSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('opened'),
    intentId: z.string(),
    projectionEpoch: z.number(),
    desiredVersion: z.number(),
    writeGeneration: z.number(),
  }),
  z.object({ outcome: z.literal('tenant_gone') }),
  z.object({
    outcome: z.literal('stale_projection_epoch'),
    expected: z.number(),
    observed: z.number(),
  }),
  z.object({ outcome: z.literal('appointment_gone') }),
  z.object({
    outcome: z.literal('desired_version_changed'),
    expected: z.number(),
    observed: z.number(),
  }),
]);

const SettleRowSchema = z.object({
  outcome: z.enum([
    'settled_current',
    'appointment_gone',
    'desired_version_changed',
    'write_generation_changed',
    'projection_epoch_advanced',
    'tenant_gone',
  ]),
  observedDesiredVersion: z.number().nullable(),
  observedWriteGeneration: z.number().nullable(),
  observedProjectionEpoch: z.number().nullable(),
  reconvergenceMarked: z.boolean(),
});

/**
 * Codice di errore ammesso su `calendar_write_intents.last_error_code`.
 *
 * Il vincolo esiste nel database ed e' quello che conta; questa funzione
 * evita che una violazione arrivi fin li' sotto forma di transazione abortita.
 * La regola e' la stessa: un CODICE, non il corpo della risposta di Google —
 * che contiene il telefono del cliente dentro extendedProperties.
 */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function toBoundedIntentErrorCode(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  return ERROR_CODE_PATTERN.test(trimmed) ? trimmed : 'unclassified';
}

/**
 * Argomenti di CAS del settle, derivati dall'autorizzazione.
 *
 * Sono i quattro valori che decidono se questo scrittore ha ancora il diritto
 * di scrivere: epoca, versione desiderata, generazione e identita' dell'intento.
 * Derivarli tutti insieme da un solo oggetto e' cio' che impedisce di
 * aggiornarne uno e dimenticarne un altro — e la ragione per cui questa
 * funzione vive qui e non duplicata nei due chiamanti.
 */
export function casFor(authorization: CalendarWriteAuthorization): {
  expectedProjectionEpoch: number;
  expectedDesiredVersion: number;
  expectedWriteGeneration: number;
  intentId: string;
} {
  return {
    expectedProjectionEpoch: authorization.projectionEpoch,
    expectedDesiredVersion: authorization.desiredVersion,
    expectedWriteGeneration: authorization.writeGeneration,
    intentId: authorization.intentId,
  };
}

/**
 * Prova raccolta sul calendario bersaglio, dedotta dall'azione compiuta.
 *
 * `already_absent` resta separato: e' l'unico esito che NON dimostra dove
 * l'evento viva, ed e' esattamente quello che produce un 404 al calendario
 * sbagliato.
 */
export function evidenceForAction(action: CalendarConvergenceAction): CalendarRemoteEvidence {
  switch (action) {
    case 'inserted':
    case 'patched':
    case 'deleted':
      return 'write_confirmed';
    case 'already_absent':
      return 'absent_on_target';
    case 'unchanged':
      return 'event_observed';
  }
}

/**
 * Codice di errore per l'intento.
 *
 * Un CODICE, mai il corpo della risposta di Google: dentro
 * `extendedProperties` c'e' il telefono del cliente, e `calendar_write_intents`
 * esiste anche per NON essere un secondo posto dove quella PII sopravvive.
 */
export function calendarWriteErrorCode(error: unknown): string {
  const status = googleStatusOf(error);

  if (status !== null) {
    return `google_http_${status}`;
  }

  return error instanceof AppError ? `app_${error.code}` : 'unclassified';
}

/** Client Supabase minimo usato qui: solo `rpc`. Iniettabile nei test. */
export type CalendarWriteRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

export class SupabaseCalendarWriteStore implements CalendarWriteStore {
  private readonly supabase: CalendarWriteRpcClient;

  constructor(client?: CalendarWriteRpcClient) {
    this.supabase = client ?? (createSupabaseAdminClient() as unknown as CalendarWriteRpcClient);
  }

  async createAppointmentWithIntent(
    input: CreateAppointmentWithIntentInput,
  ): Promise<CreateAppointmentWithIntentResult> {
    const { data, error } = await this.supabase.rpc('create_appointment_with_calendar_intent', {
      p_id: input.id,
      p_tenant_id: input.tenantId,
      p_expected_projection_epoch: input.expectedProjectionEpoch,
      p_conversation_id: input.conversationId,
      p_service_id: input.serviceId,
      p_service_name: input.serviceName,
      p_customer_identifier: input.customerIdentifier,
      p_customer_name: input.customerName,
      p_customer_phone: input.customerPhone,
      p_scheduled_at: input.scheduledAt.toISOString(),
      p_duration_minutes: input.durationMinutes,
      p_notes: input.notes,
      p_booking_source: input.bookingSource,
      p_calendar_provider: input.calendarProvider,
      p_calendar_sync_status: input.calendarSyncStatus,
      p_calendar_event_id: input.calendarEventId,
      p_calendar_sync_next_attempt_at: input.calendarSyncNextAttemptAt?.toISOString() ?? null,
      p_calendar_target: input.target?.calendarId ?? null,
      p_calendar_identity_source: input.target?.identitySource ?? 'unknown',
    });

    if (error) {
      // Lo slot preso da qualcun altro e' un esito, non un guasto. L'insert e
      // l'intento erano nella stessa transazione: hanno perso insieme.
      if (isSlotConflict(error)) {
        return { outcome: 'slot_conflict' };
      }

      throw new AppError('upstream_error', 'Failed to create the appointment', {
        cause: error,
        expose: false,
      });
    }

    const parsed = CreateRowSchema.parse(data);

    if (parsed.outcome !== 'created') {
      return parsed.outcome === 'stale_projection_epoch'
        ? { outcome: 'stale_projection_epoch' }
        : { outcome: 'tenant_gone' };
    }

    return {
      outcome: 'created',
      appointmentId: parsed.appointmentId,
      tenantId: parsed.tenantId,
      scheduledAt: new Date(parsed.scheduledAt),
      durationMinutes: parsed.durationMinutes,
      calendarSyncStatus: parsed.calendarSyncStatus,
      calendarEventId: parsed.calendarEventId,
      calendarEventHtmlLink: parsed.calendarEventHtmlLink,
      intentId: parsed.intentId,
      projectionEpoch: parsed.projectionEpoch,
      desiredVersion: parsed.desiredVersion,
      writeGeneration: parsed.writeGeneration,
    };
  }

  async rescheduleGuarded(
    input: RescheduleAppointmentGuardedInput,
  ): Promise<RescheduleAppointmentGuardedResult> {
    const { data, error } = await this.supabase.rpc('reschedule_appointment_guarded', {
      p_tenant_id: input.tenantId,
      p_appointment_id: input.appointmentId,
      p_expected_projection_epoch: input.expectedProjectionEpoch,
      p_scheduled_at: input.scheduledAt.toISOString(),
      p_duration_minutes: input.durationMinutes,
      p_notes: input.notes,
      p_calendar_provider: input.calendarProvider,
      p_calendar_sync_status: input.calendarSyncStatus,
      p_calendar_sync_next_attempt_at: input.calendarSyncNextAttemptAt?.toISOString() ?? null,
    });

    if (error) {
      if (isSlotConflict(error)) {
        return { outcome: 'slot_conflict' };
      }

      throw new AppError('upstream_error', 'Failed to reschedule the appointment', {
        cause: error,
        expose: false,
      });
    }

    const parsed = RescheduleRowSchema.parse(data);

    return parsed.outcome === 'rescheduled'
      ? {
          outcome: 'rescheduled',
          desiredVersion: parsed.desiredVersion,
          projectionEpoch: parsed.projectionEpoch,
        }
      : parsed.outcome === 'stale_projection_epoch'
        ? { outcome: 'stale_projection_epoch' }
        : { outcome: parsed.outcome };
  }

  async cancelGuarded(
    input: CancelAppointmentGuardedInput,
  ): Promise<CancelAppointmentGuardedResult> {
    const { data, error } = await this.supabase.rpc('cancel_appointment_guarded', {
      p_tenant_id: input.tenantId,
      p_appointment_id: input.appointmentId,
      p_expected_projection_epoch: input.expectedProjectionEpoch,
      p_calendar_sync_status: input.calendarSyncStatus,
      p_calendar_sync_next_attempt_at: input.calendarSyncNextAttemptAt?.toISOString() ?? null,
    });

    if (error) {
      throw new AppError('upstream_error', 'Failed to cancel the appointment', {
        cause: error,
        expose: false,
      });
    }

    const parsed = CancelRowSchema.parse(data);

    return parsed.outcome === 'cancelled'
      ? {
          outcome: 'cancelled',
          desiredVersion: parsed.desiredVersion,
          projectionEpoch: parsed.projectionEpoch,
        }
      : parsed.outcome === 'stale_projection_epoch'
        ? { outcome: 'stale_projection_epoch' }
        : { outcome: parsed.outcome };
  }

  async openIntent(input: OpenCalendarWriteIntentInput): Promise<OpenCalendarWriteIntentResult> {
    const { data, error } = await this.supabase.rpc('open_calendar_write_intent', {
      p_tenant_id: input.tenantId,
      p_appointment_id: input.appointmentId,
      p_expected_projection_epoch: input.expectedProjectionEpoch,
      p_expected_desired_version: input.expectedDesiredVersion,
      p_operation: input.operation,
      p_calendar_id: input.target?.calendarId ?? null,
      p_calendar_identity_source: input.target?.identitySource ?? 'unknown',
      p_external_event_id: input.externalEventId,
    });

    if (error) {
      throw new AppError('upstream_error', 'Failed to open a calendar write intent', {
        cause: error,
        expose: false,
      });
    }

    const parsed = OpenIntentRowSchema.parse(data);

    switch (parsed.outcome) {
      case 'opened':
        return {
          outcome: 'opened',
          intentId: parsed.intentId,
          projectionEpoch: parsed.projectionEpoch,
          desiredVersion: parsed.desiredVersion,
          writeGeneration: parsed.writeGeneration,
        };
      case 'desired_version_changed':
        return { outcome: 'desired_version_changed', observed: parsed.observed };
      case 'stale_projection_epoch':
        // I numeri di epoca restano DENTRO: sono stato interno del fence e non
        // hanno nessun significato per chi ha fatto la richiesta.
        return { outcome: 'stale_projection_epoch' };
      default:
        return { outcome: parsed.outcome };
    }
  }

  async settle(input: SettleCalendarWriteInput): Promise<CalendarSettleResult> {
    const { data, error } = await this.supabase.rpc('settle_calendar_write', {
      p_tenant_id: input.tenantId,
      p_appointment_id: input.appointmentId,
      p_expected_projection_epoch: input.expectedProjectionEpoch,
      p_expected_desired_version: input.expectedDesiredVersion,
      p_expected_write_generation: input.expectedWriteGeneration,
      p_calendar_sync_status: input.calendarSyncStatus,
      p_calendar_sync_error: input.errorMessage,
      p_calendar_sync_attempts: input.attempts,
      p_calendar_sync_next_attempt_at: input.nextAttemptAt?.toISOString() ?? null,
      p_calendar_sync_last_attempt_at: input.lastAttemptAt.toISOString(),
      p_calendar_event_id: input.eventId ?? null,
      p_calendar_event_calendar_id: input.eventCalendarId ?? null,
      p_calendar_event_html_link: input.htmlLink ?? null,
      p_set_html_link: input.htmlLink !== undefined,
      p_intent_id: input.intentId ?? null,
      p_intent_state: input.intentState ?? null,
      p_intent_error_code: toBoundedIntentErrorCode(input.intentErrorCode),
      p_remote_evidence: input.remoteEvidence ?? null,
    });

    if (error) {
      throw new AppError('upstream_error', 'Failed to settle the calendar write', {
        cause: error,
        expose: false,
      });
    }

    return SettleRowSchema.parse(data);
  }
}
