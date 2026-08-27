// PILOT-P0-3C-i — lettore di epoca in memoria.
//
// Il turno WhatsApp cattura l'autorita' di proiezione prima di leggere
// qualunque stato del cliente. Nei test quel confine deve restare VERO — se il
// fake lo saltasse, la cattura precoce smetterebbe di essere esercitata — ma
// non deve pretendere un Supabase.
//
// `capture` registra ogni chiamata: e' cosi' che un test puo' dimostrare che
// la lettura e' avvenuta, e in che ordine rispetto al resto del turno.

import type {
  ProjectionFenceReader,
  ProjectionFenceSnapshot,
} from '@/server/appointments/projection-fence';

export class FakeProjectionFenceReader implements ProjectionFenceReader {
  readonly captured: string[] = [];

  constructor(
    private epoch = 0,
    /** Traccia condivisa, per asserire l'ORDINE rispetto alle altre letture. */
    private readonly trace: string[] | null = null,
  ) {}

  async capture(tenantId: string): Promise<ProjectionFenceSnapshot> {
    this.captured.push(tenantId);
    this.trace?.push('projection_fence');

    return { tenantId, projectionEpoch: this.epoch };
  }
}
