// Fatto da Claude Code l'8 maggio 2026.
// Cancellazione customer riscritta in PILOT-P0-3A il 25 agosto 2026.
//
// GDPR Art. 17 — Diritto alla cancellazione (right to be forgotten).
//
// Due livelli:
//   1. Tenant-level: l'azienda chiude l'account. Soft-delete con grace
//      period 30gg, hard-delete eseguito da job cron giornaliero.
//   2. Customer-level: cancellazione immediata dei dati di un cliente
//      finale (no grace period — il customer non ha login, e' un GDPR
//      request che il tenant onora subito).
//
// PILOT-P0-3A — cosa e' cambiato nel percorso customer e perche':
//
// Prima erano cinque DELETE indipendenti via PostgREST, nell'ordine
// sbagliato: i messaggi venivano cancellati e committati, poi la
// cancellazione della conversazione falliva con 23503 su
// `appointments_conversation_id_fkey` e il resto non veniva mai eseguito.
// Nessun rollback, nessun audit: dati del cliente distrutti a meta'.
// Ora e' UNA chiamata a `public.erase_customer_data`, cioe' una sola
// transazione Postgres che include anche l'audit.
//
// La transazione cattura anche l'identita' degli eventi Google del cliente
// in `erasure_obligations`, perche' quando la riga locale sparisce sparisce
// l'unico puntatore all'evento remoto — che contiene il suo telefono.
//
// CONFINE DI FASE: P0-3A cattura il debito remoto, non lo esegue. Nessuna
// chiamata a Google parte da questo modulo. La convergenza remota arriva in
// P0-3C. `remoteCleanup` non vale mai "completato" in questa fase.
//
// Pattern allineato a data-export.ts e conversations/inbox.ts.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AuthSession } from '@/lib/auth/session';
import { AppError } from '@/lib/errors/app-error';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  type AuditLogInput,
  type GdprActor,
  normalizeCustomerPhone,
} from '@/server/gdpr/data-export';

export const TENANT_DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** SQLSTATE invalid_parameter_value: numero cliente non normalizzabile. */
const PG_INVALID_PARAMETER_VALUE = '22023';

export type TenantDeletionRequest = {
  tenantId: string;
  requestedAt: string;
  scheduledHardDeleteAt: string;
  status: 'scheduled' | 'cancelled' | 'executed';
};

export type CustomerErasureBreakdown = {
  conversations: number;
  messages: number;
  appointments: number;
  optOuts: number;
  voiceEvents: number;
  schedulingDecisions: number;
};

/**
 * Stato della cancellazione sui sistemi esterni.
 *
 * Non esiste il valore "completato": in P0-3A nessuno converge il debito
 * remoto, quindi dichiararlo concluso sarebbe una bugia. Lo stato terminale
 * positivo arrivera' con il worker di P0-3C.
 */
export type RemoteCleanupState = 'not_required' | 'pending' | 'manual_required';

/**
 * Esito della cancellazione LOCALE.
 *
 * `complete` significa che l'identita' normalizzata esatta e' sparita e che
 * non e' rimasto niente che possa essere lo stesso soggetto.
 *
 * `manual_review_required` significa che la transazione ha committato, ma sono
 * rimaste righe che potrebbero essere la stessa persona sotto un prefisso
 * diverso. Sono un'unione, non un booleano a parte, perche' cosi' nessun
 * consumatore puo' leggere l'esito senza incontrare anche questo caso: un flag
 * accanto a `complete` sarebbe stato ignorabile a costo zero.
 *
 * Dimensione distinta da `RemoteCleanupState`: quello e' debito GOOGLE, questo
 * e' ambiguita' di identita' locale. Si chiudono in due modi diversi.
 */
export type LocalDeletionState = 'complete' | 'manual_review_required';

export type CustomerDeletionResult = {
  tenantId: string;
  /** Correla questa cancellazione con il suo debito remoto e con l'audit. */
  requestId: string;
  /** Esito locale. Non dice nulla sul remoto. */
  localDeletion: LocalDeletionState;
  deleted: CustomerErasureBreakdown;
  /** Appuntamenti di ALTRI clienti sganciati dalle conversazioni cancellate. */
  dissociatedAppointments: number;
  remoteCleanup: RemoteCleanupState;
  /** Eventi Google noti da cancellare (non ancora eseguibili in P0-3A). */
  pendingObligations: number;
  /** Debito che richiede un operatore: identita' remota ignota. */
  manualRequired: number;
  /**
   * Righe rimaste che potrebbero essere lo stesso soggetto con un prefisso
   * internazionale diverso. Rilevate, MAI cancellate automaticamente.
   */
  residualSuspected: number;
};

