/**
 * Fixture e proiezioni della demo pubblica del ranker.
 *
 * Questo modulo non contiene scoring: il punteggio, l'ordine e le motivazioni
 * arrivano interamente da `rankSlots()` di produzione. Qui vivono solo il
 * fixture deterministico, uno shuffle seedato dell'input e le mappe di
 * presentazione usate dalla pagina.
 */

import {
  filterSlotsByBookingRequest,
  type StructuredBookingRequest,
} from '@/server/ai/booking-extractor';
import {
  toDecisionCandidates,
  type SchedulingDecisionCandidate,
} from '@/server/appointments/decision-ledger';
import {
  SLOT_RANKING_VERSION,
  buildRankingExplanation,
  rankSlots,
  slotIdentity,
  type RankableSlot,
  type RankedSlot,
  type RankingSignal,
} from '@/server/appointments/slot-ranking';

export { SLOT_RANKING_VERSION };

export const DEMO_TIMEZONE = 'Europe/Rome';

/**
 * Istante di riferimento iniettato nel ranker: lunedi' 27 aprile 2026, 09:00
 * a Roma. E' fisso perche' la demo deve produrre lo stesso output su ogni
 * macchina e a ogni run — nessun `Date.now()`.
 */
export const DEMO_NOW = new Date('2026-04-27T07:00:00.000Z');

export const DEMO_MESSAGE = 'I need the earliest available appointment after 3 PM.';

export const DEMO_SERVICE_ID = 'svc-checkup-30';

/**
 * Richiesta strutturata scritta a mano, conforme al tipo reale.
 *
 * Non e' output dell'estrattore italiano: `DEMO_MESSAGE` e' la sua resa
 * leggibile in inglese. I valori sono pero' quelli che l'estrattore
 * produrrebbe per una richiesta equivalente — `after_hour` porta con se'
 * `endHour = max(startHour + 1, 21)`, e la confidenza e' quella che
 * `confidenceForExtraction` calcola per questa combinazione di campi.
 */
export const DEMO_REQUEST: StructuredBookingRequest = {
  serviceQuery: null,
  datePreference: null,
  timePreference: {
    dayPart: 'after_hour',
    startHour: 15,
    endHour: 21,
  },
  urgency: 'urgent',
  customerName: null,
  customerPhone: null,
  confidence: 0.61,
  signals: ['time_after_hour', 'urgency'],
};

/** Slot con un'etichetta stabile, assegnata dall'ordine canonico. */
export type DemoSlot = RankableSlot & {
  label: string;
};

/**
 * Slot liberi come li restituirebbe `getAvailableSlots` nella finestra di
 * disponibilita' della richiesta: nessun filtro di preferenza applicato,
 * ordine cronologico, alcuni prima delle 15 e uno dopo le 21.
 *
 * La finestra e' [ora, ora + 3 giorni] perche' la richiesta e' urgente e non
 * porta una data: e' la stessa regola che il bridge applica quando
 * `datePreference` e' `null`.
 */
const rawSlotStarts = [
  '2026-04-27T07:30:00.000Z',
  '2026-04-27T09:00:00.000Z',
  '2026-04-27T14:00:00.000Z',
  '2026-04-27T16:00:00.000Z',
  '2026-04-27T19:30:00.000Z',
  '2026-04-28T08:00:00.000Z',
  '2026-04-28T13:00:00.000Z',
  '2026-04-28T15:00:00.000Z',
  '2026-04-29T13:30:00.000Z',
  '2026-04-29T17:00:00.000Z',
] as const;

const slotDurationMinutes = 30;

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * L'etichetta (A, B, C...) segue l'ordine canonico e resta attaccata allo slot
 * anche dopo lo shuffle, cosi' l'identita' e' verificabile a occhio.
 */
export const DEMO_RAW_SLOTS: readonly DemoSlot[] = rawSlotStarts.map((start, index) => ({
  label: alphabet[index] ?? String(index + 1),
  serviceId: DEMO_SERVICE_ID,
  start,
  end: new Date(Date.parse(start) + slotDurationMinutes * 60_000).toISOString(),
  timezone: DEMO_TIMEZONE,
}));

export const SIGNAL_LABELS: Record<RankingSignal, string> = {
  requested_date_match: 'Requested date',
  time_preference_match: 'Time preference',
  explicit_time_proximity: 'Explicit-time proximity',
  earliest_availability: 'Earliest availability',
};

/** Forma della riga che il ledger persisterebbe. Qui e' solo un preview. */
export type DecisionLedgerPreview = {
  ranking_version: string;
  request: Record<string, unknown>;
  explanation: string | null;
  candidates: SchedulingDecisionCandidate[];
};

/** Slot grezzo con l'esito del filtro di preferenza esistente. */
export type DemoRawSlot = {
  slot: DemoSlot;
  passesFilter: boolean;
};

export type DemoView = {
  seed: number;
  rawOrder: DemoRawSlot[];
  rawOrderChanged: boolean;
  candidates: DemoSlot[];
  filteredOutCount: number;
  ranked: RankedSlot<DemoSlot>[];
  topThree: RankedSlot<DemoSlot>[];
  rankedIdentities: string[];
  canonicalRankedIdentities: string[];
  rankingMatchesCanonical: boolean;
  explanation: string | null;
  ledgerPreview: DecisionLedgerPreview;
};

export const SHUFFLE_SEEDS = [0, 1, 2, 3] as const;

const maxSeed = 999;

