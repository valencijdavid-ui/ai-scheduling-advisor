// Fatto da Claude Code il 24 agosto 2026.
//
// Riconciliazione della proiezione Google Calendar.
//
// Prima di questo modulo `calendar_sync_status = 'failed'` era scritto in un
// punto solo e letto in nessuno: una colonna che registrava fedelmente un
// guasto che nessuno avrebbe mai visto. Il cliente riceveva "ho prenotato",
// l'appuntamento esisteva davvero in Postgres, e sul calendario dello studio
// non compariva niente.
//
// Non c'e' una coda dedicata, e la scelta e' deliberata. Una outbox esiste per
// rendere durevole un'intenzione che altrimenti non avrebbe casa: qui la casa
// c'e' gia' ed e' la riga dell'appuntamento, che porta con se' tenant, orario
// e stato desiderato. Una tabella di job duplicherebbe quello stato e
// introdurrebbe una seconda cosa da tenere allineata alla prima — esattamente
// la classe di difetto che questo lavoro elimina. Il precedente in repo e'
// `listDueReminders`, che scandisce le stesse righe con la stessa cadenza.
//
// Nemmeno la rivendicazione usa una tabella: si confronta e si scrive il
// contatore dei tentativi in un solo UPDATE condizionale. Se due worker si
// sovrappongono, uno solo vede la riga aggiornata e l'altro passa oltre. Il
// confronto e' sull'intero `calendar_sync_attempts` e non su un timestamp
// perche' Postgres conserva i microsecondi mentre un ISO string JavaScript si
// ferma ai millisecondi: un confronto di uguaglianza su quel valore, dopo un
// giro di serializzazione, puo' non tornare mai.

import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/lib/logging/logger';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  buildAppointmentCalendarDescription,
  buildAppointmentCalendarSummary,
  SupabaseAppointmentBookingRepository,
} from '@/server/appointments/booking';
import {
  SupabaseCalendarWriteStore,
  calendarWriteErrorCode,
  casFor,
  evidenceForAction,
  type CalendarTarget,
  type CalendarWriteAuthorization,
  type CalendarWriteStore,
} from '@/server/appointments/calendar-write-intents';
import {
  CALENDAR_SYNC_LEASE_MS,
  CALENDAR_SYNC_MAX_ATTEMPTS,
  calculateCalendarSyncNextAttemptAt,
  convergeCalendarEvent,
  isNonRetryableCalendarError,
  type CalendarConvergenceProvider,
  type CalendarConvergenceTarget,
} from '@/server/appointments/calendar-convergence';
import {
  GoogleCalendarProvider,
  createCalendarWriteBudget,
  effectiveCalendarId,
  isUnknownCalendarWriteOutcome,
  type GoogleCalendarIntegration,
} from '@/server/calendar/google';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_TIMEZONE = 'Europe/Rome';

const MISSING_INTEGRATION_ERROR = 'Google Calendar integration is not connected for this tenant';

/** Riga in attesa di convergenza, gia' filtrata dal predicato dello scanner. */
export type DueCalendarSync = {
  tenantId: string;
  appointmentId: string;
  /** Non nullo per costruzione: lo scanner esclude le righe senza identita'. */
  calendarEventId: string;
  status: 'confirmed' | 'cancelled';
  scheduledAt: Date;
  durationMinutes: number;
  serviceName: string | null;
  customerName: string;
  customerPhone: string | null;
  notes: string | null;
  attempts: number;
  /**
   * Stato desiderato OSSERVATO sulla riga.
   *
   * La rivendicazione non autorizza niente da sola: e' un lease contro altri
   * worker, non un diritto di scrivere l'esito. Sono questa versione — piu'
   * l'epoca del tenant e la generazione allocata dall'intento — a decidere se
   * il risultato di questo tentativo vale ancora quando arriva il momento di
   * registrarlo.
   */
  desiredVersion: number;
  /** Provenienza verificata, quando esiste. Governa GET/PATCH/DELETE. */
  calendarEventCalendarId: string | null;
};

