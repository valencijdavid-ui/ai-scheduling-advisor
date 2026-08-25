import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors/app-error';
import { applyRateLimit, resetRateLimitCachesForTests } from '@/lib/rate-limit/apply';
import { RATE_LIMIT_POLICIES } from '@/lib/rate-limit/policies';

describe('applyRateLimit', () => {
  afterEach(() => {
    resetRateLimitCachesForTests();
  });

  it('exposes named policies with positive window and limit', () => {
    for (const [name, policy] of Object.entries(RATE_LIMIT_POLICIES)) {
      expect(policy.window, `policy ${name} window must be > 0`).toBeGreaterThan(0);
      expect(policy.limit, `policy ${name} limit must be > 0`).toBeGreaterThan(0);
    }
  });

  it('allows up to `limit` requests for a given identifier and denies the next one', async () => {
    // settingsWrite: 30 / minuto. Usiamo 30 chiamate consentite + 1 negata.
    const policyKey = 'settingsWrite';
    const identifier = { kind: 'tenantId', value: 'tenant-A' } as const;
    const { limit } = RATE_LIMIT_POLICIES[policyKey];

    for (let i = 0; i < limit; i += 1) {
      const decision = await applyRateLimit(policyKey, identifier);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(limit - (i + 1));
    }

    await expect(applyRateLimit(policyKey, identifier)).rejects.toBeInstanceOf(AppError);
    await expect(applyRateLimit(policyKey, identifier)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('isolates buckets by identifier kind+value (separate limits for different tenants)', async () => {
    const policyKey = 'settingsWrite';
    const { limit } = RATE_LIMIT_POLICIES[policyKey];

    for (let i = 0; i < limit; i += 1) {
      await applyRateLimit(policyKey, { kind: 'tenantId', value: 'tenant-X' });
    }

    // Tenant Y deve essere indipendente: la prima richiesta passa.
    const decisionY = await applyRateLimit(policyKey, { kind: 'tenantId', value: 'tenant-Y' });
    expect(decisionY.allowed).toBe(true);
    expect(decisionY.remaining).toBe(limit - 1);
  });

  it('isolates buckets by policy (different policies are independent)', async () => {
    // Esauriamo la policy onboarding per user-1.
    const onboardingLimit = RATE_LIMIT_POLICIES.onboarding.limit;
    for (let i = 0; i < onboardingLimit; i += 1) {
      await applyRateLimit('onboarding', { kind: 'userId', value: 'user-1' });
    }

    // settingsWrite per lo stesso identifier (tenantId) deve restare libero.
    const decision = await applyRateLimit('settingsWrite', {
      kind: 'tenantId',
      value: 'user-1',
    });
    expect(decision.allowed).toBe(true);
  });

  it('isolates buckets by identifier kind even for the same value', async () => {
    const policyKey = 'settingsWrite';
    const { limit } = RATE_LIMIT_POLICIES[policyKey];

    // Esauriamo per tenantId='shared'.
    for (let i = 0; i < limit; i += 1) {
      await applyRateLimit(policyKey, { kind: 'tenantId', value: 'shared' });
    }

    // userId='shared' deve essere una bucket diversa.
    const decision = await applyRateLimit(policyKey, { kind: 'userId', value: 'shared' });
    expect(decision.allowed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // PILOT-P0-3A — la cancellazione di un cliente ha una policy sua (R4)
  //
  // Prima condivideva `gdprDelete` con la chiusura dell'account: stessa policy,
  // stessa chiave userId, quindi stesso bucket. Erano due diritti diversi che
  // spendevano lo stesso budget, e il budget era uno al giorno.
  // ---------------------------------------------------------------------------

  it('customer erasure does not consume the tenant-account deletion bucket', async () => {
    const { limit } = RATE_LIMIT_POLICIES.gdprCustomerErasure;

    // Un admin esaurisce l'intera capacita' oraria di cancellazione clienti.
    for (let i = 0; i < limit; i += 1) {
      await applyRateLimit('gdprCustomerErasure', { kind: 'userId', value: 'user-gdpr' });
    }

    // Chiudere l'account del tenant e' un diritto diverso: deve restare intatto.
    const decision = await applyRateLimit('gdprDelete', { kind: 'userId', value: 'user-gdpr' });
    expect(decision.allowed).toBe(true);
  });

  it('tenant-account deletion does not consume the customer-erasure bucket', async () => {
    // gdprDelete e' 1/24h: una chiamata lo satura.
    await applyRateLimit('gdprDelete', { kind: 'userId', value: 'user-account' });
    await expect(
      applyRateLimit('gdprDelete', { kind: 'userId', value: 'user-account' }),
    ).rejects.toBeInstanceOf(AppError);

    // E la cancellazione clienti dello stesso utente deve essere ancora piena.
    const decision = await applyRateLimit('gdprCustomerErasure', {
      kind: 'userId',
      value: 'user-account',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(RATE_LIMIT_POLICIES.gdprCustomerErasure.limit - 1);
  });

  it('allows an immediate retry after a single customer erasure request', async () => {
    // Il servizio e' stato reso ripetibile apposta: se la risposta HTTP si
    // perde, l'operatore deve poter ripetere subito. Con 1/24h la ritentava
    // il giorno dopo, il che rendeva inutile tutta quella progettazione.
    const identifier = { kind: 'userId', value: 'user-retry' } as const;

    await applyRateLimit('gdprCustomerErasure', identifier);
    const retry = await applyRateLimit('gdprCustomerErasure', identifier);

    expect(retry.allowed).toBe(true);
  });

  it('still denies customer erasure once the burst is spent', async () => {
    // Separare i bucket non deve voler dire togliere il limite: una sessione
    // admin rubata non deve poter svuotare l'anagrafica a raffica.
    const identifier = { kind: 'userId', value: 'user-burst' } as const;
    const { limit } = RATE_LIMIT_POLICIES.gdprCustomerErasure;

    for (let i = 0; i < limit; i += 1) {
      const decision = await applyRateLimit('gdprCustomerErasure', identifier);
      expect(decision.allowed).toBe(true);
    }

    await expect(applyRateLimit('gdprCustomerErasure', identifier)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('returns retryAfter >= 0 in the AppError on denial', async () => {
    const policyKey = 'gdprExport'; // limit=1, una chiamata satura.
    await applyRateLimit(policyKey, { kind: 'userId', value: 'user-export' });

    try {
      await applyRateLimit(policyKey, { kind: 'userId', value: 'user-export' });
      expect.fail('expected applyRateLimit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('rate_limited');
      expect(appError.status).toBe(429);
      expect(appError.expose).toBe(true);
      expect(appError.message).toMatch(/Retry after \d+s/);
    }
  });
});
