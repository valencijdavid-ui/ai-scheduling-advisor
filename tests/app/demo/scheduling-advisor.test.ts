// Test della demo pubblica del ranker. Verifica che la pagina sia una vista
// sulla giunzione di produzione — filtro di preferenza esistente, poi
// `rankSlots()` — e non una sua copia: candidati, ordine, punteggi, motivazioni
// e preview del ledger devono venire tutti dalle funzioni reali.

import { describe, expect, it, vi } from 'vitest';

import {
  DEMO_NOW,
  DEMO_RAW_SLOTS,
  DEMO_REQUEST,
  SHUFFLE_SEEDS,
  SLOT_RANKING_VERSION,
  buildDemoView,
  parseShuffleSeed,
  shuffleCandidates,
} from '@/app/demo/scheduling-advisor/demo-data';
import { filterSlotsByBookingRequest } from '@/server/ai/booking-extractor';
import { rankSlots, slotIdentity } from '@/server/appointments/slot-ranking';

const canonicalRankedLabels = ['C', 'G', 'D', 'H', 'I', 'J'];

const canonicalCandidateLabels = ['C', 'D', 'G', 'H', 'I', 'J'];

const shuffleSeeds = SHUFFLE_SEEDS.filter((seed) => seed !== 0);

const zonedHour = (isoStart: string, timezone: string): number => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(isoStart));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');

  return read('hour') + read('minute') / 60;
};

describe('production seam', () => {
  it('derives the ranker input with the real filterSlotsByBookingRequest', () => {
    for (const seed of SHUFFLE_SEEDS) {
      const view = buildDemoView(seed);
      const rawOrder = view.rawOrder.map((entry) => entry.slot);

      expect(view.candidates).toEqual(filterSlotsByBookingRequest(rawOrder, DEMO_REQUEST));
    }
  });

  it('keeps the raw fixture larger than the rankable set', () => {
    const view = buildDemoView(0);

    expect(DEMO_RAW_SLOTS.length).toBe(10);
    expect(view.candidates.map((slot) => slot.label)).toEqual(canonicalCandidateLabels);
    expect(view.filteredOutCount).toBe(DEMO_RAW_SLOTS.length - view.candidates.length);
    expect(view.filteredOutCount).toBeGreaterThan(0);
  });

  it('never lets a slot outside the requested time window reach rankSlots', () => {
    const { startHour, endHour } = DEMO_REQUEST.timePreference;

    expect(startHour).not.toBeNull();
    expect(endHour).not.toBeNull();

    for (const seed of SHUFFLE_SEEDS) {
      const view = buildDemoView(seed);

      for (const slot of view.candidates) {
        const hour = zonedHour(slot.start, slot.timezone);

        expect(hour).toBeGreaterThanOrEqual(startHour ?? 0);
        expect(hour).toBeLessThan(endHour ?? 24);
      }

      // Gli slot prima delle 15 sono nel fixture e devono restare fuori.
      const droppedBeforeAnchor = view.rawOrder.filter(
        (entry) => !entry.passesFilter && zonedHour(entry.slot.start, entry.slot.timezone) < 15,
      );

      expect(droppedBeforeAnchor.length).toBeGreaterThan(0);

      for (const dropped of droppedBeforeAnchor) {
        expect(view.ranked.some((entry) => entry.slot.label === dropped.slot.label)).toBe(false);
      }
    }
  });

  it('marks every raw slot with the outcome the filter actually gave it', () => {
    const view = buildDemoView(0);
    const keptLabels = new Set(view.candidates.map((slot) => slot.label));

    expect(view.rawOrder).toHaveLength(DEMO_RAW_SLOTS.length);

    for (const entry of view.rawOrder) {
      expect(entry.passesFilter).toBe(keptLabels.has(entry.slot.label));
    }
  });

  it('ranks exactly the filtered candidates, matching a direct rankSlots call', () => {
    const view = buildDemoView(0);

    const direct = rankSlots({
      slots: filterSlotsByBookingRequest([...DEMO_RAW_SLOTS], DEMO_REQUEST),
      request: DEMO_REQUEST,
      now: DEMO_NOW,
    });

    expect(view.ranked).toEqual(direct);
    expect(view.ranked).toHaveLength(view.candidates.length);
    expect(view.ranked.map((entry) => entry.slot.label)).toEqual(canonicalRankedLabels);
  });

  it('scores every slot as the exact sum of the reasons the ranker returned', () => {
    const view = buildDemoView(0);

    for (const entry of view.ranked) {
      expect(entry.reasons.reduce((total, reason) => total + reason.points, 0)).toBe(entry.score);
    }
  });
});

