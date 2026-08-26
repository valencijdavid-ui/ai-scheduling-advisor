// PILOT-P0-3C-i — cattura precoce dell'epoca di proiezione.
//
// PERCHE' "PRECOCE" E' LA META' DEL MECCANISMO
//
// L'epoca non puo' essere letta subito prima dell'insert. Se lo fosse, un
// turno cominciato prima di una cancellazione leggerebbe l'epoca NUOVA e la
// adotterebbe: la PII che quel turno tiene in memoria da minuti — nome,
// telefono, testo della conversazione — verrebbe riproiettata sotto
// un'autorita' che nel frattempo era stata revocata proprio per distruggerla.
// Il fence direbbe "tutto a posto" nell'unico caso in cui doveva dire di no.
//
// Quindi la cattura avviene al CONFINE DEL TURNO LOGICO, prima che il
// workflow cominci a trattenere o ad agire su dati del cliente:
//
//   WhatsApp        al dispatch del turno inbound, in whatsapp/service.ts,
//                   prima dello stato conversazione e del workflow di
//                   prenotazione
//   API interna     all'ingresso della route, subito dopo il parse del body,
//                   prima di qualunque lettura di repository
//
// Da li' il valore viaggia ESPLICITO fino alla primitiva di scrittura. Non ha
// default e non viene mai rinfrescato per conto di nessuno: una richiesta
// stantia non deve poter sostituire in silenzio la E che aveva con la E+1
// corrente.
//
// CONFINE DI FASE
//
// C-i non implementa il ciclo di vita di finalizzazione del tenant (P0-3B).
// L'interfaccia sotto esiste perche' quel lavoro possa introdurre
// `projection_allowed = false` senza riprogettare gli scrittori: oggi
// l'unica risposta possibile e' "tenant assente = fallire chiuso".

import { z } from 'zod';

import { AppError } from '@/lib/errors/app-error';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Autorita' di proiezione osservata all'inizio del turno.
 *
 * E' un'istantanea, non un permesso permanente: fra questa lettura e la
 * scrittura l'autorita' puo' cambiare, ed e' precisamente cio' che il fence
 * sotto lock deve poter scoprire.
 */
export type ProjectionFenceSnapshot = {
  tenantId: string;
  projectionEpoch: number;
};

export interface ProjectionFenceReader {
  /**
   * Cattura l'epoca corrente.
   *
   * Solleva se il tenant non esiste: in C-i non c'e' nessuno stato di grace
   * da interpretare, e proiettare PII per conto di un tenant che non c'e'
   * piu' non e' un caso da indovinare.
   */
  capture(tenantId: string): Promise<ProjectionFenceSnapshot>;
}

const EpochSchema = z.number().int().nonnegative();

export type ProjectionFenceRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

export class SupabaseProjectionFenceReader implements ProjectionFenceReader {
  private readonly supabase: ProjectionFenceRpcClient;

  constructor(client?: ProjectionFenceRpcClient) {
    this.supabase = client ?? (createSupabaseAdminClient() as unknown as ProjectionFenceRpcClient);
  }

  async capture(tenantId: string): Promise<ProjectionFenceSnapshot> {
    const { data, error } = await this.supabase.rpc('read_tenant_projection_epoch', {
      p_tenant_id: tenantId,
    });

    if (error) {
      throw new AppError('upstream_error', 'Failed to read the tenant projection epoch', {
        cause: error,
        expose: false,
      });
    }

    if (data === null || data === undefined) {
      throw projectionAuthorityMissingError();
    }

    return { tenantId, projectionEpoch: EpochSchema.parse(data) };
  }
}

export function createProjectionFenceReader(): ProjectionFenceReader {
  return new SupabaseProjectionFenceReader();
}

/**
 * Rifiuto del fence: la richiesta e' partita sotto un'autorita' che non e'
 * piu' quella corrente.
 *
 * I due messaggi sono identificatori tipizzati, non prosa per il cliente, e
 * NON contengono numeri di epoca: l'epoca e' stato interno del fence e non ha
 * nessun significato per chi ha fatto la richiesta.
 */
export const STALE_PROJECTION_EPOCH = 'stale_projection_epoch';
export const PROJECTION_AUTHORITY_MISSING = 'projection_authority_missing';

export function staleProjectionEpochError(): AppError {
  return new AppError('conflict', STALE_PROJECTION_EPOCH, { expose: true });
}

export function projectionAuthorityMissingError(): AppError {
  return new AppError('conflict', PROJECTION_AUTHORITY_MISSING, { expose: true });
}

/**
 * Riconosce un rifiuto del fence senza guardare il messaggio a occhio.
 *
 * Serve ai chiamanti che devono degradare in modo deterministico — il turno
 * WhatsApp — e non devono confondere questo caso con "lo slot e' occupato",
 * che e' un conflitto anch'esso ma vuole una risposta completamente diversa.
 */
export function isProjectionFenceRejection(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'conflict' &&
    (error.message === STALE_PROJECTION_EPOCH || error.message === PROJECTION_AUTHORITY_MISSING)
  );
}
