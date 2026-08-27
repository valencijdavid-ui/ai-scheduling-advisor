// PILOT-P0-3C-i — REGRESSIONE. L'esito di una DELETE resta distinguibile.
//
// Questo file nasce in P0-3C come CARATTERIZZAZIONE: `cancelEvent` trattava
// 200, 204, 404 e 410 come lo stesso esito, e i test affermavano la perdita.
// C-i ripara il difetto (C6), quindi le stesse scene restano ma le asserzioni
// si rovesciano: da "l'informazione e' persa" a "l'informazione c'e'".
//
// Perche' e' load-bearing: un worker che converge le obbligazioni puo'
// scrivere `converged` solo su prove. Se manda la DELETE al calendario
// sbagliato riceve 404 — e se 404 valesse "fatto" chiuderebbe un debito il cui
// evento, con dentro il telefono del cliente, e' vivo altrove.

import { describe, expect, it, vi } from 'vitest';

import { GoogleCalendarProvider, type GoogleCalendarIntegration } from '@/server/calendar/google';
import {
  convergeCalendarEvent,
  type CalendarConvergenceTarget,
} from '@/server/appointments/calendar-convergence';

describe('PILOT-P0-3C-i — esito di cancelEvent', () => {
  it('separates 204 from 404 and 410 instead of collapsing them', async () => {
    const outcomes = await Promise.all(
      [204, 404, 410].map(async (status) => {
        const provider = new GoogleCalendarProvider({
          fetcher: vi.fn(async () => new Response(null, { status })),
        });

        return provider.cancelEvent({ integration: integration(), eventId: 'apt_1' });
      }),
    );

    const [deleted, absent, gone] = outcomes;

    // 204 = l'evento c'era e non c'e' piu'.
    expect(deleted).toEqual({
      outcome: 'deleted',
      calendarId: 'studio@example.com',
      httpStatus: 204,
    });

    // 404/410 = non c'era SU QUESTO CALENDARIO. Non e' una cancellazione.
    expect(absent).toMatchObject({ outcome: 'already_absent', httpStatus: 404 });
    expect(gone).toMatchObject({ outcome: 'already_absent', httpStatus: 410 });

    // Il fatto positivo non e' piu' confondibile con i due negativi...
    expect(deleted).not.toEqual(absent);
    expect(deleted).not.toEqual(gone);

    // ...e lo status HTTP resta leggibile, cosi' che 404 e 410 restino
    // distinguibili fra loro per chi dovra' deciderne il significato.
    expect(outcomes.map((outcome) => outcome.httpStatus)).toEqual([204, 404, 410]);
  });

  it('keeps the convergence result different when nothing was actually deleted', async () => {
    // La distinzione non si ferma al provider: risale fino all'esito della
    // convergenza, che e' cio' che il reconciler registra in Postgres.
    const target: CalendarConvergenceTarget = {
      tenantId: 'tenant_1',
      appointmentId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
      eventId: 'apt_1',
      status: 'cancelled',
      start: new Date('2026-04-27T09:00:00.000Z'),
      end: new Date('2026-04-27T09:30:00.000Z'),
      timezone: 'UTC',
      summary: 'Prima visita',
      customerName: 'Mario Rossi',
    };

    const converge = async (status: number) => {
      const provider = new GoogleCalendarProvider({
        fetcher: vi.fn(async () => new Response(null, { status })),
      });

      return convergeCalendarEvent({ provider, integration: integration(), target });
    };

    const afterRealDelete = await converge(204);
    const afterMissingEvent = await converge(404);

    expect(afterRealDelete).not.toEqual(afterMissingEvent);
    expect(afterRealDelete.action).toBe('deleted');
    expect(afterMissingEvent.action).toBe('already_absent');

    // Solo una cancellazione riuscita dimostra che l'evento viveva li'.
    expect(afterRealDelete.calendarIdVerified).toBe(true);
    expect(afterMissingEvent.calendarIdVerified).toBe(false);
  });

  it('still preserves absence on getEvent, as it always did', async () => {
    const missing = new GoogleCalendarProvider({
      fetcher: vi.fn(async () => new Response(null, { status: 404 })),
    });
    const present = new GoogleCalendarProvider({
      fetcher: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'apt_1',
              status: 'confirmed',
              start: { dateTime: '2026-04-27T09:00:00.000Z' },
              end: { dateTime: '2026-04-27T09:30:00.000Z' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });

    await expect(
      missing.getEvent({ integration: integration(), eventId: 'apt_1' }),
    ).resolves.toBeNull();
    await expect(
      present.getEvent({ integration: integration(), eventId: 'apt_1' }),
    ).resolves.toMatchObject({ eventId: 'apt_1', status: 'confirmed' });
  });

  it('reports which calendar it contacted, and refuses to call an absence a deletion', async () => {
    // L'altra meta' del difetto: senza provenienza memorizzata la DELETE parte
    // per il calendario CONFIGURATO ADESSO. Se il tenant l'ha cambiato,
    // l'evento storico vive altrove — e il 404 che ne segue ora dice
    // esattamente questo, invece di dire "fatto".
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 404 }),
    );
    const provider = new GoogleCalendarProvider({ fetcher });

    const outcome = await provider.cancelEvent({
      integration: integration({ config: { calendar_id: 'calendario-nuovo@example.com' } }),
      eventId: 'apt_1',
    });

    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      encodeURIComponent('calendario-nuovo@example.com'),
    );
    expect(outcome).toEqual({
      outcome: 'already_absent',
      calendarId: 'calendario-nuovo@example.com',
      httpStatus: 404,
    });
  });

  it('sends the DELETE to the stored provenance, not to the calendar configured now', async () => {
    // La riparazione del bersaglio: un `calendarId` esplicito e' la
    // provenienza verificata dell'evento e vince sulla configurazione
    // corrente, che nel frattempo puo' essere cambiata.
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    const provider = new GoogleCalendarProvider({ fetcher });

    const outcome = await provider.cancelEvent({
      integration: integration({ config: { calendar_id: 'calendario-nuovo@example.com' } }),
      eventId: 'apt_1',
      calendarId: 'calendario-storico@example.com',
    });

    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      encodeURIComponent('calendario-storico@example.com'),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain(
      encodeURIComponent('calendario-nuovo@example.com'),
    );
    expect(outcome).toEqual({
      outcome: 'deleted',
      calendarId: 'calendario-storico@example.com',
      httpStatus: 204,
    });
  });
});

function integration(
  overrides: Partial<GoogleCalendarIntegration> = {},
): GoogleCalendarIntegration {
  return {
    id: 'integration_1',
    tenantId: 'tenant_1',
    externalAccountId: null,
    credentials: { access_token: 'access_1' },
    config: { calendar_id: 'studio@example.com' },
    ...overrides,
  };
}
