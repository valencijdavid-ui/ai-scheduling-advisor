import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors/app-error';
import {
  CalendarAvailabilityUnavailable,
  isCalendarAvailabilityUnavailable,
} from '@/server/calendar/availability-error';
import { GoogleCalendarProvider, type GoogleCalendarIntegration } from '@/server/calendar/google';

/**
 * PILOT-P0-2 — `listBusy` come confine di normalizzazione.
 *
 * La proprieta' sotto esame e' una sola e vale per ogni test di questo file:
 * nessun guasto previsto puo' produrre una lista di fasce occupate. Una lista
 * vuota significa "Google ha guardato e il calendario e' libero", ed e'
 * un'affermazione che solo Google puo' fare.
 */
describe('GoogleCalendarProvider availability (PILOT-P0-2)', () => {
  describe('freeBusy transport and HTTP failures', () => {
    it('turns a 429 into a typed transient availability failure, never an empty list', async () => {
      const provider = providerWith(errorResponse(429, { error: { code: 429 } }));

      const error = await listBusyError(provider);

      expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
      expect(error.kind).toBe('transient');
      expect(error.httpStatus).toBe(429);
      // Un guasto passeggero non deve mai marcare l'integrazione del tenant.
      expect(error.isPermanentIntegrationAuthFailure).toBe(false);
    });

    it('turns a 503 into a typed transient availability failure', async () => {
      const provider = providerWith(errorResponse(503, {}));

      const error = await listBusyError(provider);

      expect(error.kind).toBe('transient');
      expect(error.httpStatus).toBe(503);
    });

    it('treats a generic 403 as transient, not as broken integration credentials', async () => {
      // Google usa 403 anche per quota e rate limit di progetto: marcarlo come
      // auth manderebbe in remediation integrazioni perfettamente sane.
      const provider = providerWith(errorResponse(403, { error: { code: 403 } }));

      const error = await listBusyError(provider);

      expect(error.kind).toBe('transient');
      expect(error.isPermanentIntegrationAuthFailure).toBe(false);
    });

    it('treats a definite Google 401 as a permanent integration auth failure', async () => {
      const provider = providerWith(errorResponse(401, {}));

      const error = await listBusyError(provider);

      expect(error.kind).toBe('auth');
      expect(error.isPermanentIntegrationAuthFailure).toBe(true);
    });

    it('turns a transport failure into a typed availability failure', async () => {
      const fetcher = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const provider = new GoogleCalendarProvider({ fetcher });

      const error = await listBusyError(provider);

      expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
      expect(error.kind).toBe('transient');
      expect(error.reason).toBe('freebusy_transport_failure');
    });

    it('bounds a hung freeBusy at the availability budget without retrying', async () => {
      vi.useFakeTimers();

      try {
        const fetcher = vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
              });
            }),
        );
        const provider = new GoogleCalendarProvider({ fetcher });
        const pending = provider
          .listBusy(availabilityWindow())
          .then(() => null)
          .catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(3_000);
        const error = await pending;

        expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
        // Zero retry automatici: il ritentativo e' un gesto del cliente.
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('strict freeBusy parsing of successful responses', () => {
    it('fails closed on a 200 whose body does not satisfy the success schema', async () => {
      const provider = providerWith(jsonResponse({ calendars: 'not-a-map' }));

      const error = await listBusyError(provider);

      expect(error.kind).toBe('invalid_response');
      expect(error.reason).toBe('freebusy_schema_invalid');
    });

    it('fails closed when the requested calendar carries errors[]', async () => {
      const provider = providerWith(
        jsonResponse({
          calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } },
        }),
      );

      const error = await listBusyError(provider);

      expect(error.kind).toBe('provider_rejected');
      expect(error.reason).toBe('freebusy_calendar_error:notFound');
    });

    it('fails closed when the requested calendar key is missing entirely', async () => {
      // Google non ha detto "libero": non ha detto niente del calendario
      // che abbiamo chiesto.
      const provider = providerWith(jsonResponse({ calendars: { other_calendar: { busy: [] } } }));

      const error = await listBusyError(provider);

      expect(error.kind).toBe('invalid_response');
      expect(error.reason).toBe('freebusy_calendar_missing');
    });

    it('fails closed on a busy interval it cannot read', async () => {
      const provider = providerWith(
        jsonResponse({
          calendars: { primary: { busy: [{ start: 'not-a-date', end: 'not-a-date' }] } },
        }),
      );

      const error = await listBusyError(provider);

      expect(error.kind).toBe('invalid_response');
      expect(error.reason).toBe('freebusy_interval_invalid');
    });

    it('fails closed on a busy interval with a missing endpoint', async () => {
      const provider = providerWith(
        jsonResponse({
          calendars: { primary: { busy: [{ start: '2026-04-27T09:00:00.000Z' }] } },
        }),
      );

      const error = await listBusyError(provider);

      expect(error.kind).toBe('invalid_response');
      expect(error.reason).toBe('freebusy_schema_invalid');
    });

    it('accepts a valid empty calendar as the only Google-empty case', async () => {
      const provider = providerWith(jsonResponse({ calendars: { primary: { busy: [] } } }));

      await expect(provider.listBusy(availabilityWindow())).resolves.toEqual([]);
    });
  });

  describe('token acquisition inside the availability boundary', () => {
    it('classifies invalid_grant from the raw token body as a permanent auth failure', async () => {
      // Il parser lenient dei token, davanti a un body che non riconosce,
      // ritorna `{}`: leggere solo quello nasconderebbe la revoca del consenso
      // dietro un "riprova piu' tardi" che non si risolve mai da solo.
      const fetcher = vi.fn(async () =>
        jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired' }, 400),
      );
      const provider = new GoogleCalendarProvider({
        fetcher,
        oauthClientId: 'client_id',
        oauthClientSecret: 'client_secret',
      });

      const error = await listBusyError(
        provider,
        integration({ credentials: { refresh_token: 'refresh_1' } }),
      );

      expect(error.kind).toBe('auth');
      expect(error.reason).toBe('invalid_grant');
      expect(error.isPermanentIntegrationAuthFailure).toBe(true);
    });

    it('classifies missing stored credentials as a permanent auth failure', async () => {
      const provider = providerWith(jsonResponse({}));

      const error = await listBusyError(provider, integration({ credentials: {} }));

      expect(error.kind).toBe('auth');
      expect(error.reason).toBe('missing_credentials');
    });

    it('turns a token refresh HTTP failure into a typed availability failure', async () => {
      const fetcher = vi.fn(async () => errorResponse(500, {}));
      const provider = new GoogleCalendarProvider({
        fetcher,
        oauthClientId: 'client_id',
        oauthClientSecret: 'client_secret',
      });

      const error = await listBusyError(
        provider,
        integration({ credentials: { refresh_token: 'refresh_1' } }),
      );

      expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
      expect(error.kind).toBe('transient');
      expect(error.isPermanentIntegrationAuthFailure).toBe(false);
    });

    it('turns a token refresh transport failure into a typed availability failure', async () => {
      const fetcher = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const provider = new GoogleCalendarProvider({
        fetcher,
        oauthClientId: 'client_id',
        oauthClientSecret: 'client_secret',
      });

      const error = await listBusyError(
        provider,
        integration({ credentials: { refresh_token: 'refresh_1' } }),
      );

      expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
      expect(error.kind).toBe('transient');
    });

    it('turns a token-persistence repository failure into a typed availability failure', async () => {
      const fetcher = vi
        .fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ access_token: 'fresh_access', expires_in: 3600 }));
      const provider = new GoogleCalendarProvider({
        fetcher,
        oauthClientId: 'client_id',
        oauthClientSecret: 'client_secret',
        onTokenRefresh: async () => {
          throw new AppError('upstream_error', 'Failed to persist refreshed token', {
            expose: false,
          });
        },
      });

      const error = await listBusyError(
        provider,
        integration({ credentials: { refresh_token: 'refresh_1' } }),
      );

      expect(isCalendarAvailabilityUnavailable(error)).toBe(true);
      // Un guasto del nostro database non dice niente sull'integrazione del
      // tenant: non deve marcarla come da ricollegare.
      expect(error.isPermanentIntegrationAuthFailure).toBe(false);
    });

    it('reports a missing OAuth client configuration without blaming the tenant integration', async () => {
      const provider = new GoogleCalendarProvider({
        fetcher: vi.fn(async () => jsonResponse({})),
        oauthClientId: '',
        oauthClientSecret: '',
      });

      const error = await listBusyError(
        provider,
        integration({ credentials: { refresh_token: 'refresh_1' } }),
      );

      expect(error.kind).toBe('configuration');
      expect(error.isPermanentIntegrationAuthFailure).toBe(false);
    });
  });

  describe('normalization stays narrow', () => {
    it('lets an arbitrary programming failure propagate unnormalized', async () => {
      // Un difetto del nostro codice mascherato da "riprova fra poco" e' un
      // difetto che nessuno vedra' mai: deve restare rumoroso. Qui il
      // `TypeError` nasce dentro la logica di `listBusy`, fuori da ogni
      // operazione-dipendenza nota, e deve arrivare intatto al chiamante.
      const boom = new TypeError('response.ok is not readable');
      const response = new Response('{}', { status: 200 });

      Object.defineProperty(response, 'ok', {
        get() {
          throw boom;
        },
      });

      const provider = new GoogleCalendarProvider({ fetcher: async () => response });

      const error = await provider
        .listBusy(availabilityWindow())
        .then(() => null)
        .catch((caught: unknown) => caught);

      expect(error).toBe(boom);
      expect(isCalendarAvailabilityUnavailable(error)).toBe(false);
    });

    it('does not apply the availability network budget to write operations', async () => {
      vi.useFakeTimers();

      try {
        const fetcher = vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
              });
              setTimeout(() => {
                resolve(jsonResponse({ id: 'event_1' }));
              }, 5_000);
            }),
        );
        const provider = new GoogleCalendarProvider({ fetcher });
        const pending = provider.createEvent({
          integration: integration(),
          appointmentId: 'appointment_1',
          tenantId: 'tenant_1',
          summary: 'Prima visita',
          start: new Date('2026-04-27T09:00:00.000Z'),
          end: new Date('2026-04-27T09:30:00.000Z'),
          timezone: 'UTC',
          customerName: 'Cliente',
        });

        // Oltre il budget della disponibilita': la scrittura di PILOT-P0-1
        // deve essere ancora viva.
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(pending).resolves.toMatchObject({ eventId: 'event_1' });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

