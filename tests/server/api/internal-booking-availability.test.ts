// PILOT-P0-2 — l'API interna di disponibilita' e' in scope per la sicurezza,
// non per la copia di prodotto.
//
// Non serve un messaggio dedicato: serve che un guasto della verifica NON
// venga servito come `[]`. Un chiamante interno che riceve una lista vuota
// legge "nessuno slot", esattamente come un cliente su WhatsApp, e prende le
// stesse decisioni sbagliate.

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarAvailabilityUnavailable } from '@/server/calendar/availability-error';

const getAvailableSlots = vi.fn();

vi.mock('@/server/appointments/booking', () => ({
  createAppointmentBookingService: () => ({ getAvailableSlots }),
}));

vi.mock('@/lib/security/static-secret', () => ({
  assertStaticSecretHeader: () => undefined,
}));

const { POST } = await import('@/app/api/internal/booking/availability/route');

const body = {
  tenantId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
  serviceId: '9a8b7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d',
  from: '2026-04-27T09:00:00.000Z',
  to: '2026-04-27T12:00:00.000Z',
};

describe('POST /api/internal/booking/availability (PILOT-P0-2)', () => {
  beforeEach(() => {
    getAvailableSlots.mockReset();
  });

  it('surfaces an upstream error envelope instead of an empty slot list', async () => {
    getAvailableSlots.mockRejectedValueOnce(
      new CalendarAvailabilityUnavailable('Google Calendar freeBusy failed (503)', {
        kind: 'transient',
        httpStatus: 503,
        reason: 'freebusy_http_503',
      }),
    );

    const response = await POST(availabilityRequest());
    const payload = (await response.json()) as {
      ok: boolean;
      data?: unknown;
      error?: { code: string };
    };

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('upstream_error');
    // La prova che conta: nessun payload di disponibilita' di alcun tipo.
    expect(payload.data).toBeUndefined();
  });

  it('still returns verified slots on the healthy path', async () => {
    getAvailableSlots.mockResolvedValueOnce([
      {
        tenantId: body.tenantId,
        serviceId: body.serviceId,
        serviceName: 'Prima visita',
        start: '2026-04-27T09:00:00.000Z',
        end: '2026-04-27T09:30:00.000Z',
        durationMinutes: 30,
        timezone: 'UTC',
      },
    ]);

    const response = await POST(availabilityRequest());
    const payload = (await response.json()) as { ok: boolean; data: unknown[] };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveLength(1);
  });
});

function availabilityRequest(): NextRequest {
  return new NextRequest('https://ambrogio.local/api/internal/booking/availability', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