export type TenantCalendarContext = {
  timezone: string;
  studioName: string;
  address: string | null;
  integration: GoogleCalendarIntegration | null;
  /**
   * Epoca di proiezione del tenant, letta all'inizio del giro di questo
   * worker.
   *
   * Il tick del reconciler e' un turno logico a se': cattura l'autorita'
   * quando comincia ad agire, e la primitiva la riverifica sotto lock. Non e'
   * un valore della riga — vive sul tenant — e non poteva quindi arrivare
   * dallo scanner degli appuntamenti.
   */
  projectionEpoch: number;
};

export interface CalendarReconcilerRepository {
  listDueCalendarSyncs(input: { now: Date; limit: number }): Promise<DueCalendarSync[]>;
  getTenantCalendarContext(tenantId: string): Promise<TenantCalendarContext | null>;
  /**
   * Rivendica la riga in modo atomico.
   *
   * Ritorna `false` quando un altro worker l'ha gia' presa: il confronto sul
   * contatore fallisce e l'UPDATE non tocca nessuna riga.
   */
  claimCalendarSync(input: {
    tenantId: string;
    appointmentId: string;
    observedAttempts: number;
    leaseUntil: Date;
    lastAttemptAt: Date;
  }): Promise<boolean>;
}

// NOTA DI CONFINE (PILOT-P0-3C-i)
//
// `updateAppointmentCalendarSync` non esiste piu' qui. Era la SECONDA
// implementazione di settle: scriveva `calendar_sync_status` per conto proprio,
// senza sapere quante righe toccava e senza confrontarsi con la versione
// desiderata. Un worker partito prima di una riprogrammazione poteva quindi
// marcare `synced` una riga il cui stato desiderato era gia' cambiato, e la
// riga spariva dalla vista dello scanner con Google fermo all'orario vecchio.
//
// L'autorita' di settle e' ora una sola, la stessa del booking inline.

export type ProcessCalendarSyncResult = {
  candidates: number;
  claimed: number;
  synced: number;
  retried: number;
  terminal: number;
  skipped: number;
};

export class CalendarSyncReconciler {
  constructor(
    private readonly repository: CalendarReconcilerRepository,
    private readonly calendarProvider: CalendarConvergenceProvider,
    /** Stessa primitiva di intento e settle del booking inline. */
    private readonly calendarWrites: CalendarWriteStore,
    private readonly options: { defaultLimit?: number } = {},
  ) {}

  async processDueSyncs(
    input: {
      limit?: number;
      now?: Date;
    } = {},
  ): Promise<ProcessCalendarSyncResult> {
    const now = input.now ?? new Date();
    const limit = Math.max(
      1,
      Math.min(input.limit ?? this.options.defaultLimit ?? DEFAULT_LIMIT, MAX_LIMIT),
    );
    const rows = await this.repository.listDueCalendarSyncs({ now, limit });
    const result: ProcessCalendarSyncResult = {
      candidates: rows.length,
      claimed: 0,
      synced: 0,
      retried: 0,
      terminal: 0,
      skipped: 0,
    };
    const contexts = new Map<string, TenantCalendarContext | null>();

    for (const row of rows) {
      // La rivendicazione viene prima di qualunque lettura di contesto: e'
      // cio' che rende durevole il consumo del tentativo anche se il worker
      // muore subito dopo.
      const claimed = await this.repository.claimCalendarSync({
        tenantId: row.tenantId,
        appointmentId: row.appointmentId,
        observedAttempts: row.attempts,
        leaseUntil: new Date(now.getTime() + CALENDAR_SYNC_LEASE_MS),
        lastAttemptAt: now,
      });

      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      result.claimed += 1;

      if (!contexts.has(row.tenantId)) {
        contexts.set(row.tenantId, await this.loadContextSafely(row.tenantId));
      }

      const context = contexts.get(row.tenantId) ?? null;
      const outcome = await this.convergeRow(row, context, now);

      result.synced += outcome === 'synced' ? 1 : 0;
      result.retried += outcome === 'retry' ? 1 : 0;
      result.terminal += outcome === 'terminal' ? 1 : 0;
    }

    return result;
  }

