// PILOT-P0-3C — CARATTERIZZAZIONE. Il collasso dell'esito di una DELETE.
//
// `cancelEvent` tratta 200, 204, 404 e 410 come lo stesso esito. La
// distinzione fra "ho cancellato un evento che esisteva" e "non c'era
// niente" viene DISTRUTTA sul confine del provider, prima che qualunque
// chiamante possa vederla.
//
// Perche' e' load-bearing per P0-3C: un worker che converge le obbligazioni
// deve poter scrivere `converged` solo su prove. Se manda la DELETE al
// calendario sbagliato — cosa possibile finche'
// `appointments.calendar_event_calendar_id` non e' popolata — riceve 404, che
// oggi vale successo, e chiude un debito il cui evento, con dentro il telefono
// del cliente, e' vivo altrove.
//
// Il test resta verde affermando la perdita di informazione.

import { describe, expect, it, vi } from 'vitest';

import { GoogleCalendarProvider, type GoogleCalendarIntegration } from '@/server/calendar/google';
import {
  convergeCalendarEvent,
  type CalendarConvergenceTarget,
} from '@/server/appointments/calendar-convergence';

describe('PILOT-P0-3C — caratterizzazione dell esito di cancelEvent', () => {
  it('characterizes 204, 404 and 410 collapsing into one indistinguishable result', async () => {
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
    // 404 = non c'era, o non e' su QUESTO calendario.
    // 410 = c'era ed era gia' stato eliminato.
    //
    // Tre fatti diversi, un valore solo.
    expect(deleted).toEqual({ cancelled: true });
    expect(absent).toEqual({ cancelled: true });
    expect(gone).toEqual({ cancelled: true });
    expect(deleted).toEqual(absent);
    expect(absent).toEqual(gone);

    // Non c'e' nessun campo aggiuntivo da cui dedurre l'esito: la superficie
    // di ritorno e' esattamente una chiave.
    for (const outcome of outcomes) {
      expect(Object.keys(outcome as object)).toEqual(['cancelled']);
    }

    // DELETE_ABSENCE_INFORMATION_LOST = TRUE
  });

  it('characterizes the convergence result being identical whether or not anything was deleted', async () => {
    // La perdita non si ferma al provider: risale invariata fino all'esito
    // della convergenza, che e' cio' che il reconciler registra in Postgres.
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

    expect(afterRealDelete).toEqual(afterMissingEvent);
    // `deleted` viene riportato anche quando non e' stato cancellato niente.
    expect(afterMissingEvent.action).toBe('deleted');
  });

  it('contrasts getEvent, which does preserve absence', async () => {
    // Il contrasto e' la prova che l'informazione ESISTE a livello HTTP ed e'
    // gia' leggibile altrove nello stesso file di produzione: e' `cancelEvent`
    // a buttarla via, non Google a non fornirla.
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

  it('characterizes cancelEvent targeting whatever calendar the current config names', async () => {
    // L'altra meta' del difetto: il calendario non e' un parametro
    // dell'obbligazione ma una lettura della configurazione CORRENTE. Se il
    // tenant ha cambiato calendario, la DELETE parte per l'indirizzo
    // sbagliato — e il 404 che ne segue vale successo.
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
    // L'evento storico vive su un altro calendario, e questo esito dice
    // comunque "fatto".
    expect(outcome).toEqual({ cancelled: true });
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
