import { z } from 'zod';
import { type NextRequest, type NextResponse } from 'next/server';

import { jsonHandler } from '@/lib/api/json';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import { assertStaticSecretHeader } from '@/lib/security/static-secret';
import { createAppointmentBookingService } from '@/server/appointments/booking';
import { createProjectionFenceReader } from '@/server/appointments/projection-fence';

export const runtime = 'nodejs';

/**
 * CATTURA PRECOCE DELL'EPOCA DI PROIEZIONE (PILOT-P0-3C-i).
 *
 * Avviene subito dopo il parse del body e PRIMA di qualunque lettura di stato
 * applicativo. Se venisse letta piu' tardi — appena prima della scrittura —
 * una richiesta partita prima di una cancellazione leggerebbe l'epoca NUOVA e
 * la adotterebbe, riproiettando dati che nel frattempo dovevano essere
 * distrutti. Il fence direbbe "tutto a posto" nell'unico caso in cui doveva
 * dire di no.
 *
 * Il valore non viene mai rinfrescato: una richiesta stantia deve fallire.
 * Il rifiuto esce come `conflict` (409) con identificatore tipizzato e senza
 * numeri di epoca, che sono stato interno del fence.
 */
async function captureProjectionEpoch(tenantId: string): Promise<number> {
  const snapshot = await createProjectionFenceReader().capture(tenantId);

  return snapshot.projectionEpoch;
}

const CreateAppointmentBodySchema = z.object({
  tenantId: z.string().uuid(),
  serviceId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  customerIdentifier: z.string().min(1),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1).nullable().optional(),
  customerEmail: z.string().email().nullable().optional(),
  scheduledAt: z.coerce.date(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  notes: z.string().max(4000).nullable().optional(),
  bookingSource: z.enum(['manual', 'whatsapp_ai', 'dashboard', 'api']).default('api'),
  requireCalendarSync: z.boolean().optional(),
  sendConfirmation: z.boolean().optional(),
});

const RescheduleAppointmentBodySchema = z.object({
  tenantId: z.string().uuid(),
  appointmentId: z.string().uuid(),
  scheduledAt: z.coerce.date(),
  durationMinutes: z.coerce.number().int().positive().optional(),
  notes: z.string().max(4000).nullable().optional(),
  customerEmail: z.string().email().nullable().optional(),
  requireCalendarSync: z.boolean().optional(),
  sendConfirmation: z.boolean().optional(),
});

const CancelAppointmentBodySchema = z.object({
  tenantId: z.string().uuid(),
  appointmentId: z.string().uuid(),
  requireCalendarSync: z.boolean().optional(),
  sendCancellation: z.boolean().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  return jsonHandler(async () => {
    assertStaticSecretHeader({
      headers: request.headers,
      headerName: env.INTERNAL_JOB_HEADER_NAME,
      expectedSecret: env.INTERNAL_JOB_SECRET,
      notConfiguredMessage: 'Internal booking secret is not configured',
    });

    const body = CreateAppointmentBodySchema.parse(await readOptionalJson(request));
    const expectedProjectionEpoch = await captureProjectionEpoch(body.tenantId);
    const service = createAppointmentBookingService();

    return service.createAppointment({
      tenantId: body.tenantId,
      expectedProjectionEpoch,
      serviceId: body.serviceId,
      ...(body.conversationId !== undefined ? { conversationId: body.conversationId } : {}),
      customerIdentifier: body.customerIdentifier,
      customerName: body.customerName,
      ...(body.customerPhone !== undefined ? { customerPhone: body.customerPhone } : {}),
      ...(body.customerEmail !== undefined ? { customerEmail: body.customerEmail } : {}),
      scheduledAt: body.scheduledAt,
      ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      bookingSource: body.bookingSource,
      ...(body.requireCalendarSync !== undefined
        ? { requireCalendarSync: body.requireCalendarSync }
        : {}),
      ...(body.sendConfirmation !== undefined ? { sendConfirmation: body.sendConfirmation } : {}),
    });
  }, request);
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  return jsonHandler(async () => {
    assertStaticSecretHeader({
      headers: request.headers,
      headerName: env.INTERNAL_JOB_HEADER_NAME,
      expectedSecret: env.INTERNAL_JOB_SECRET,
      notConfiguredMessage: 'Internal booking secret is not configured',
    });

    const body = RescheduleAppointmentBodySchema.parse(await readOptionalJson(request));
    const expectedProjectionEpoch = await captureProjectionEpoch(body.tenantId);
    const service = createAppointmentBookingService();

    return service.rescheduleAppointment({
      tenantId: body.tenantId,
      expectedProjectionEpoch,
      appointmentId: body.appointmentId,
      scheduledAt: body.scheduledAt,
      ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.customerEmail !== undefined ? { customerEmail: body.customerEmail } : {}),
      ...(body.requireCalendarSync !== undefined
        ? { requireCalendarSync: body.requireCalendarSync }
        : {}),
      ...(body.sendConfirmation !== undefined ? { sendConfirmation: body.sendConfirmation } : {}),
    });
  }, request);
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  return jsonHandler(async () => {
    assertStaticSecretHeader({
      headers: request.headers,
      headerName: env.INTERNAL_JOB_HEADER_NAME,
      expectedSecret: env.INTERNAL_JOB_SECRET,
      notConfiguredMessage: 'Internal booking secret is not configured',
    });

    const body = CancelAppointmentBodySchema.parse(await readOptionalJson(request));
    const expectedProjectionEpoch = await captureProjectionEpoch(body.tenantId);
    const service = createAppointmentBookingService();

    return service.cancelAppointment({
      tenantId: body.tenantId,
      expectedProjectionEpoch,
      appointmentId: body.appointmentId,
      ...(body.requireCalendarSync !== undefined
        ? { requireCalendarSync: body.requireCalendarSync }
        : {}),
      ...(body.sendCancellation !== undefined ? { sendCancellation: body.sendCancellation } : {}),
    });
  }, request);
}

async function readOptionalJson(request: NextRequest): Promise<unknown> {
  const rawBody = await request.text();

  if (!rawBody.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new AppError('bad_request', 'Invalid JSON body', {
      cause: error,
      expose: true,
    });
  }
}