  private async convergeRow(
    row: DueCalendarSync,
    context: TenantCalendarContext | null,
    now: Date,
  ): Promise<'synced' | 'retry' | 'terminal'> {
    // Il tentativo e' gia' stato consumato dalla rivendicazione.
    const attempts = row.attempts + 1;

    // SENZA CONTESTO DEL TENANT NON ESISTE NESSUNA EPOCA.
    //
    // Qui si arriva quando la lettura del contesto e' fallita o il tenant non
    // c'e' piu'. La tentazione sarebbe passare `0` alla primitiva e proseguire:
    // sarebbe un'epoca INVENTATA, cioe' un'autorita' di proiezione che nessuno
    // ha mai osservato. Se il tenant reale fosse a un'epoca diversa la
    // primitiva rifiuterebbe comunque, ma un tenant fermo a 0 vedrebbe passare
    // uno scrittore che non aveva letto niente.
    //
    // Quindi: nessun intento, nessuna rete, nessun settle. La rivendicazione ha
    // gia' consumato il tentativo e scritto il lease su
    // `calendar_sync_next_attempt_at`, quindi lo scanner rivedra' la riga e la
    // terminalita' resta un predicato su tentativi e stato, esattamente come
    // per ogni altro guasto.
    if (!context) {
      logger.error(
        {
          tenantId: row.tenantId,
          appointmentId: row.appointmentId,
          attempt: attempts,
        },
        'Calendar sync skipped: the tenant projection authority could not be read',
      );

      return attempts >= CALENDAR_SYNC_MAX_ATTEMPTS ? 'terminal' : 'retry';
    }

    const integration = context.integration;

    if (!integration) {
      // Il tenant ha scollegato Google mentre c'erano righe in attesa. Non e'
      // un caso speciale: lo trattiamo come un fallimento qualunque, cosi' una
      // disconnessione breve si ripara da sola entro il budget di tentativi e
      // una definitiva diventa terminale, e quindi visibile all'operatore.
      return this.recordFailure(
        row,
        context,
        new AppError('upstream_error', MISSING_INTEGRATION_ERROR),
        attempts,
        now,
      );
    }

    // L'INTENTO PRIMA DELLA RETE, come nel percorso inline.
    //
    // Se la primitiva rifiuta — l'epoca e' avanzata, lo stato desiderato e'
    // cambiato, la riga non c'e' piu' — Google non viene contattato affatto.
    // La rivendicazione da sola non basta: e' un lease, non un'autorita'.
    const opened = await this.calendarWrites.openIntent({
      tenantId: row.tenantId,
      appointmentId: row.appointmentId,
      expectedProjectionEpoch: context.projectionEpoch,
      expectedDesiredVersion: row.desiredVersion,
      operation: row.status === 'cancelled' ? 'delete' : 'update',
      externalEventId: row.calendarEventId,
      target: reconcilerCalendarTarget(row, integration),
    });

    if (opened.outcome !== 'opened') {
      // La riga resta com'era: `calendar_sync_next_attempt_at` e' gia'
      // valorizzato dalla rivendicazione, quindi lo scanner la rivedra' con lo
      // stato desiderato AGGIORNATO.
      logger.info(
        {
          tenantId: row.tenantId,
          appointmentId: row.appointmentId,
          outcome: opened.outcome,
        },
        'Calendar sync skipped: the projection moved before the write was authorized',
      );

      return 'retry';
    }

    const budget = createCalendarWriteBudget();

    try {
      const converged = await convergeCalendarEvent({
        provider: this.calendarProvider,
        integration,
        target: buildConvergenceTarget(row, context),
        budget,
      });

      const settled = await this.calendarWrites.settle({
        ...casFor(opened),
        tenantId: row.tenantId,
        appointmentId: row.appointmentId,
        calendarSyncStatus: 'synced',
        eventId: converged.eventId,
        ...(converged.calendarIdVerified ? { eventCalendarId: converged.calendarId } : {}),
        htmlLink: converged.htmlLink,
        errorMessage: null,
        attempts,
        nextAttemptAt: null,
        lastAttemptAt: now,
        intentState: 'settled',
        remoteEvidence: evidenceForAction(converged.action),
      });

      logger.info(
        {
          tenantId: row.tenantId,
          appointmentId: row.appointmentId,
          attempt: attempts,
          action: converged.action,
          outcome: settled.outcome,
        },
        'Calendar sync converged',
      );

      // C2. Uno scrittore stantio non puo' dichiarare sincronizzata una riga il
      // cui stato desiderato e' andato avanti mentre lui era in volo. Il settle
      // non ha scritto niente, e la proiezione CORRENTE resta — o torna — da
      // riconciliare.
      return settled.outcome === 'settled_current' ? 'synced' : 'retry';
    } catch (error) {
      return this.recordFailure(row, context, error, attempts, now, opened);
    }
  }

