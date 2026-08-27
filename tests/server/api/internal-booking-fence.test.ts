// PILOT-P0-3C-i — cattura precoce dell'epoca e rifiuto tipizzato sull'API
// interna di prenotazione.
//
// Due proprieta', entrambe di ORDINE e di CONFINE:
//
//   1. l'epoca si legge subito dopo il parse del body e PRIMA di qualunque
//      lettura di stato applicativo. Letta piu' tardi, una richiesta partita
//      prima di una cancellazione adotterebbe l'autorita' nuova.
//
//   2. il rifiuto esce come conflitto tipizzato, senza numeri di epoca. Quei
//      numeri sono stato interno del fence: non dicono niente al chiamante e
//      rivelerebbero il ritmo delle cancellazioni del tenant.

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { staleProjectionEpochError } from '@/server/appointments/projection-fence';

const trace: string[] = [];
const createAppointment = vi.fn();
const capture = vi.fn();

vi.mock('@/server/appointments/booking', () => ({
  createAppointmentBookingService: () => ({
    createAppointment: (input: unknown) => {
      trace.push('createAppointment');
      return createAppointment(input);
    },
  }),
}));

vi.mock('@/server/appointments/projection-fence', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/server/appointments/projection-fence',
  );

  return {
    ...actual,
    createProjectionFenceReader: () => ({
      capture: (tenantId: string) => {
        trace.push('captureProjectionEpoch');
        return capture(tenantId);
      },
    }),
  };
});

vi.mock('@/lib/security/static-secret', () => ({
  assertStaticSecretHeader: () => undefined,
}));

const { POST } = await import('@/app/api/internal/booking/appointments/route');

const TENANT_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';

const body = {
  tenantId: TENANT_ID,
  serviceId: '9a8b7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d',
  customerIdentifier: '393331112233',
  customerName: 'Mario Rossi',
  scheduledAt: '2026-04-27T09:00:00.000Z',
};

describe('POST /api/internal/booking/appointments (PILOT-P0-3C-i)', () => {
  beforeEach(() => {
    trace.length = 0;
    createAppointment.mockReset();
    capture.mockReset();
  });

  it('captures the projection epoch before calling the booking service', async () => {
    capture.mockResolvedValueOnce({ tenantId: TENANT_ID, projectionEpoch: 11 });
    createAppointment.mockResolvedValueOnce({ appointmentId: 'appointment_1' });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(trace).toEqual(['captureProjectionEpoch', 'createAppointment']);
    expect(capture).toHaveBeenCalledWith(TENANT_ID);

    // E l'epoca osservata viaggia esplicita fino al servizio.
    expect(createAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ expectedProjectionEpoch: 11 }),
    );
  });

  it('answers a stale request with a typed 409 that names no epoch', async () => {
    capture.mockResolvedValueOnce({ tenantId: TENANT_ID, projectionEpoch: 12 });
    createAppointment.mockRejectedValueOnce(staleProjectionEpochError());

    const response = await POST(request());
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };

    expect(response.status).toBe(409);
    expect(payload.error?.code).toBe('conflict');
    expect(payload.error?.message).toBe('stale_projection_epoch');

    // Nessun numero di epoca nel corpo servito al chiamante.
    expect(JSON.stringify(payload)).not.toMatch(/\b1[12]\b/);
  });

  it('does not reach the booking service when the tenant authority is gone', async () => {
    // Il lettore solleva: il tenant non esiste piu'. Proiettare PII per conto
    // di un tenant che non c'e' non e' un caso da indovinare.
    capture.mockRejectedValueOnce(staleProjectionEpochError());

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(trace).toEqual(['captureProjectionEpoch']);
    expect(createAppointment).not.toHaveBeenCalled();
  });
});

function request(): NextRequest {
  return new NextRequest('https://example.com/api/internal/booking/appointments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