/**
 * Normalizza il seed che arriva dalla query string.
 *
 * Qualsiasi valore non intero o fuori range ricade su 0, cioe' l'ordine
 * canonico: la pagina non deve mai dipendere da un input non validato.
 *
 * @param raw Valore grezzo di `?shuffle=`.
 * @returns Seed intero compreso fra 0 e 999.
 */
export function parseShuffleSeed(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) {
    return 0;
  }

  return Math.min(Number(value), maxSeed);
}

/**
 * PRNG deterministico (mulberry32): stesso seed, stessa sequenza, ovunque.
 *
 * @param seed Seed intero.
 * @returns Generatore di numeri in [0, 1).
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Rimescola i candidati in modo deterministico per un dato seed.
 *
 * Serve a dimostrare che il ranker non dipende dall'ordine dell'array in
 * ingresso: cambia solo l'input, il ranking resta identico.
 *
 * @param slots Candidati in ordine canonico.
 * @param seed Seed dello shuffle; 0 lascia l'ordine invariato.
 * @returns Nuovo array con lo stesso contenuto in ordine seedato.
 */
export function shuffleCandidates(slots: readonly DemoSlot[], seed: number): DemoSlot[] {
  const shuffled = [...slots];

  if (seed === 0) {
    return shuffled;
  }

  const random = createRandom(seed);

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const swapped = shuffled[target];

    if (current && swapped) {
      shuffled[index] = swapped;
      shuffled[target] = current;
    }
  }

  return shuffled;
}

/**
 * Serializza la richiesta come fa il bridge di booking prima di scriverla nel
 * ledger: le `Date` diventano ISO, il resto passa invariato.
 *
 * @param request Richiesta strutturata.
 * @returns Oggetto JSON-serializzabile.
 */
function serializeRequest(request: StructuredBookingRequest): Record<string, unknown> {
  return {
    serviceQuery: request.serviceQuery,
    urgency: request.urgency,
    confidence: request.confidence,
    signals: request.signals,
    timePreference: request.timePreference,
    datePreference: request.datePreference
      ? {
          from: request.datePreference.from.toISOString(),
          to: request.datePreference.to.toISOString(),
          label: request.datePreference.label,
        }
      : null,
  };
}

/**
 * Riproduce la giunzione di produzione sul fixture e prepara tutto cio' che la
 * pagina mostra.
 *
 * La catena e' la stessa del bridge di booking: slot liberi grezzi →
 * `filterSlotsByBookingRequest` → `rankSlots` → primi tre. Nessuna delle due
 * funzioni e' reimplementata qui, e nessuna scrittura su database, calendario o
 * LLM avviene.
 *
 * @param seed Seed dello shuffle degli slot grezzi.
 * @returns Vista completa della demo per quel seed.
 */
export function buildDemoView(seed: number): DemoView {
  const rawOrder = shuffleCandidates(DEMO_RAW_SLOTS, seed);
  const candidates = filterSlotsByBookingRequest(rawOrder, DEMO_REQUEST);

  const ranked = rankSlots({
    slots: candidates,
    request: DEMO_REQUEST,
    now: DEMO_NOW,
  });

  const canonicalRanked = rankSlots({
    slots: filterSlotsByBookingRequest([...DEMO_RAW_SLOTS], DEMO_REQUEST),
    request: DEMO_REQUEST,
    now: DEMO_NOW,
  });

  const keptIdentities = new Set(candidates.map(slotIdentity));
  const rankedIdentities = ranked.map((entry) => slotIdentity(entry.slot));
  const canonicalRankedIdentities = canonicalRanked.map((entry) => slotIdentity(entry.slot));
  const explanation = buildRankingExplanation(ranked);

  return {
    seed,
    rawOrder: rawOrder.map((slot) => ({
      slot,
      passesFilter: keptIdentities.has(slotIdentity(slot)),
    })),
    rawOrderChanged: rawOrder.some((slot, index) => slot.label !== DEMO_RAW_SLOTS[index]?.label),
    candidates,
    filteredOutCount: DEMO_RAW_SLOTS.length - candidates.length,
    ranked,
    topThree: ranked.slice(0, 3),
    rankedIdentities,
    canonicalRankedIdentities,
    rankingMatchesCanonical:
      rankedIdentities.length === canonicalRankedIdentities.length &&
      rankedIdentities.every((identity, index) => identity === canonicalRankedIdentities[index]),
    explanation,
    ledgerPreview: {
      ranking_version: SLOT_RANKING_VERSION,
      request: serializeRequest(DEMO_REQUEST),
      explanation,
      candidates: toDecisionCandidates(ranked),
    },
  };
}

const dayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO_TIMEZONE,
  weekday: 'short',
  day: '2-digit',
  month: 'short',
});

const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Giorno locale dello slot, nel fuso dello slot stesso.
 *
 * @param slot Slot da formattare.
 * @returns Etichetta tipo "Tue 28 Apr".
 */
export function formatSlotDay(slot: RankableSlot): string {
  return dayFormatter.format(new Date(slot.start));
}

/**
 * Orario locale di inizio e fine dello slot.
 *
 * @param slot Slot da formattare.
 * @returns Etichetta tipo "15:00 - 15:30".
 */
export function formatSlotClock(slot: RankableSlot): string {
  return `${clockFormatter.format(new Date(slot.start))}–${clockFormatter.format(new Date(slot.end))}`;
}

/**
 * Punti di un segnale con segno esplicito, cosi' l'informazione non passa
 * solo dal colore.
 *
 * @param points Punti assegnati dal ranker.
 * @returns "+40" oppure "0".
 */
export function formatPoints(points: number): string {
  return points > 0 ? `+${points}` : '0';
}
