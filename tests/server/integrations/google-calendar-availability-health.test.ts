// PILOT-P0-2 — ciclo di vita dei marcatori di salute della disponibilita'.
//
// Il marcatore permanente e' cio' che sveglia un operatore. Se sopravvivesse
// alla riconnessione, l'operatore rifarebbe un lavoro gia' fatto; se
// sopravvivesse alla disconnessione, resterebbe acceso un allarme che nessuno
// puo' piu' risolvere, perche' non c'e' piu' niente da ricollegare.
//
// Entrambe le pulizie devono avvenire nella STESSA mutazione che cambia lo
// stato dell'integrazione: separarle lascerebbe una finestra in cui
// l'integrazione e' gia' sana e il watchdog la considera ancora rotta.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateBuilder = {
  eq: vi.fn(),
  select: vi.fn(),
  is: vi.fn(),
  maybeSingle: vi.fn(),
  single: vi.fn(),
};
const updateMock = vi.fn((_mutation: Record<string, unknown>) => updateBuilder);
const insertMock = vi.fn((_row: Record<string, unknown>) => updateBuilder);
const selectMock = vi.fn((_columns: string) => updateBuilder);
const fromMock = vi.fn(() => ({
  update: updateMock,
  insert: insertMock,
  select: selectMock,
}));
const adminClientMock = { from: fromMock };

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(() => adminClientMock),
}));

const { SupabaseGoogleCalendarOAuthRepository } =
  await import('@/server/integrations/google-calendar-oauth');
const { SupabaseAppointmentBookingRepository } = await import('@/server/appointments/booking');

const now = new Date('2026-08-24T10:00:00.000Z');

describe('Google Calendar availability health lifecycle (PILOT-P0-2)', () => {
  beforeEach(() => {
    fromMock.mockClear();
    updateMock.mockClear();
    insertMock.mockClear();
    selectMock.mockClear();
    updateBuilder.eq.mockReset();
    updateBuilder.select.mockReset();
    updateBuilder.is.mockReset();
    updateBuilder.maybeSingle.mockReset();
    updateBuilder.single.mockReset();
    updateBuilder.eq.mockReturnValue(updateBuilder);
    updateBuilder.is.mockReturnValue(updateBuilder);
    updateBuilder.select.mockReturnValue(updateBuilder);
  });

  it('clears both health fields in the same mutation that restores credentials', async () => {
    // Prima lettura: nessuna integrazione esistente -> insert.
    updateBuilder.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    updateBuilder.single.mockResolvedValueOnce({
      data: {
        id: 'integration_1',
        tenant_id: 'tenant_1',
        external_display_id: 'Google Calendar',
        credentials: {},
        config: {},
        status: 'active',
        last_sync_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      error: null,
    });
    const repository = new SupabaseGoogleCalendarOAuthRepository();

    await repository.upsertGoogleCalendarIntegration({
      tenantId: 'tenant_1',
      userId: 'user_1',
      credentials: { access_token: 'access_1' },
      config: { calendar_id: 'primary' },
      connectedAt: now,
    });

    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        availability_error_code: null,
        availability_error_at: null,
      }),
    );
  });

  it('clears both health fields when the integration is deliberately disconnected', async () => {
    updateBuilder.eq.mockReturnValueOnce(updateBuilder);
    updateBuilder.eq.mockReturnValueOnce(updateBuilder);
    updateBuilder.eq.mockResolvedValueOnce({ error: null });
    const repository = new SupabaseGoogleCalendarOAuthRepository();

    await repository.markGoogleCalendarDisconnected({
      tenantId: 'tenant_1',
      integrationId: 'integration_1',
      disconnectedAt: now,
    });

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'revoked',
        availability_error_code: null,
        availability_error_at: null,
      }),
    );
  });

  it('writes the availability marker without touching integrations.status', async () => {
    // La selezione dell'integrazione attiva e' la stessa che PILOT-P0-1 usa
    // per riconciliare eventi gia' promessi: un guasto di LETTURA non deve
    // poter spegnere la convergenza delle SCRITTURE.
    updateBuilder.eq.mockReturnValueOnce(updateBuilder);
    updateBuilder.eq.mockReturnValueOnce(updateBuilder);
    updateBuilder.eq.mockResolvedValueOnce({ error: null });
    const repository = new SupabaseAppointmentBookingRepository();

    await repository.markGoogleAvailabilityError({
      tenantId: 'tenant_1',
      integrationId: 'integration_1',
      errorCode: 'google_availability_auth',
      occurredAt: now,
    });

    expect(fromMock).toHaveBeenCalledWith('integrations');
    const mutation = updateMock.mock.calls[0]?.[0];
    expect(mutation).toEqual({
      availability_error_code: 'google_availability_auth',
      availability_error_at: now.toISOString(),
    });
    expect(mutation).not.toHaveProperty('status');
  });

  it('clears the availability marker without touching integrations.status', async () => {
    updateBuilder.eq.mockReturnValueOnce(updateBuilder);
    updateBuilder.eq.mockReturnValueOnce(updateBuilder);
    updateBuilder.eq.mockResolvedValueOnce({ error: null });
    const repository = new SupabaseAppointmentBookingRepository();

    await repository.clearGoogleAvailabilityError({
      tenantId: 'tenant_1',
      integrationId: 'integration_1',
    });

    const mutation = updateMock.mock.calls[0]?.[0];
    expect(mutation).toEqual({
      availability_error_code: null,
      availability_error_at: null,
    });
    expect(mutation).not.toHaveProperty('status');
  });
});
