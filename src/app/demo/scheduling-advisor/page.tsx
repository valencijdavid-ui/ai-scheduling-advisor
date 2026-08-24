import type { Metadata } from 'next';

import {
  DEMO_MESSAGE,
  DEMO_NOW,
  DEMO_RAW_SLOTS,
  DEMO_REQUEST,
  DEMO_TIMEZONE,
  SHUFFLE_SEEDS,
  SIGNAL_LABELS,
  SLOT_RANKING_VERSION,
  buildDemoView,
  formatPoints,
  formatSlotClock,
  formatSlotDay,
  parseShuffleSeed,
} from './demo-data';
import styles from './demo.module.css';

export const metadata: Metadata = {
  title: 'AI Scheduling Advisor · Deterministic Ranking Demo',
  description:
    'Live, self-contained demo of the deterministic slot ranker: feasible slots in, scores and structured reasons out, no LLM in the ranking path.',
  robots: { index: false, follow: false },
  alternates: { canonical: '/demo/scheduling-advisor' },
};

const upstreamRepositoryUrl = 'https://github.com/Hiberius/whatsapp-receptionist';
const attributionUrl =
  'https://github.com/valencijdavid-ui/ai-scheduling-advisor/blob/main/ATTRIBUTION.md';

const productionFlowSteps = [
  { label: 'Google Calendar / existing availability engine', added: false },
  { label: 'availabilityWindowForRequest → getAvailableSlots', added: false },
  { label: 'filterSlotsByBookingRequest', added: false },
  { label: 'rankSlots()', added: true },
  { label: 'Top 3', added: false },
  { label: 'Existing confirmation flow', added: false },
];

const referenceInstant = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO_TIMEZONE,
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}).format(DEMO_NOW);

const longDayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO_TIMEZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const startTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const timePreferenceWindow = `${DEMO_REQUEST.timePreference.dayPart} (${DEMO_REQUEST.timePreference.startHour}:00–${DEMO_REQUEST.timePreference.endHour}:00)`;

type DemoPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Demo pubblica e autosufficiente della giunzione di ranking.
 *
 * Server Component puro: gira senza Supabase, WhatsApp, Google o chiavi API, e
 * riproduce la catena di produzione — filtro di preferenza esistente, poi
 * `rankSlots()` — sul fixture locale. Non scrive nulla.
 *
 * @param props Query string della richiesta (usata solo per il seed di shuffle).
 * @returns La pagina della demo.
 */
