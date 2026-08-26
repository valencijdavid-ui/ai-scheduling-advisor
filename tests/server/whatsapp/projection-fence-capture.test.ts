// PILOT-P0-3C-i — cattura precoce dell'epoca di proiezione nel turno WhatsApp.
//
// La proprieta' non e' "l'epoca viene letta". E' QUANDO viene letta.
//
// Se fosse letta piu' tardi — appena prima della scrittura — un turno
// cominciato prima di una cancellazione leggerebbe l'epoca NUOVA e la
// adotterebbe: la PII che quel turno tiene in memoria da minuti verrebbe
// riproiettata sotto un'autorita' che nel frattempo era stata revocata proprio
// per distruggerla. Il fence direbbe "tutto a posto" nell'unico caso in cui
// doveva dire di no.
//
// Qui l'ordine e' osservato, non dedotto: la lettura del fence e le letture di
// stato del cliente scrivono nella stessa traccia.

import { describe, expect, it } from 'vitest';

import { WhatsAppWebhookService } from '@/server/whatsapp/service';
import type { WhatsAppAutoReplyInput } from '@/server/whatsapp/auto-reply';
import { FakeProjectionFenceReader } from '../../fixtures/fake-projection-fence';

const TENANT_ID = 'tenant_1';
const TENANT_EPOCH = 9;

describe('PILOT-P0-3C-i — cattura precoce dell epoca nel turno WhatsApp', () => {
  it('reads the projection epoch before any customer state read of the turn', async () => {
    const trace: string[] = [];
    const repository = new TracingWhatsAppRepository(trace);
    const autoReply = new CapturingAutoReply(trace);
    const fence = new FakeProjectionFenceReader(TENANT_EPOCH, trace);

    const service = new WhatsAppWebhookService(repository as never, {
      projectionFence: fence,
      autoReplyService: autoReply as never,
    });

    await service.processPayload(textPayload(), { requestId: 'req_1', ipAddress: '127.0.0.1' });

    // LA PROPRIETA'. Il fence e' il PRIMO gesto del turno dopo che il tenant e'
    // noto: precede la conversazione, i messaggi e qualunque lettura di
    // prenotazione.
    expect(trace[0]).toBe('projection_fence');
    expect(trace).toEqual([
      'projection_fence',
      'upsertConversation',
      'insertInboundMessage',
      'incrementUsage',
      'autoReply',
    ]);

    expect(fence.captured).toEqual([TENANT_ID]);
  });

  it('carries that exact epoch into the turn, without rereading it', async () => {
    const trace: string[] = [];
    const repository = new TracingWhatsAppRepository(trace);
    const autoReply = new CapturingAutoReply(trace);
    const fence = new FakeProjectionFenceReader(TENANT_EPOCH, trace);

    const service = new WhatsAppWebhookService(repository as never, {
      projectionFence: fence,
      autoReplyService: autoReply as never,
    });

    await service.processPayload(textPayload(), { requestId: 'req_1', ipAddress: '127.0.0.1' });

    expect(autoReply.inputs).toHaveLength(1);
    expect(autoReply.inputs[0]?.expectedProjectionEpoch).toBe(TENANT_EPOCH);

    // Una sola lettura per turno: rinfrescarla sarebbe adottare in silenzio
    // un'autorita' che il turno non aveva quando e' partito.
    expect(fence.captured).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class CapturingAutoReply {
  readonly inputs: WhatsAppAutoReplyInput[] = [];

  constructor(private readonly trace: string[] = []) {}

  async handleInboundMessage(input: WhatsAppAutoReplyInput): Promise<unknown> {
    this.inputs.push(input);
    this.trace.push('autoReply');

    return { analyzed: false, queued: false, skippedReason: null };
  }
}

/**
 * Registra l'ORDINE delle letture/scritture di stato del cliente.
 *
 * Implementa solo cio' che il turno inbound tocca davvero; il resto della
 * superficie non viene raggiunto da questi test.
 */
class TracingWhatsAppRepository {
  constructor(private readonly trace: string[]) {}

  async recordWebhookEvent(): Promise<{ duplicate: boolean; eventId: string }> {
    return { duplicate: false, eventId: 'event_1' };
  }

  async resolveTenantByPhoneNumberId(): Promise<{ tenantId: string; integrationId: string }> {
    return { tenantId: TENANT_ID, integrationId: 'integration_1' };
  }

  async upsertConversation(): Promise<{ conversationId: string }> {
    this.trace.push('upsertConversation');

    return { conversationId: 'conversation_1' };
  }

  async insertInboundMessage(): Promise<{ created: boolean; messageId: string }> {
    this.trace.push('insertInboundMessage');

    return { created: true, messageId: 'message_1' };
  }

  async incrementUsage(): Promise<void> {
    this.trace.push('incrementUsage');
  }

  async upsertCustomerOptOut(): Promise<void> {}

  async updateInboundMessageAnalysis(): Promise<void> {}

  async enqueueVoiceProcessingJob(): Promise<{ jobId: string; created: boolean }> {
    return { jobId: 'job_1', created: true };
  }

  async markWebhookEventProcessed(): Promise<void> {}

  async markWebhookEventFailed(): Promise<void> {}

  async updateOutboundMessageStatus(): Promise<void> {}
}

function textPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry_1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '39000', phone_number_id: 'phone_1' },
              messages: [
                {
                  from: '393331112233',
                  id: 'wamid.1',
                  timestamp: '1777000000',
                  type: 'text',
                  text: { body: 'Vorrei prenotare' },
                },
              ],
            },
          },
        ],
      },
    ],
  } as never;
}