/**
 * Esito della RPC. Parsato con Zod come ogni input esterno: la funzione SQL
 * e' un contratto, non una fonte fidata.
 */
const CustomerErasureRpcResultSchema = z.object({
  requestId: z.string(),
  executedAt: z.string(),
  /**
   * Lo decide la transazione, non il service.
   *
   * Il conteggio dei residui e l'esito che ne discende nascono nello stesso
   * statement: ricalcolarlo qui vorrebbe dire tenere in piedi due definizioni
   * della stessa verita' e sperare che non divergano.
   */
  localDeletion: z.enum(['complete', 'manual_review_required']),
  deleted: z.object({
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    appointments: z.number().int().nonnegative(),
    optOuts: z.number().int().nonnegative(),
    voiceEvents: z.number().int().nonnegative(),
    schedulingDecisions: z.number().int().nonnegative(),
  }),
  dissociatedAppointments: z.number().int().nonnegative(),
  pendingObligations: z.number().int().nonnegative(),
  manualRequired: z.number().int().nonnegative(),
  residualSuspected: z.number().int().nonnegative(),
});

export type CustomerErasureRpcResult = z.infer<typeof CustomerErasureRpcResultSchema>;

export type ScheduledTenantDeletion = {
  tenantId: string;
  scheduledHardDeleteAt: string;
};

