import { describe, expect, it } from 'vitest';

import type { AuthSession } from '@/lib/auth/session';
import {
  type CustomerErasureRpcResult,
  type GdprDeleteRepository,
  type ScheduledTenantDeletion,
  GdprDeleteService,
  TENANT_DELETION_GRACE_PERIOD_MS,
} from '@/server/gdpr/data-delete';
import { type AuditLogInput } from '@/server/gdpr/data-export';

const NOW = new Date('2026-05-08T08:00:00.000Z');

describe('GdprDeleteService — tenant deletion lifecycle', () => {
  it('schedules a tenant soft delete with 30 days grace period', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.tenants.set('tenant_1', { exists: true, deletedAt: null });

    const service = new GdprDeleteService(repository);
    const result = await service.requestTenantDeletion({
      session: ownerSession(),
      now: NOW,
      actor: { ipAddress: '203.0.113.5', userAgent: 'Vitest' },
    });

    expect(result.tenantId).toBe('tenant_1');
    expect(result.requestedAt).toBe(NOW.toISOString());

    const expectedHardDeleteAt = new Date(NOW.getTime() + TENANT_DELETION_GRACE_PERIOD_MS);
    expect(result.scheduledHardDeleteAt).toBe(expectedHardDeleteAt.toISOString());
    expect(repository.scheduled).toEqual([
      { tenantId: 'tenant_1', deletedAt: expectedHardDeleteAt },
    ]);
    expect(repository.auditLogs).toEqual([
      expect.objectContaining({
        action: 'gdpr.tenant.deletion.requested',
        resourceType: 'tenant',
        resourceId: 'tenant_1',
        metadata: expect.objectContaining({
          graceDays: 30,
          scheduledHardDeleteAt: expectedHardDeleteAt.toISOString(),
        }),
      }),
    ]);
  });

  it('blocks admin role from requesting tenant deletion (only owner)', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.tenants.set('tenant_1', { exists: true, deletedAt: null });
    const service = new GdprDeleteService(repository);

    await expect(
      service.requestTenantDeletion({
        session: { ...ownerSession(), role: 'admin' },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects double scheduling with conflict', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.tenants.set('tenant_1', {
      exists: true,
      deletedAt: '2026-06-08T08:00:00.000Z',
    });
    const service = new GdprDeleteService(repository);

    await expect(
      service.requestTenantDeletion({ session: ownerSession(), now: NOW }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('cancels a scheduled deletion within the grace period', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.tenants.set('tenant_1', {
      exists: true,
      deletedAt: '2026-06-08T08:00:00.000Z',
    });
    const service = new GdprDeleteService(repository);

    await service.cancelTenantDeletion({ session: ownerSession(), now: NOW });

    expect(repository.cleared).toEqual(['tenant_1']);
    expect(repository.auditLogs).toEqual([
      expect.objectContaining({
        action: 'gdpr.tenant.deletion.cancelled',
      }),
    ]);
  });

  it('refuses hard delete before grace period elapses', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.tenants.set('tenant_1', {
      exists: true,
      deletedAt: '2026-06-08T08:00:00.000Z',
    });
    const service = new GdprDeleteService(repository);

    await expect(
      service.executeTenantHardDelete({ tenantId: 'tenant_1', now: NOW }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('hard deletes tenant once grace period has elapsed and audit-logs with null tenant_id', async () => {
    const repository = new FakeGdprDeleteRepository();
    const past = '2026-05-01T08:00:00.000Z';
    repository.tenants.set('tenant_1', { exists: true, deletedAt: past });
    const service = new GdprDeleteService(repository);

    await service.executeTenantHardDelete({ tenantId: 'tenant_1', now: NOW });

    expect(repository.hardDeleted).toEqual(['tenant_1']);
    const log = repository.auditLogs.find(
      (entry) => entry.action === 'gdpr.tenant.hard_delete.executed',
    );
    expect(log).toBeDefined();
    expect(log?.tenantId).toBeNull();
    expect(log?.userId).toBeNull();
    expect(log?.resourceId).toBe('tenant_1');
  });

  it('lists tenants whose deletion is due', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.scheduledList = [
      { tenantId: 'tenant_1', scheduledHardDeleteAt: '2026-05-01T08:00:00.000Z' },
      { tenantId: 'tenant_2', scheduledHardDeleteAt: '2026-05-08T07:00:00.000Z' },
    ];
    const service = new GdprDeleteService(repository);

    await expect(service.listScheduledHardDeletes(NOW)).resolves.toEqual(repository.scheduledList);
  });
});

describe('GdprDeleteService — customer-level deletion', () => {
  it('normalizza il numero e delega tutto a una sola transazione', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.erasureResult = rpcResult({
      deleted: {
        conversations: 1,
        messages: 4,
        appointments: 1,
        optOuts: 1,
        voiceEvents: 2,
        schedulingDecisions: 3,
      },
    });
    const service = new GdprDeleteService(repository);

    const result = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '+39 333 111 2233',
      now: NOW,
      actor: { ipAddress: '203.0.113.6', userAgent: 'Vitest' },
    });

    expect(result.localDeletion).toBe('complete');
    expect(result.deleted.messages).toBe(4);
    expect(result.deleted.voiceEvents).toBe(2);
    expect(result.deleted.schedulingDecisions).toBe(3);
    expect(repository.erasureCalls).toEqual([
      expect.objectContaining({ tenantId: 'tenant_1', customerPhone: '393331112233' }),
    ]);

    // L'audit lo scrive la transazione SQL, non il service: un audit scritto
    // fuori dalla transazione potrebbe sopravvivere a un rollback e descrivere
    // una cancellazione mai avvenuta.
    expect(repository.auditLogs).toEqual([]);
  });

  it("non rivela piu' se il cliente esiste: zero righe e' un successo", async () => {
    // Prima rispondeva 404, che e' esattamente la risposta che permette di
    // enumerare quali numeri esistono nel tenant. E rendeva impossibile
    // ripetere una richiesta la cui risposta si era persa.
    const repository = new FakeGdprDeleteRepository();
    repository.erasureResult = rpcResult({});
    const service = new GdprDeleteService(repository);

    const result = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '393331112233',
      now: NOW,
    });

    expect(result.localDeletion).toBe('complete');
    expect(result.deleted.conversations).toBe(0);
    expect(result.remoteCleanup).toBe('not_required');
  });

  it('dichiara pending quando esiste debito remoto catturato', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.erasureResult = rpcResult({ pendingObligations: 2 });
    const service = new GdprDeleteService(repository);

    const result = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '393331112233',
      now: NOW,
    });

    // Mai "completato": in P0-3A nessuno converge il debito remoto.
    expect(result.remoteCleanup).toBe('pending');
    expect(result.pendingObligations).toBe(2);
  });

  it('lo stato peggiore vince: manual_required prevale su pending', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.erasureResult = rpcResult({ pendingObligations: 5, manualRequired: 1 });
    const service = new GdprDeleteService(repository);

    const result = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '393331112233',
      now: NOW,
    });

    // Dire `pending` lascerebbe credere che basti aspettare.
    expect(result.remoteCleanup).toBe('manual_required');
  });

  it('propaga il conteggio dei residui ambigui senza cancellarli', async () => {
    const repository = new FakeGdprDeleteRepository();
    repository.erasureResult = rpcResult({ residualSuspected: 1 });
    const service = new GdprDeleteService(repository);

    const result = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '393331112233',
      now: NOW,
    });

    expect(result.residualSuspected).toBe(1);
  });

  it('un residuo sospetto impedisce di dichiarare completa la cancellazione locale', async () => {
    // L'identita' esatta e' sparita, ma e' rimasto qualcosa che potrebbe
    // essere la stessa persona sotto un altro prefisso. Dire "completo"
    // metterebbe un titolo rassicurante sopra un lavoro non finito, e nessuno
    // andrebbe a leggere il contatore in fondo alla risposta.
    const repository = new FakeGdprDeleteRepository();
    repository.erasureResult = rpcResult({ residualSuspected: 2 });
    const service = new GdprDeleteService(repository);

    const result = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '393331112233',
      now: NOW,
    });

    expect(result.localDeletion).toBe('manual_review_required');
    expect(result.residualSuspected).toBe(2);
  });

  it("l'ambiguita' locale e il debito Google restano due dimensioni separate", async () => {
    // Si chiudono in due modi diversi: una rileggendo l'anagrafica, l'altro
    // cancellando un evento su Google. Confonderle vorrebbe dire chiuderne
    // una credendo di aver chiuso l'altra.
    const repository = new FakeGdprDeleteRepository();
    repository.erasureResult = rpcResult({ residualSuspected: 1, pendingObligations: 3 });
    const service = new GdprDeleteService(repository);

    const result = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '393331112233',
      now: NOW,
    });

    expect(result.localDeletion).toBe('manual_review_required');
    expect(result.remoteCleanup).toBe('pending');
    expect(result.pendingObligations).toBe(3);

    // E il contrario: debito remoto senza ambiguita' locale.
    repository.erasureResult = rpcResult({ pendingObligations: 3 });

    const clean = await service.deleteCustomerData({
      session: adminSession(),
      customerPhone: '393331112233',
      now: NOW,
    });

    expect(clean.localDeletion).toBe('complete');
    expect(clean.remoteCleanup).toBe('pending');
  });

  it('blocca un ruolo non admin', async () => {
    const repository = new FakeGdprDeleteRepository();
    const service = new GdprDeleteService(repository);

    await expect(
      service.deleteCustomerData({
        session: { ...ownerSession(), role: 'member' } as AuthSession,
        customerPhone: '393331112233',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    expect(repository.erasureCalls).toEqual([]);
  });
});

class FakeGdprDeleteRepository implements GdprDeleteRepository {
  readonly tenants = new Map<string, { exists: boolean; deletedAt: string | null }>();
  readonly scheduled: Array<{ tenantId: string; deletedAt: Date }> = [];
  readonly cleared: string[] = [];
  readonly hardDeleted: string[] = [];
  readonly auditLogs: AuditLogInput[] = [];
  readonly erasureCalls: Array<{ tenantId: string; customerPhone: string; requestId: string }> = [];

  scheduledList: ScheduledTenantDeletion[] = [];
  erasureResult: CustomerErasureRpcResult = rpcResult({});

  async getTenantDeletionStatus(
    tenantId: string,
  ): Promise<{ deletedAt: string | null; exists: boolean }> {
    return this.tenants.get(tenantId) ?? { exists: false, deletedAt: null };
  }

  async scheduleTenantSoftDelete(input: { tenantId: string; deletedAt: Date }): Promise<void> {
    this.scheduled.push(input);
    const current = this.tenants.get(input.tenantId);

    if (current) {
      this.tenants.set(input.tenantId, {
        ...current,
        deletedAt: input.deletedAt.toISOString(),
      });
    }
  }

  async clearTenantSoftDelete(tenantId: string): Promise<boolean> {
    this.cleared.push(tenantId);
    const current = this.tenants.get(tenantId);

    if (!current) {
      return false;
    }

    this.tenants.set(tenantId, { ...current, deletedAt: null });
    return true;
  }

  async listTenantsDueForHardDelete(_now: Date): Promise<ScheduledTenantDeletion[]> {
    return this.scheduledList;
  }

  async hardDeleteTenant(tenantId: string): Promise<void> {
    this.hardDeleted.push(tenantId);
    this.tenants.delete(tenantId);
  }

  async eraseCustomerData(input: {
    tenantId: string;
    customerPhone: string;
    requestId: string;
  }): Promise<CustomerErasureRpcResult> {
    this.erasureCalls.push({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      requestId: input.requestId,
    });

    return { ...this.erasureResult, requestId: input.requestId };
  }

  async recordAuditLog(input: AuditLogInput): Promise<void> {
    this.auditLogs.push(input);
  }
}

function rpcResult(overrides: Partial<CustomerErasureRpcResult>): CustomerErasureRpcResult {
  const residualSuspected = overrides.residualSuspected ?? 0;

  return {
    requestId: '00000000-0000-4000-8000-000000000000',
    executedAt: NOW.toISOString(),
    // Rispecchia la regola della transazione SQL, cosi' un fixture non puo'
    // descrivere uno stato che il database non produrrebbe mai.
    localDeletion: residualSuspected > 0 ? 'manual_review_required' : 'complete',
    dissociatedAppointments: 0,
    pendingObligations: 0,
    manualRequired: 0,
    residualSuspected: 0,
    ...overrides,
    deleted: {
      conversations: 0,
      messages: 0,
      appointments: 0,
      optOuts: 0,
      voiceEvents: 0,
      schedulingDecisions: 0,
      ...overrides.deleted,
    },
  };
}

function ownerSession(): AuthSession {
  return {
    userId: 'user_1',
    tenantId: 'tenant_1',
    role: 'owner',
  };
}

function adminSession(): AuthSession {
  return { ...ownerSession(), role: 'admin' };
}