export default async function SchedulingAdvisorDemoPage({ searchParams }: DemoPageProps) {
  const params = await searchParams;
  const seed = parseShuffleSeed(params['shuffle']);
  const view = buildDemoView(seed);

  const best = view.ranked[0];

  const pipelineSteps = [
    { value: String(DEMO_RAW_SLOTS.length), label: 'available slots', added: false },
    { value: String(view.filteredOutCount), label: 'filtered out', added: false },
    { value: String(view.candidates.length), label: 'rankable', added: false },
    { value: 'rankSlots()', label: 'deterministic ranking', added: true },
    { value: 'Top 3', label: 'proposed', added: false },
  ];

  return (
    <main id="main" className={`container ${styles.page}`}>
      <div className={styles.story}>
        <div className={styles.opening}>
          <header className={`stack stack-4 ${styles.hero}`}>
            <div className={styles.heroMeta}>
              <span className="badge badge-success">Live deterministic demo</span>
              <span className={styles.versionChip}>
                <span aria-hidden="true">◆</span>
                {SLOT_RANKING_VERSION}
              </span>
            </div>
            <h1 className={`display ${styles.heroTitle}`}>AI Scheduling Advisor</h1>
            <p className={styles.heroLead}>
              Turn appointment requests into the best available time slots — deterministically.
            </p>
            <p className="muted">
              Ranks already-feasible booking slots using explicit business rules, with a structured
              explanation for every decision.
            </p>
          </header>

          <ol className={styles.pipeline} aria-label="Booking pipeline for this request">
            {pipelineSteps.map((step) => (
              <li key={step.label} className={styles.pipelineItem}>
                <span
                  className={`${styles.pipelineCell} ${step.added ? styles.pipelineCellActive : ''}`}
                >
                  <span className={styles.pipelineValue}>{step.value}</span>
                  <span className={styles.pipelineLabel}>
                    {step.label}
                    {step.added ? <span className="sr-only"> (added by this fork)</span> : null}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          <div className={styles.leadGrid}>
            <section className="card card-padded stack stack-4" aria-labelledby="request-heading">
              <div className="stack stack-2">
                <span className="eyebrow">The request</span>
                <h2 id="request-heading" className={styles.sectionTitle}>
                  What the customer asked
                </h2>
              </div>
              <blockquote className={styles.quote}>“{DEMO_MESSAGE}”</blockquote>
              <dl className={styles.facts}>
                <div className={styles.fact}>
                  <dt>Time preference</dt>
                  <dd>{timePreferenceWindow}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Urgency</dt>
                  <dd>{DEMO_REQUEST.urgency}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>Requested date</dt>
                  <dd>none</dd>
                </div>
              </dl>

              <details className={styles.disclosure}>
                <summary className={styles.disclosureSummary}>
                  View fixture metadata and caveats
                </summary>
                <div className={`stack stack-3 ${styles.disclosureBody}`}>
                  <dl className={styles.definitions}>
                    <dt>Explicit target time</dt>
                    <dd>{DEMO_REQUEST.timePreference.startHour}:00</dd>
                    <dt>Confidence</dt>
                    <dd>{DEMO_REQUEST.confidence}</dd>
                    <dt>Signals</dt>
                    <dd>{DEMO_REQUEST.signals.join(', ')}</dd>
                    <dt>Reference instant</dt>
                    <dd>{referenceInstant}</dd>
                  </dl>
                  <p className="muted">
                    This is a hand-authored <code className="mono">StructuredBookingRequest</code> —
                    the exact input type the pipeline receives in production. The sentence above is
                    its human-readable rendering, not the output of the Italian rule-based
                    extractor, which this demo does not run. The reference instant is injected:
                    nothing here reads the system clock.
                  </p>
                </div>
              </details>
            </section>

            {best ? (
              <section
                className={`${styles.bestMatch} stack stack-4`}
                aria-labelledby="best-match-heading"
              >
                <div className="stack stack-2">
                  <span className="eyebrow">Best match</span>
                  <h2 id="best-match-heading" className="sr-only">
                    Best match
                  </h2>
                  <p className={styles.bestMatchDay}>
                    {longDayFormatter.format(new Date(best.slot.start))}
                  </p>
                  <p className={styles.bestMatchTime}>
                    {startTimeFormatter.format(new Date(best.slot.start))}
                    <span className={styles.bestMatchRange}>{formatSlotClock(best.slot)}</span>
                  </p>
                </div>

                <p className={styles.bestMatchScore}>
                  <span className={styles.bestMatchScoreValue}>{best.score}</span>
                  <span className={styles.bestMatchScoreLabel}>score</span>
                </p>

                <div className="stack stack-3">
                  <h3 className="label">Why this slot</h3>
                  <ul className={styles.whyList}>
                    {best.reasons.map((reason) => (
                      <li
                        key={reason.signal}
                        className={`${styles.why} ${reason.points > 0 ? '' : styles.whyZero}`}
                      >
                        <span className={styles.whyPoints}>{formatPoints(reason.points)}</span>
                        <span className={styles.whyLabel}>{SIGNAL_LABELS[reason.signal]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            ) : null}
          </div>
        </div>

        <section className={styles.shuffleBar} aria-labelledby="shuffle-heading">
          <div className="stack stack-2">
            <h2 id="shuffle-heading" className={styles.sectionTitle}>
              Shuffle candidate input
            </h2>
            <p className="muted">Change input order. The ranking will stay identical.</p>
          </div>
          <div className={styles.shuffleControls} role="group" aria-labelledby="shuffle-heading">
            {SHUFFLE_SEEDS.map((option) => {
              const isActive = option === view.seed;
              const href =
                option === 0
                  ? '/demo/scheduling-advisor'
                  : `/demo/scheduling-advisor?shuffle=${option}`;

              return (
                <a
                  key={option}
                  href={href}
                  className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                  aria-current={isActive ? 'true' : undefined}
                >
                  {option === 0 ? 'Canonical order' : `Seed ${option}`}
                </a>
              );
            })}
          </div>
          {view.rawOrderChanged ? (
            view.rankingMatchesCanonical ? (
              <p className={styles.proof}>
                <span className={styles.proofMark} aria-hidden="true">
                  ✓
                </span>
                <span>
                  <strong>Input order changed · ranked result unchanged.</strong> Verified in code
                  by comparing the ranked slot identities against the canonical unshuffled run.
                </span>
              </p>
            ) : (
              <p className={`${styles.proof} ${styles.proofBroken}`}>
                <span className={styles.proofMark} aria-hidden="true">
                  ✕
                </span>
                <span>
                  Input order changed and the ranked identities no longer match the canonical run.
                </span>
              </p>
            )
          ) : (
            <p className="muted">
              Currently showing the canonical order. Pick a seed to reorder the array that enters
              the pipeline; the ranking below will not move.
            </p>
          )}
        </section>

        <section className="stack stack-6" aria-labelledby="ranked-heading">
          <div className={styles.sectionHead}>
            <div className="stack stack-2">
              <span className="eyebrow">Ranked results</span>
              <h2 id="ranked-heading" className={styles.sectionTitle}>
                All {view.ranked.length} candidates, scored
              </h2>
            </div>
            <span className="badge badge-neutral">integer weights · deterministic tie-break</span>
          </div>
          <p className="muted" style={{ maxWidth: 'var(--max-w-prose)' }}>
            Every score is the plain sum of its structured reasons. Ties are broken by earliest
            start, then by a stable slot identity — so two runs can never disagree.
          </p>
          <ol className={styles.rankList}>
            {view.ranked.map((entry, index) => {
              const rank = index + 1;
              const isProposed = rank <= 3;

              return (
                <li
                  key={entry.slot.start}
                  className={[
                    styles.rankRow,
                    rank === 1 ? styles.rankRowLead : '',
                    rank > 1 && isProposed ? styles.rankRowSecondary : '',
                    isProposed ? '' : styles.rankRowQuiet,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className={styles.rankIdentity}>
                    <span
                      className={`${styles.rankNumber} ${isProposed ? styles.rankNumberTop : ''}`}
                      aria-hidden="true"
                    >
                      #{rank}
                    </span>
                    <span className={styles.rankWhen}>
                      <span className={styles.rankDay}>
                        <span className="sr-only">Rank {rank}: </span>
                        {formatSlotDay(entry.slot)} · {formatSlotClock(entry.slot)}
                      </span>
                      <span className={styles.rankClock}>
                        {isProposed ? `Option ${rank} · ` : ''}candidate {entry.slot.label}
                      </span>
                    </span>
                  </div>

                  <p className={styles.rankScore}>
                    <span className={styles.rankScoreValue}>{entry.score}</span>
                    <span className={styles.rankScoreLabel}>score</span>
                  </p>

                  <ul className={styles.reasonChips}>
                    {entry.reasons.map((reason) => (
                      <li
                        key={reason.signal}
                        className={`${styles.reasonChip} ${
                          reason.points > 0 ? '' : styles.reasonChipZero
                        }`}
                      >
                        <span className={styles.reasonChipPoints}>
                          {formatPoints(reason.points)}
                        </span>
                        {SIGNAL_LABELS[reason.signal]}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
          <p className="muted">
            The first three entries are exactly <code className="mono">ranked.slice(0, 3)</code> —
            the slots the existing booking conversation stores for later confirmation, so confirming
            “option 2” selects that stored slot by identity. This demo does not call{' '}
            <code className="mono">createAppointment()</code>. Nothing is booked.
          </p>
        </section>

        <section className="stack stack-6" aria-labelledby="evidence-heading">
          <div className="stack stack-2">
            <span className="eyebrow">Production seam</span>
            <h2 id="evidence-heading" className={styles.sectionTitle}>
              What the ranker was given
            </h2>
          </div>
          <dl className={styles.statRow}>
            <div className={styles.stat}>
              <dt>Available slots</dt>
              <dd>{DEMO_RAW_SLOTS.length}</dd>
            </div>
            <div className={styles.stat}>
              <dt>Filtered out</dt>
              <dd>{view.filteredOutCount}</dd>
            </div>
            <div className={styles.stat}>
              <dt>Rankable</dt>
              <dd>{view.candidates.length}</dd>
            </div>
          </dl>
          <p className="muted" style={{ maxWidth: 'var(--max-w-prose)' }}>
            Free slots as the existing availability engine would return them, then the upstream{' '}
            <code className="mono">filterSlotsByBookingRequest()</code>: with a{' '}
            <code className="mono">{DEMO_REQUEST.timePreference.dayPart}</code> preference it keeps
            local start times in{' '}
            <code className="mono">
              [{DEMO_REQUEST.timePreference.startHour}:00, {DEMO_REQUEST.timePreference.endHour}:00)
            </code>{' '}
            and drops the rest. Ranking only ever sees what survives.
          </p>

          <details className={styles.disclosure}>
            <summary className={styles.disclosureSummary}>
              View all {DEMO_RAW_SLOTS.length} slots and their filter outcome
            </summary>
            <div className={`stack stack-4 ${styles.disclosureBody}`}>
              <ol className={styles.candidateList}>
                {view.rawOrder.map(({ slot, passesFilter }) => (
                  <li
                    key={slot.start}
                    className={`${styles.candidate} ${passesFilter ? '' : styles.candidateOut}`}
                  >
                    <span className={styles.candidateLabel} aria-hidden="true">
                      {slot.label}
                    </span>
                    <span className={styles.candidateTime}>
                      <span className="sr-only">Slot {slot.label}: </span>
                      {formatSlotDay(slot)}
                      <br />
                      {formatSlotClock(slot)}
                      <span className={styles.candidateTag}>
                        {passesFilter ? 'rankable' : 'filtered out'}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="stack stack-3">
                <h3 className="label">
                  The exact array passed to <code className="mono">rankSlots()</code>
                </h3>
                <ol className={styles.candidateList}>
                  {view.candidates.map((slot) => (
                    <li key={slot.start} className={styles.candidate}>
                      <span className={styles.candidateLabel} aria-hidden="true">
                        {slot.label}
                      </span>
                      <span className={styles.candidateTime}>
                        <span className="sr-only">Candidate {slot.label}: </span>
                        {formatSlotDay(slot)}
                        <br />
                        {formatSlotClock(slot)}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </details>
        </section>

        <section className="stack stack-6" aria-labelledby="ledger-heading">
          <div className={styles.sectionHead}>
            <div className="stack stack-2">
              <span className="eyebrow">Auditability</span>
              <h2 id="ledger-heading" className={styles.sectionTitle}>
                Decision ledger
              </h2>
            </div>
            <span className="badge badge-warm">Preview only — no database write</span>
          </div>
          <p className="muted" style={{ maxWidth: 'var(--max-w-prose)' }}>
            In production this row is written to <code className="mono">scheduling_decisions</code>{' '}
            so a past proposal can be audited months later, after the weights have moved on. The
            candidates are produced by the real <code className="mono">toDecisionCandidates()</code>{' '}
            projection over the ranked output — this page does not restate the scores.
          </p>
          <details className={styles.disclosure}>
            <summary className={styles.disclosureSummary}>View raw decision ledger</summary>
            <div className={`stack stack-3 ${styles.disclosureBody}`}>
              <p className="muted">
                <strong>Raw engine payload.</strong> Reason objects appear exactly as{' '}
                <code className="mono">rankSlots()</code> returned them, so the{' '}
                <code className="mono">detail</code> strings are the product’s Italian copy,
                untranslated. Ranking order is preserved, so{' '}
                <code className="mono">candidates[0..2]</code> are exactly the three proposed slots.
                No database write occurs in this standalone demo.
              </p>
              <pre
                className={styles.ledger}
                tabIndex={0}
                role="region"
                aria-label="Decision ledger preview, raw engine payload as JSON"
              >
                <code>{JSON.stringify(view.ledgerPreview, null, 2)}</code>
              </pre>
            </div>
          </details>
        </section>

        <section className="stack stack-6" aria-labelledby="trust-heading">
          <div className="stack stack-2">
            <span className="eyebrow">Why it holds up</span>
            <h2 id="trust-heading" className={styles.sectionTitle}>
              Architecture
            </h2>
          </div>
          <div className={styles.trustGrid}>
            <article className="card card-padded stack stack-2">
              <h3>Deterministic</h3>
              <p className="muted">
                Same inputs always produce the same ranking. No clock reads, no randomness, no
                dependency on candidate array order.
              </p>
            </article>
            <article className="card card-padded stack stack-2">
              <h3>Explainable</h3>
              <p className="muted">
                Every score is the sum of structured reasons. Integer weights only — a score can be
                re-derived by hand during an audit.
              </p>
            </article>
            <article className="card card-padded stack stack-2">
              <h3>LLM-independent ranking</h3>
              <p className="muted">
                The LLM can understand requests, but it never chooses the winning slot. Ranking is
                pure code with a versioned weight set.
              </p>
            </article>
          </div>
          <div className="card card-padded stack stack-3">
            <h3 className="label">Where it sits</h3>
            <ol
              className={`${styles.flow} ${styles.flowStacked}`}
              aria-label="Position in the existing booking flow"
            >
              {productionFlowSteps.map((step) => (
                <li key={step.label} className={styles.flowItem}>
                  <span className={`${styles.flowStep} ${step.added ? styles.flowStepActive : ''}`}>
                    {step.label}
                    {step.added ? <span className="sr-only"> (added by this fork)</span> : null}
                  </span>
                </li>
              ))}
            </ol>
            <p className="muted">
              The highlighted step is what this fork adds; everything else is the upstream booking
              flow, unchanged. This demo page calls none of the transport or storage around it: no
              Google Calendar, no WhatsApp, no Supabase — only the preference filter and the ranker,
              on a local fixture.
            </p>
          </div>
        </section>

        <footer className={`stack stack-3 ${styles.provenance}`}>
          <p>
            <strong>AI Scheduling Advisor</strong> is a portfolio extension of the MIT-licensed{' '}
            <a className="btn-link" href={upstreamRepositoryUrl} rel="noreferrer noopener">
              Hiberius/whatsapp-receptionist
            </a>{' '}
            project. The WhatsApp transport, AI reply orchestration, booking engine, Google Calendar
            integration, multi-tenancy and billing are upstream work.
          </p>
          <p>
            This demo visualizes the deterministic ranking extension added in this fork. Full
            breakdown of what is upstream and what is added:{' '}
            <a className="btn-link" href={attributionUrl} rel="noreferrer noopener">
              ATTRIBUTION.md
            </a>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}
