// Test per SupabaseAppointmentBookingRepository.updateAppointmentSchedule.
//
// L'aggiornamento e' guardato da `status = 'confirmed'`. Se fra la lettura
// dell'appuntamento e questa scrittura qualcuno lo annulla, il filtro non
// trova nulla e l'UPDATE tocca ZERO righe — senza alcun errore da parte di
// Postgres. Il difetto era proprio questo silenzio: la riprogrammazione
// proseguiva verso Google, la convergenza trovava l'evento assente (lo aveva
// appena rimosso l'annullamento) e lo RICREAVA, resuscitando sul calendario
// dello studio un impegno che in Postgres non esiste piu'.
//
// Il fake usato nei test di servizio riproduce questa semantica, ma non puo'
// dimostrare che sia il repository reale a rilevarla: serve verificare che la
// query chieda indietro le righe toccate e reagisca quando sono zero.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateBuilder = {
  eq: vi.fn(),
  select: vi.fn(),
};
const fromMock = vi.fn(() => ({ update: vi.fn(() => updateBuilder) }));
const adminClientMock = { from: fromMock };

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: vi.fn(() => adminClientMock),
}));

const { SupabaseAppointmentBookingRepository } = await import('@/server/appointments/booking');

const scheduleInput = {
  tenantId: 'tenant_1',
  appointmentId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
  scheduledAt: new Date('2026-04-27T10:00:00.000Z'),
  durationMinutes: 30,
  notes: null,
  calendarProvider: 'google_calendar' as const,
  calendarSyncNextAttemptAt: new Date('2026-04-27T07:00:00.000Z'),
};

describe('SupabaseAppointmentBookingRepository.updateAppointmentSchedule', () => {
  beforeEach(() => {
    fromMock.mockClear();
    updateBuilder.eq.mockReset();
    updateBuilder.select.mockReset();
    // `.eq()` e' concatenabile: ogni chiamata restituisce lo stesso builder.
    updateBuilder.eq.mockReturnValue(updateBuilder);
  });

  it('asks Postgres which rows the guarded update touched', async () => {
    updateBuilder.select.mockResolvedValueOnce({
      data: [{ id: scheduleInput.appointmentId }],
      error: null,
    });
    const repository = new SupabaseAppointmentBookingRepository();

    await repository.updateAppointmentSchedule({
      ...scheduleInput,
      calendarSyncStatus: 'pending',
    });

    expect(fromMock).toHaveBeenCalledWith('appointments');
    // Senza `select`, zero righe aggiornate sarebbero indistinguibili da una
    // riga aggiornata: non c'e' errore in nessuno dei due casi.
    expect(updateBuilder.select).toHaveBeenCalledWith('id');
    expect(updateBuilder.eq).toHaveBeenCalledWith('status', 'confirmed');
  });

  it('raises a conflict when the guarded update matched no row', async () => {
    updateBuilder.select.mockResolvedValueOnce({ data: [], error: null });
    const repository = new SupabaseAppointmentBookingRepository();

    await expect(
      repository.updateAppointmentSchedule({
        ...scheduleInput,
        calendarSyncStatus: 'pending',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Appointment is no longer confirmed',
    });
  });

  it('treats a null result set as no rows updated', async () => {
    updateBuilder.select.mockResolvedValueOnce({ data: null, error: null });
    const repository = new SupabaseAppointmentBookingRepository();

    await expect(
      repository.updateAppointmentSchedule({
        ...scheduleInput,
        calendarSyncStatus: 'pending',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('still maps an exclusion-constraint violation to a slot conflict', async () => {
    // Il vincolo di esclusione resta la difesa contro i doppi impegni: la sua
    // traduzione in `conflict` non deve essere stata assorbita dal nuovo
    // controllo sulle righe toccate.
    updateBuilder.select.mockResolvedValueOnce({ data: null, error: { code: '23P01' } });
    const repository = new SupabaseAppointmentBookingRepository();

    await expect(
      repository.updateAppointmentSchedule({
        ...scheduleInput,
        calendarSyncStatus: 'pending',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Appointment slot is no longer available',
    });
  });
});
