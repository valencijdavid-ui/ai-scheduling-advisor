// Fatto da Claude Code l'8 maggio 2026.
// GDPR Art. 17 — customer-level deletion immediata.
//
// L'admin del tenant cancella tutti i dati del cliente finale (no grace).

import { type NextRequest } from 'next/server';
import { z } from 'zod';

import { jsonHandler } from '@/lib/api/json';
import { readJsonBody } from '@/lib/api/body';
import { requireSession } from '@/lib/auth/session';
import { applyRateLimit } from '@/lib/rate-limit/apply';
import { createGdprDeleteService } from '@/server/gdpr/data-delete';

export const runtime = 'nodejs';

const DeleteCustomerBodySchema = z.object({
  confirmationPhrase: z.literal('CANCELLA'),
});

const PhoneParamSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^\+?\d[\d\s().-]+$/, 'Invalid phone format');

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ phone: string }> },
): Promise<Response> {
  return jsonHandler(async (apiContext) => {
    const session = await requireSession();

    // Rate limit GDPR Art. 17 — policy PROPRIA, non quella della chiusura
    // account: bucket separato, cosi' cancellare un cliente non consuma il
    // diritto di chiudere il tenant (e viceversa), e la ripetizione di una
    // richiesta la cui risposta si e' persa non e' bloccata per 24 ore.
    //
    // Applicato PRIMA di leggere il body: la confirmation phrase non deve
    // essere brute-forzabile, e una sessione admin rubata non deve poter
    // svuotare l'anagrafica clienti a raffica.
    await applyRateLimit('gdprCustomerErasure', { kind: 'userId', value: session.userId });

    const { phone } = await context.params;
    const validatedPhone = PhoneParamSchema.parse(decodeURIComponent(phone));

    DeleteCustomerBodySchema.parse(await readJsonBody(request));

    const service = createGdprDeleteService();

    return service.deleteCustomerData({
      session,
      customerPhone: validatedPhone,
      actor: {
        ipAddress: apiContext.ipAddress,
        userAgent: request.headers.get('user-agent'),
      },
    });
  }, request);
}