export interface GdprDeleteRepository {
  getTenantDeletionStatus(tenantId: string): Promise<{
    deletedAt: string | null;
    exists: boolean;
  }>;
  scheduleTenantSoftDelete(input: { tenantId: string; deletedAt: Date }): Promise<void>;
  clearTenantSoftDelete(tenantId: string): Promise<boolean>;
  listTenantsDueForHardDelete(now: Date): Promise<ScheduledTenantDeletion[]>;
  hardDeleteTenant(tenantId: string): Promise<void>;
  /**
   * Cancellazione locale + cattura del debito remoto in UNA transazione.
   *
   * L'audit e' scritto dentro la stessa transazione: un audit che sopravvive
   * a una cancellazione fallita descriverebbe qualcosa che non e' successo.
   */
  eraseCustomerData(input: {
    tenantId: string;
    customerPhone: string;
    requestId: string;
    userId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<CustomerErasureRpcResult>;
  recordAuditLog(input: AuditLogInput): Promise<void>;
}

export class GdprDeleteService {
  constructor(private readonly repository: GdprDeleteRepository) {}

  async requestTenantDeletion(input: {
    session: AuthSession;
    actor?: Pick<GdprActor, 'ipAddress' | 'userAgent'>;
    now?: Date;
  }): Promise<TenantDeletionRequest> {
    assertOwner(input.session);
    const status = await this.repository.getTenantDeletionStatus(input.session.tenantId);

    if (!status.exists) {
      throw new AppError('not_found', 'Tenant not found');
    }

    if (status.deletedAt) {
      throw new AppError('conflict', 'Tenant deletion is already scheduled');
    }

    const requestedAtDate = input.now ?? new Date();
    const scheduledHardDeleteAt = new Date(
      requestedAtDate.getTime() + TENANT_DELETION_GRACE_PERIOD_MS,
    );

    await this.repository.scheduleTenantSoftDelete({
      tenantId: input.session.tenantId,
      deletedAt: scheduledHardDeleteAt,
    });

    await this.repository.recordAuditLog({
      tenantId: input.session.tenantId,
      userId: input.session.userId,
      action: 'gdpr.tenant.deletion.requested',
      resourceType: 'tenant',
      resourceId: input.session.tenantId,
      ipAddress: input.actor?.ipAddress ?? null,
      userAgent: input.actor?.userAgent ?? null,
      metadata: {
        requestedAt: requestedAtDate.toISOString(),
        scheduledHardDeleteAt: scheduledHardDeleteAt.toISOString(),
        graceDays: 30,
      },
    });

    return {
      tenantId: input.session.tenantId,
      requestedAt: requestedAtDate.toISOString(),
      scheduledHardDeleteAt: scheduledHardDeleteAt.toISOString(),
      status: 'scheduled',
    };
  }

  async cancelTenantDeletion(input: {
    session: AuthSession;
    actor?: Pick<GdprActor, 'ipAddress' | 'userAgent'>;
    now?: Date;
  }): Promise<void> {
    assertOwner(input.session);
    const status = await this.repository.getTenantDeletionStatus(input.session.tenantId);

    if (!status.exists) {
      throw new AppError('not_found', 'Tenant not found');
    }

    if (!status.deletedAt) {
      throw new AppError('conflict', 'No deletion request to cancel');
    }

    const cleared = await this.repository.clearTenantSoftDelete(input.session.tenantId);

    if (!cleared) {
      throw new AppError('not_found', 'Tenant deletion request not found');
    }

    await this.repository.recordAuditLog({
      tenantId: input.session.tenantId,
      userId: input.session.userId,
      action: 'gdpr.tenant.deletion.cancelled',
      resourceType: 'tenant',
      resourceId: input.session.tenantId,
      ipAddress: input.actor?.ipAddress ?? null,
      userAgent: input.actor?.userAgent ?? null,
      metadata: {
        cancelledAt: (input.now ?? new Date()).toISOString(),
        previousScheduledHardDeleteAt: status.deletedAt,
      },
    });
  }

  async executeTenantHardDelete(input: { tenantId: string; now?: Date }): Promise<void> {
    const status = await this.repository.getTenantDeletionStatus(input.tenantId);

    if (!status.exists) {
      throw new AppError('not_found', 'Tenant not found');
    }

    if (!status.deletedAt) {
      throw new AppError('conflict', 'Tenant has no scheduled deletion');
    }

    const scheduledAt = new Date(status.deletedAt);
    const now = input.now ?? new Date();

    if (scheduledAt.getTime() > now.getTime()) {
      throw new AppError('conflict', 'Grace period has not elapsed yet');
    }

    await this.repository.hardDeleteTenant(input.tenantId);

    // Audit_log row con tenant_id ora nullo (FK on delete set null in
    // 202605080001_audit_log_gdpr_actions.sql). Ne scriviamo una nuova
    // con tenantId=null per registrare l'esecuzione.
    await this.repository.recordAuditLog({
      tenantId: null,
      userId: null,
      action: 'gdpr.tenant.hard_delete.executed',
      resourceType: 'tenant',
      resourceId: input.tenantId,
      ipAddress: null,
      userAgent: null,
      metadata: {
        executedAt: now.toISOString(),
        originallyScheduledAt: status.deletedAt,
        formerTenantId: input.tenantId,
      },
    });
  }

  async listScheduledHardDeletes(now: Date): Promise<ScheduledTenantDeletion[]> {
    return this.repository.listTenantsDueForHardDelete(now);
  }

  /**
   * Cancellazione dei dati di un cliente finale.
   *
   * Nessun conteggio preventivo e nessun 404 su "zero righe": la risposta non
   * rivela piu' se quel numero esista nel tenant, e la richiesta diventa
   * ripetibile. Serve davvero — se la prima chiamata committa e la risposta
   * HTTP si perde, l'operatore deve poter ripetere senza che il sistema debba
   * conservare un'impronta del cliente per riconoscerlo.
   */
  async deleteCustomerData(input: {
    session: AuthSession;
    customerPhone: string;
    actor?: Pick<GdprActor, 'ipAddress' | 'userAgent'>;
    requestId?: string;
    now?: Date;
  }): Promise<CustomerDeletionResult> {
    assertGdprAdmin(input.session);
    const customerPhone = normalizeCustomerPhone(input.customerPhone);
    const requestId = input.requestId ?? randomUUID();

    const result = await this.repository.eraseCustomerData({
      tenantId: input.session.tenantId,
      customerPhone,
      requestId,
      userId: input.session.userId,
      ipAddress: input.actor?.ipAddress ?? null,
      userAgent: input.actor?.userAgent ?? null,
    });

    return {
      tenantId: input.session.tenantId,
      requestId: result.requestId,
      localDeletion: result.localDeletion,
      deleted: result.deleted,
      dissociatedAppointments: result.dissociatedAppointments,
      remoteCleanup: resolveRemoteCleanupState(result),
      pendingObligations: result.pendingObligations,
      manualRequired: result.manualRequired,
      residualSuspected: result.residualSuspected,
    };
  }
}

/**
 * Lo stato peggiore vince.
 *
 * Se esiste anche solo un'obbligazione che nessun automatismo potra' chiudere,
 * l'esito complessivo e' `manual_required`: dire `pending` lascerebbe credere
 * che basti aspettare.
 */
function resolveRemoteCleanupState(result: CustomerErasureRpcResult): RemoteCleanupState {
  if (result.manualRequired > 0) {
    return 'manual_required';
  }

  if (result.pendingObligations > 0) {
    return 'pending';
  }

  return 'not_required';
}

export class SupabaseGdprDeleteRepository implements GdprDeleteRepository {
  private readonly supabase = createSupabaseAdminClient();

  async getTenantDeletionStatus(
    tenantId: string,
  ): Promise<{ deletedAt: string | null; exists: boolean }> {
    const { data, error } = await this.supabase
      .from('tenants')
      .select('deleted_at')
      .eq('id', tenantId)
      .maybeSingle();

    if (error) {
      throw toRepositoryError('Failed to read tenant deletion status', error);
    }

    if (!data) {
      return { deletedAt: null, exists: false };
    }

    const row = data as { deleted_at: string | null };

    return { deletedAt: row.deleted_at, exists: true };
  }

  async scheduleTenantSoftDelete(input: { tenantId: string; deletedAt: Date }): Promise<void> {
    const { error } = await this.supabase
      .from('tenants')
      .update({
        deleted_at: input.deletedAt.toISOString(),
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.tenantId);

    if (error) {
      throw toRepositoryError('Failed to schedule tenant soft delete', error);
    }
  }

  async clearTenantSoftDelete(tenantId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('tenants')
      .update({
        deleted_at: null,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', tenantId)
      .select('id');

    if (error) {
      throw toRepositoryError('Failed to clear tenant soft delete', error);
    }

    return (data ?? []).length > 0;
  }

  async listTenantsDueForHardDelete(now: Date): Promise<ScheduledTenantDeletion[]> {
    const { data, error } = await this.supabase
      .from('tenants')
      .select('id, deleted_at')
      .not('deleted_at', 'is', null)
      .lte('deleted_at', now.toISOString());

    if (error) {
      throw toRepositoryError('Failed to list tenants due for hard delete', error);
    }

    return ((data ?? []) as Array<{ id: string; deleted_at: string }>).map((row) => ({
      tenantId: row.id,
      scheduledHardDeleteAt: row.deleted_at,
    }));
  }

  async hardDeleteTenant(tenantId: string): Promise<void> {
    // Cascade FKs cancellano gia' tutte le tabelle child. audit_log ha
    // ON DELETE SET NULL (vedi 202605080001) quindi sopravvive con
    // tenant_id=null come compliance log.
    const { error } = await this.supabase.from('tenants').delete().eq('id', tenantId);

    if (error) {
      throw toRepositoryError('Failed to hard delete tenant', error);
    }
  }

  /**
   * Una sola chiamata: `public.erase_customer_data` fa tutto dentro una
   * transazione (cancellazioni, cattura del debito remoto, audit).
   *
   * La funzione e' SECURITY INVOKER e gira con la service-role key gia' usata
   * da questo client; l'autorizzazione owner/admin resta a monte nel service.
   */
  async eraseCustomerData(input: {
    tenantId: string;
    customerPhone: string;
    requestId: string;
    userId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<CustomerErasureRpcResult> {
    const { data, error } = await this.supabase.rpc('erase_customer_data', {
      p_tenant_id: input.tenantId,
      p_customer_phone: input.customerPhone,
      p_request_id: input.requestId,
      p_user_id: input.userId,
      p_ip_address: input.ipAddress,
      p_user_agent: input.userAgent,
    });

    if (error) {
      if ((error as { code?: string }).code === PG_INVALID_PARAMETER_VALUE) {
        throw new AppError('bad_request', 'Invalid customer phone number', { cause: error });
      }

      throw toRepositoryError('Failed to erase customer data', error);
    }

    return CustomerErasureRpcResultSchema.parse(data);
  }

  async recordAuditLog(input: AuditLogInput): Promise<void> {
    const { error } = await this.supabase.from('audit_log').insert({
      tenant_id: input.tenantId,
      user_id: input.userId,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      metadata: input.metadata,
    });

    if (error) {
      throw toRepositoryError('Failed to write GDPR delete audit log', error);
    }
  }
}

export function createGdprDeleteService(): GdprDeleteService {
  return new GdprDeleteService(new SupabaseGdprDeleteRepository());
}

function assertOwner(session: AuthSession): asserts session is AuthSession & { role: 'owner' } {
  if (session.role !== 'owner') {
    throw new AppError('forbidden', 'Owner role required');
  }
}

function assertGdprAdmin(
  session: AuthSession,
): asserts session is AuthSession & { role: 'owner' | 'admin' } {
  if (session.role !== 'owner' && session.role !== 'admin') {
    throw new AppError('forbidden', 'Admin role required');
  }
}

function toRepositoryError(message: string, cause: unknown): AppError {
  return new AppError('upstream_error', message, {
    cause,
    expose: false,
  });
}