  /**
   * `context` e' NON opzionale, e non e' un dettaglio di firma.
   *
   * Registrare un esito richiede un'autorizzazione, e un'autorizzazione
   * richiede l'epoca del tenant. Un contesto assente non ha epoca, e il tipo
   * impedisce di arrivare qui senza: il chiamante deve aver gia' deciso cosa
   * fare di quel caso, invece di inventarne un valore.
   */
  private async recordFailure(
    row: DueCalendarSync,
    context: TenantCalendarContext,
    error: unknown,
    attempts: number,
    now: Date,
    authorization: CalendarWriteAuthorization | null = null,
  ): Promise<'retry' | 'terminal'> {
    const finalAttempts = isNonRetryableCalendarError(error)
      ? CALENDAR_SYNC_MAX_ATTEMPTS
      : attempts;
    const terminal = finalAttempts >= CALENDAR_SYNC_MAX_ATTEMPTS;

    if (!authorization) {
      // Nessun intento aperto: il guasto e' caduto prima della rete (per
      // esempio l'integrazione scollegata). Si apre comunque un intento per
      // poter registrare l'esito sotto la stessa autorita' di tutti gli altri.
      const opened = await this.calendarWrites.openIntent({
        tenantId: row.tenantId,
        appointmentId: row.appointmentId,
        expectedProjectionEpoch: context.projectionEpoch,
        expectedDesiredVersion: row.desiredVersion,
        operation: row.status === 'cancelled' ? 'delete' : 'update',
        externalEventId: row.calendarEventId,
        target: null,
      });

      if (opened.outcome !== 'opened') {
        return terminal ? 'terminal' : 'retry';
      }

      authorization = opened;
    }

    // Timeout e guasti di trasporto lasciano l'esito remoto IGNOTO: la
    // mutazione puo' essere arrivata. Solo una risposta HTTP di Google prova
    // che non ha applicato niente.
    const unknown = isUnknownCalendarWriteOutcome(error);

    await this.calendarWrites.settle({
      ...casFor(authorization),
      tenantId: row.tenantId,
      appointmentId: row.appointmentId,
      calendarSyncStatus: 'failed',
      errorMessage: error instanceof Error ? error.message : 'unknown error',
      attempts: finalAttempts,
      nextAttemptAt: calculateCalendarSyncNextAttemptAt(now, finalAttempts),
      lastAttemptAt: now,
      intentState: unknown ? 'unknown_outcome' : 'no_remote_mutation',
      intentErrorCode: calendarWriteErrorCode(error),
      remoteEvidence: 'none',
    });

    // Il corpo dell'errore Google non viene loggato: puo' riportare il payload
    // della richiesta, che contiene nome e telefono del cliente. Lo stato HTTP
    // basta a capire di che guasto si tratta.
    logger.error(
      {
        tenantId: row.tenantId,
        appointmentId: row.appointmentId,
        attempt: finalAttempts,
        terminal,
        code: error instanceof AppError ? error.code : 'internal',
      },
      'Calendar sync attempt failed',
    );

    return terminal ? 'terminal' : 'retry';
  }

  private async loadContextSafely(tenantId: string): Promise<TenantCalendarContext | null> {
    try {
      return await this.repository.getTenantCalendarContext(tenantId);
    } catch (error) {
      logger.error({ tenantId, err: error }, 'Failed to load tenant calendar context');
      return null;
    }
  }
}

/**
 * Stato desiderato ricostruito dalla riga.
 *
 * Nessuna traccia di come ci si e' arrivati: l'appuntamento e' confermato o
 * annullato, e questo basta a sapere che aspetto deve avere l'evento adesso.
 */