function providerWith(response: Response): GoogleCalendarProvider {
  return new GoogleCalendarProvider({ fetcher: async () => response });
}

async function listBusyError(
  provider: GoogleCalendarProvider,
  used: GoogleCalendarIntegration = integration(),
): Promise<CalendarAvailabilityUnavailable> {
  const error = await provider
    .listBusy({ ...availabilityWindow(), integration: used })
    .then(() => null)
    .catch((caught: unknown) => caught);

  if (!(error instanceof CalendarAvailabilityUnavailable)) {
    throw new Error(`Expected CalendarAvailabilityUnavailable, received: ${String(error)}`);
  }

  return error;
}

function availabilityWindow(): {
  integration: GoogleCalendarIntegration;
  from: Date;
  to: Date;
  timezone: string;
} {
  return {
    integration: integration(),
    from: new Date('2026-04-27T09:00:00.000Z'),
    to: new Date('2026-04-27T12:00:00.000Z'),
    timezone: 'UTC',
  };
}

function integration(
  overrides: Partial<GoogleCalendarIntegration> = {},
): GoogleCalendarIntegration {
  return {
    id: 'integration_1',
    tenantId: 'tenant_1',
    externalAccountId: null,
    credentials: { access_token: 'access_1' },
    config: { calendar_id: 'primary' },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return jsonResponse(body, status);
}
