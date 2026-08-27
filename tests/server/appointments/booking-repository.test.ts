// PILOT-P0-3C-i — confine tipizzato di `SupabaseCalendarWriteStore`.
//
// Questo file nasce in P0-3C su `SupabaseAppointmentBookingRepository
// .updateAppointmentSchedule`: dimostrava che l'UPDATE guardato chiedeva
// indietro le righe toccate e reagiva quando erano zero.
//
// C-i ha spostato quella mutazione DENTRO il database — in
// `reschedule_appointment_guarded`, che possiede il fence del tenant e
// l'incremento atomico della versione desiderata — e il metodo del repository
// non esiste piu'. La semantica e' ora dimostrata su PostgreSQL vero in
// `calendar-settle-concurrency.pg.test.ts`.
//
// Quello che resta da dimostrare qui, e che PostgreSQL da solo non copre, e' la
// TRADUZIONE al confine: che gli esiti della primitiva arrivino al chiamante
// come fatti distinti, e soprattutto che una violazione del vincolo di
// esclusione — che PostgREST consegna come errore, non come esito — non venga
// scambiata per un guasto d'infrastruttura.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SupabaseCalendarWriteStore,
  type CalendarWriteRpcClient,
} from '@/server/appointments/calendar-write-intents';
import { AppError } from '@/lib/errors/app-error';

const rpc = vi.fn();
const client = { rpc } as unknown as CalendarWriteRpcClient;

const rescheduleInput = {
  tenantId: 'tenant_1',
  appointmentId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
  expectedProjectionEpoch: 3,
  scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
  durationMinutes: 30,
  notes: null,
  calendarProvider: 'google_calendar' as const,
  calendarSyncStatus: 'pending' as const,
  calendarSyncNextAttemptAt: new Date('2026-04-27T07:00:00.000Z'),
};

describe('SupabaseCalendarWriteStore.rescheduleGuarded', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('sends the captured epoch to the guarded primitive without rereading it', async () => {
    rpc.mockResolvedValueOnce({
      data: { outcome: 'rescheduled', desiredVersion: 4, projectionEpoch: 3 },
      error: null,
    });

    const result = await new SupabaseCalendarWriteStore(client).rescheduleGuarded(rescheduleInput);

    expect(rpc).toHaveBeenCalledWith(
      'reschedule_appointment_guarded',
      expect.objectContaining({ p_expected_projection_epoch: 3 }),
    );
    expect(result).toEqual({ outcome: 'rescheduled', desiredVersion: 4, projectionEpoch: 3 });
  });

  it('surfaces zero rows as a typed not_confirmed instead of a silent success', async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: 'not_confirmed' }, error: null });

    const result = await new SupabaseCalendarWriteStore(client).rescheduleGuarded(rescheduleInput);

    // Il chiamante non puo' confonderlo con una riprogrammazione avvenuta, ed
    // e' quello che gli impedisce di proseguire verso Google.
    expect(result).toEqual({ outcome: 'not_confirmed' });
  });

  it('keeps the fence rejection distinct, and free of epoch numbers', async () => {
    rpc.mockResolvedValueOnce({
      data: { outcome: 'stale_projection_epoch', expected: 3, observed: 4 },
      error: null,
    });

    const result = await new SupabaseCalendarWriteStore(client).rescheduleGuarded(rescheduleInput);

    // I numeri di epoca restano DENTRO: sono stato interno del fence e non
    // hanno nessun significato per chi ha fatto la richiesta.
    expect(result).toEqual({ outcome: 'stale_projection_epoch' });
  });

  it('classifies an exclusion-constraint violation as a slot conflict, not a failure', async () => {
    // P0-7A ha reso applicabile `appointments_no_confirmed_overlap`: 23P01 e'
    // un esito di dominio normale della concorrenza fra prenotazioni.
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23P01', message: 'conflicting key value violates exclusion constraint' },
    });

    const result = await new SupabaseCalendarWriteStore(client).rescheduleGuarded(rescheduleInput);

    expect(result).toEqual({ outcome: 'slot_conflict' });
  });

  it('still raises for a genuine infrastructure failure', async () => {
    // Il contrasto e' il punto: non tutti gli errori sono esiti. Uno stato
    // dell'infrastruttura rotto deve continuare a propagarsi.
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '08006', message: 'connection failure' },
    });

    await expect(
      new SupabaseCalendarWriteStore(client).rescheduleGuarded(rescheduleInput),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('SupabaseCalendarWriteStore.cancelGuarded', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('surfaces zero rows as not_confirmed, which is what stops the Google delete', async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: 'not_confirmed' }, error: null });

    const result = await new SupabaseCalendarWriteStore(client).cancelGuarded({
      tenantId: 'tenant_1',
      appointmentId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
      expectedProjectionEpoch: 3,
      calendarSyncStatus: 'pending',
      calendarSyncNextAttemptAt: null,
    });

    expect(result).toEqual({ outcome: 'not_confirmed' });
  });
});