export function buildConvergenceTarget(
  row: DueCalendarSync,
  context: TenantCalendarContext | null,
): CalendarConvergenceTarget {
  const serviceName = row.serviceName ?? 'Appuntamento';
  const studioName = context?.studioName ?? 'Studio';
  const address = context?.address ?? null;

  return {
    tenantId: row.tenantId,
    appointmentId: row.appointmentId,
    eventId: row.calendarEventId,
    status: row.status,
    start: row.scheduledAt,
    end: new Date(row.scheduledAt.getTime() + row.durationMinutes * 60_000),
    timezone: context?.timezone ?? DEFAULT_TIMEZONE,
    summary: buildAppointmentCalendarSummary({
      studioName,
      serviceName,
      customerName: row.customerName,
    }),
    description: buildAppointmentCalendarDescription({
      serviceName,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      notes: row.notes,
    }),
    ...(address !== null ? { location: address } : {}),
    customerName: row.customerName,
    customerPhone: row.customerPhone,
  };
}

type DueCalendarSyncRow = {
  id: string;
  tenant_id: string;
  status: 'confirmed' | 'cancelled';
  scheduled_at: string;
  duration_minutes: number;
  service_type: string | null;
  customer_name: string;
  customer_phone: string | null;
  notes: string | null;
  calendar_event_id: string;
  calendar_event_calendar_id?: string | null;
  calendar_sync_attempts: number;
  calendar_desired_version?: number | null;
};

export class SupabaseCalendarReconcilerRepository implements CalendarReconcilerRepository {
  private readonly supabase = createSupabaseAdminClient();

  /**
   * Il predicato dello scanner E' la definizione operativa di "non terminale,
   * dovuta e indirizzabile":
   *
   * - `attempts < MAX` e `scheduled_at > now()` sono le due clausole che
   *   escludono le righe terminali. La terminalita' resta un predicato su
   *   colonne esplicite: non e' mai l'assenza di `next_attempt_at`.
   * - `next_attempt_at not null` esclude cio' che non deve nulla (sincronizzato).
   * - `calendar_event_id not null` esclude le righe storiche senza identita',
   *   per cui creare un evento nuovo rischierebbe un duplicato.
   */
  async listDueCalendarSyncs(input: { now: Date; limit: number }): Promise<DueCalendarSync[]> {
    const nowIso = input.now.toISOString();
    const { data, error } = await this.supabase
      .from('appointments')
      .select(
        'id, tenant_id, status, scheduled_at, duration_minutes, service_type, customer_name, customer_phone, notes, calendar_event_id, calendar_event_calendar_id, calendar_sync_attempts, calendar_desired_version',
      )
      .eq('calendar_provider', 'google_calendar')
      .in('calendar_sync_status', ['pending', 'failed'])
      .in('status', ['confirmed', 'cancelled'])
      .not('calendar_event_id', 'is', null)
      .not('calendar_sync_next_attempt_at', 'is', null)
      .lte('calendar_sync_next_attempt_at', nowIso)
      .lt('calendar_sync_attempts', CALENDAR_SYNC_MAX_ATTEMPTS)
      .gt('scheduled_at', nowIso)
      .order('calendar_sync_next_attempt_at', { ascending: true })
      .limit(input.limit);

    if (error) {
      throw toRepositoryError('Failed to list appointments due for calendar sync', error);
    }

    return ((data ?? []) as DueCalendarSyncRow[]).map((row) => ({
      tenantId: row.tenant_id,
      appointmentId: row.id,
      calendarEventId: row.calendar_event_id,
      status: row.status,
      scheduledAt: new Date(row.scheduled_at),
      durationMinutes: row.duration_minutes,
      serviceName: row.service_type,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      notes: row.notes,
      attempts: row.calendar_sync_attempts,
      desiredVersion: row.calendar_desired_version ?? 0,
      calendarEventCalendarId: row.calendar_event_calendar_id ?? null,
    }));
  }