describe('deterministic shuffle', () => {
  it('reorders the raw input for every non-canonical seed', () => {
    for (const seed of shuffleSeeds) {
      const view = buildDemoView(seed);

      expect(view.rawOrder.map((entry) => entry.slot.label)).not.toEqual(
        DEMO_RAW_SLOTS.map((slot) => slot.label),
      );
      expect(view.rawOrderChanged).toBe(true);
      expect([...view.rawOrder].map((entry) => entry.slot.label).sort()).toEqual(
        [...DEMO_RAW_SLOTS].map((slot) => slot.label).sort(),
      );
    }
  });

  it('is stable for a given seed', () => {
    for (const seed of shuffleSeeds) {
      expect(shuffleCandidates(DEMO_RAW_SLOTS, seed)).toEqual(
        shuffleCandidates(DEMO_RAW_SLOTS, seed),
      );
    }
  });

  it('changes the filtered candidate order without changing the ranking', () => {
    const canonical = buildDemoView(0);
    let sawReorderedCandidates = false;

    for (const seed of shuffleSeeds) {
      const view = buildDemoView(seed);

      if (
        view.candidates.map((slot) => slot.label).join('') !==
        canonical.candidates.map((slot) => slot.label).join('')
      ) {
        sawReorderedCandidates = true;
      }

      expect(view.rankedIdentities).toEqual(canonical.rankedIdentities);
      expect(view.rankingMatchesCanonical).toBe(true);
      expect(view.ranked).toEqual(canonical.ranked);
    }

    expect(sawReorderedCandidates).toBe(true);
  });

  it('exposes the identities it compares, so the proof is not decorative', () => {
    const view = buildDemoView(1);

    expect(view.rankedIdentities).toEqual(view.ranked.map((entry) => slotIdentity(entry.slot)));
    expect(view.canonicalRankedIdentities).toEqual(
      rankSlots({
        slots: filterSlotsByBookingRequest([...DEMO_RAW_SLOTS], DEMO_REQUEST),
        request: DEMO_REQUEST,
        now: DEMO_NOW,
      }).map((entry) => slotIdentity(entry.slot)),
    );
  });

  it('falls back to the canonical order for any unusable seed', () => {
    expect(parseShuffleSeed(undefined)).toBe(0);
    expect(parseShuffleSeed('')).toBe(0);
    expect(parseShuffleSeed('abc')).toBe(0);
    expect(parseShuffleSeed('-1')).toBe(0);
    expect(parseShuffleSeed('1.5')).toBe(0);
    expect(parseShuffleSeed('10000')).toBe(0);
    expect(parseShuffleSeed('7')).toBe(7);
    expect(parseShuffleSeed(['2', '3'])).toBe(2);
  });
});

describe('top three proposal', () => {
  it('is exactly the first three ranked entries', () => {
    for (const seed of SHUFFLE_SEEDS) {
      const view = buildDemoView(seed);

      expect(view.topThree).toHaveLength(3);
      expect(view.topThree).toEqual(view.ranked.slice(0, 3));
    }
  });
});

describe('decision ledger preview', () => {
  it('derives scores and reasons from the ranked output instead of restating them', () => {
    const view = buildDemoView(0);

    expect(view.ledgerPreview.ranking_version).toBe(SLOT_RANKING_VERSION);
    expect(view.ledgerPreview.candidates).toHaveLength(view.ranked.length);

    view.ledgerPreview.candidates.forEach((candidate, index) => {
      const ranked = view.ranked[index];

      expect(ranked).toBeDefined();
      expect(candidate.start).toBe(ranked?.slot.start);
      expect(candidate.end).toBe(ranked?.slot.end);
      expect(candidate.score).toBe(ranked?.score);
      expect(candidate.reasons).toBe(ranked?.reasons);
    });
  });

  it('serializes the request the way the booking bridge does', () => {
    const view = buildDemoView(0);

    expect(view.ledgerPreview.request).toEqual({
      serviceQuery: DEMO_REQUEST.serviceQuery,
      urgency: DEMO_REQUEST.urgency,
      confidence: DEMO_REQUEST.confidence,
      signals: DEMO_REQUEST.signals,
      timePreference: DEMO_REQUEST.timePreference,
      datePreference: null,
    });
    expect(JSON.parse(JSON.stringify(view.ledgerPreview))).toBeTruthy();
  });

  it('carries the ranker explanation verbatim', () => {
    const view = buildDemoView(0);

    expect(view.ledgerPreview.explanation).toBe(view.explanation);
    expect(view.explanation).toContain(SLOT_RANKING_VERSION);
  });
});

describe('standalone operation', () => {
  it('builds the whole view with no external credentials configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('WHATSAPP_API_KEY', '');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');

    vi.resetModules();

    const demoData = await import('@/app/demo/scheduling-advisor/demo-data');
    const view = demoData.buildDemoView(2);

    expect(view.rawOrder).toHaveLength(DEMO_RAW_SLOTS.length);
    expect(view.candidates.length).toBeLessThan(DEMO_RAW_SLOTS.length);
    expect(view.topThree).toHaveLength(3);

    vi.unstubAllEnvs();
  });
});