  async getTenantCalendarContext(tenantId: string): Promise<TenantCalendarContext | null> {
    const [tenant, config, integrations] = await Promise.all([
      this.supabase
        .from('tenants')
        .select('timezone, projection_epoch')
        .eq('id', tenantId)
        .maybeSingle(),
      this.supabase
        .from('tenant_config')
        .select('studio_name, address')
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      this.supabase
        .from('integrations')
        .select('id, tenant_id, external_account_id, credentials, config')
        .eq('tenant_id', tenantId)
        .eq('provider', 'google_calendar')
        .eq('status', 'active')
        .limit(1),
    ]);

    const failure = tenant.error ?? config.error ?? integrations.error;

    if (failure) {
      throw toRepositoryError('Failed to read tenant calendar context', failure);
    }

    if (!tenant.data) {
      return null;
    }

    const tenantRow = tenant.data as {
      timezone: string;
      projection_epoch?: number | string | null;
    };
    const configRow = config.data as { studio_name: string; address: string | null } | null;
    const integrationRow = (integrations.data?.[0] ?? null) as {
      id: string;
      tenant_id: string;
      external_account_id: string | null;
      credentials: unknown;
      config: unknown;
    } | null;

    return {
      timezone: tenantRow.timezone || DEFAULT_TIMEZONE,
      studioName: configRow?.studio_name ?? 'Studio',
      address: configRow?.address ?? null,
      projectionEpoch: Number(tenantRow.projection_epoch ?? 0),
      integration: integrationRow
        ? {
            id: integrationRow.id,
            tenantId: integrationRow.tenant_id,
            externalAccountId: integrationRow.external_account_id,
            credentials: toPlainRecord(integrationRow.credentials),
            config: toPlainRecord(integrationRow.config),
          }
        : null,
    };
  }

  async claimCalendarSync(input: {
    tenantId: string;
    appointmentId: string;
    observedAttempts: number;
    leaseUntil: Date;
    lastAttemptAt: Date;
  }): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('appointments')
      .update({
        calendar_sync_attempts: input.observedAttempts + 1,
        calendar_sync_next_attempt_at: input.leaseUntil.toISOString(),
        calendar_sync_last_attempt_at: input.lastAttemptAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('tenant_id', input.tenantId)
      .eq('id', input.appointmentId)
      .eq('calendar_sync_attempts', input.observedAttempts)
      .select('id');

    if (error) {
      throw toRepositoryError('Failed to claim appointment calendar sync', error);
    }

    return (data ?? []).length > 0;
  }
}

export function createCalendarSyncReconciler(): CalendarSyncReconciler {
  // La persistenza del token rinfrescato passa dal repository di booking, che
  // gia' cifra le credenziali con `encryptedCredentialPatch`. Riscriverla qui
  // significherebbe salvare un access token in chiaro.
  const bookingRepository = new SupabaseAppointmentBookingRepository();

  return new CalendarSyncReconciler(
    new SupabaseCalendarReconcilerRepository(),
    new GoogleCalendarProvider({
      onTokenRefresh: async (input) => {
        await bookingRepository.updateGoogleCalendarAccessToken({
          tenantId: input.integration.tenantId,
          integrationId: input.integration.id,
          accessToken: input.accessToken,
          expiresAt: input.expiresAt,
          scope: input.scope,
          tokenType: input.tokenType,
        });
      },
    }),
    new SupabaseCalendarWriteStore(),
  );
}

/**
 * Bersaglio di una convergenza del reconciler.
 *
 * Con provenienza memorizzata il bersaglio e' quella, ed e' una prova. Senza,
 * si ripiega sul calendario configurato adesso — dichiarandolo `current_config`,
 * cioe' ipotesi. Il ripiego non diventa provenienza per il fatto di essere
 * stato usato: solo un'osservazione remota positiva puo' promuoverlo.
 */
function reconcilerCalendarTarget(
  row: DueCalendarSync,
  integration: GoogleCalendarIntegration,
): CalendarTarget {
  const stored = row.calendarEventCalendarId?.trim();

  return stored
    ? { calendarId: stored, identitySource: 'stored_provenance' }
    : { calendarId: effectiveCalendarId(integration), identitySource: 'current_config' };
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function toRepositoryError(message: string, cause: unknown): AppError {
  return new AppError('upstream_error', message, { cause, expose: false });
}
