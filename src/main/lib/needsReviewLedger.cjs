'use strict';

/**
 * needsReviewLedger.cjs — pure helpers that make `needs_review` episodes
 * durable and queryable in history.jsonl.
 *
 * Before this module, `queueHistory.cjs` archived a job to history.jsonl
 * only on a TERMINAL status (completed/failed/skipped) — a needs_review
 * park never left queue.json's hot jobs[] (it isn't terminal; see
 * queueHistory.cjs's partitionJobs), so it never reached durable history
 * either. Profiling history.jsonl for "how much needs_review is really
 * happening" therefore always returned zero, however loud the problem
 * looked in the UI.
 *
 * Two line shapes are appended to the SAME history.jsonl a terminal row
 * lands in, distinguished by `kind` so existing terminal-only readers can
 * filter them out on sight (see scheduleJobTransitions.cjs, the actual
 * write choke point, and its callers' audit in the owning PRD):
 *   - kind: 'needs_review_entry'      — one per transition INTO needs_review
 *   - kind: 'needs_review_resolution' — one per transition OUT of needs_review,
 *     referencing the entry's own runId so the two can be paired
 *
 * Kept fs-free and pure (mirrors reaperHelpers.cjs's rationale) so the
 * ladder-rung classification and rollup reduction are unit-testable without
 * touching disk or importing scheduler.cjs (which requires electron).
 */

// The 6 named ladder rungs a needs_review episode can resolve through
// (spawnJob's mechanical/resume/quarantine/auto-fix branches, the periodic
// reverifyNeedsReview heal pass, or an explicit human/API reset). Any
// resolution whose transitionJob `source` doesn't match a known automated
// rung is bucketed as 'manual-reset' — the conservative default for
// anything that isn't a recognized self-healing path.
const LADDER_RUNGS = [
  'mechanical-recovery',
  'resume-recovery',
  'quarantine',
  'auto-fix',
  'reverify',
  'manual-reset',
];

/**
 * classifyLadderRung({ source, reason }) → one of LADDER_RUNGS.
 *
 * Matches the exact `source` strings scheduleJobTransitions.cjs's callers in
 * scheduler.cjs pass for each recovery-ladder rung (see that module's
 * LEGAL_TRANSITIONS doc comment for the full call-site inventory). Pattern
 * matching, not an exhaustive enum lookup, because 'spawnJob:dispatch' is
 * shared between the ordinary pending->running dispatch and the
 * needs_review->running resume-recovery dispatch — the two are only
 * distinguishable by `reason` text.
 */
function classifyLadderRung({ source, reason } = {}) {
  const s = typeof source === 'string' ? source : '';
  const r = typeof reason === 'string' ? reason : '';

  if (s === 'scheduler:mechanicalRecovery') return 'mechanical-recovery';
  if (s === 'spawnJob:dispatch' && /resume-recovery/i.test(r)) return 'resume-recovery';
  if (s === 'spawnInvestigation:start' || s === 'spawnJob:auto-promote' || s === 'reverifyNeedsReview:auto-promote') {
    return 'auto-fix';
  }
  if (s === 'reverifyNeedsReview:heal' || s === 'needsReviewAutoResolve') return 'reverify';
  // No transitionJob call site resolves needs_review with a 'quarantine'
  // source today (performLeftoverQuarantine cleans up leftover paths without
  // itself changing job.status — the row stays needs_review until a later
  // reverify/auto-resolve pass actually resolves it), but the rung is kept
  // in LADDER_RUNGS/this classifier so a future direct-resolving quarantine
  // path is classified correctly without another migration.
  return 'manual-reset';
}

/**
 * buildNeedsReviewEntryLine(job, entry) → JSONL-ready object.
 *
 * `entry` is the statusHistory record scheduleJobTransitions.cjs just
 * pushed for this transition ({ from, to, reason, source, at }). The park
 * reason prefers the structured `verifierVerdict` (a short, bucketable
 * code) over the free-text `heldReason`/`error` fields, since those are the
 * only reason evidence available for parks that never went through the
 * verifier (e.g. a pidless-reap needs_review park).
 */
function buildNeedsReviewEntryLine(job, entry) {
  return {
    kind: 'needs_review_entry',
    slug: job?.slug ?? null,
    cwd: job?.cwd ?? null,
    epicId: job?.epicId ?? null,
    runId: job?.runId ?? null,
    at: entry?.at ?? new Date().toISOString(),
    reason: job?.verifierVerdict ?? job?.heldReason ?? job?.error ?? null,
    source: entry?.source ?? null,
  };
}

/**
 * buildNeedsReviewResolutionLine(job, entry, episode) → JSONL-ready object.
 *
 * `episode` is `{ runId, enteredAt }` captured off the job at entry time
 * (needsReviewEntryRunId/needsReviewEnteredAt) — the resolution line
 * references the ENTRY's runId (which may differ from `job.runId` by
 * resolution time, e.g. after a resume-recovery re-dispatch minted a fresh
 * one), not whatever runId the job carries right now.
 */
function buildNeedsReviewResolutionLine(job, entry, episode) {
  const enteredAtMs = episode?.enteredAt ? Date.parse(episode.enteredAt) : NaN;
  const resolvedAtMs = entry?.at ? Date.parse(entry.at) : NaN;
  const dwellMs = Number.isFinite(enteredAtMs) && Number.isFinite(resolvedAtMs)
    ? Math.max(0, resolvedAtMs - enteredAtMs)
    : null;
  return {
    kind: 'needs_review_resolution',
    slug: job?.slug ?? null,
    cwd: job?.cwd ?? null,
    epicId: job?.epicId ?? null,
    runId: episode?.runId ?? job?.runId ?? null,
    at: entry?.at ?? new Date().toISOString(),
    resolvedTo: entry?.to ?? null,
    ladderRung: classifyLadderRung({ source: entry?.source, reason: entry?.reason }),
    source: entry?.source ?? null,
    dwellMs,
  };
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

/**
 * reduceNeedsReviewLedger(lines) → rollup.
 *
 * Pure O(n log n) reduction (the log n is the dwell-time sort for the
 * percentiles) over a flat array of already-parsed history.jsonl rows
 * (mixing needs_review_entry/needs_review_resolution/terminal rows is fine —
 * anything that isn't one of the two kinds this module writes is ignored).
 *
 * Pairs an entry with its resolution by (slug, runId) — the same pairing
 * key buildNeedsReviewResolutionLine's `episode.runId` guarantees matches
 * the entry line's `runId`. A slug that parks twice (two different runIds)
 * produces two independent pairs, matching two independent recovery
 * episodes rather than being conflated into one.
 *
 * Returns:
 *   - byReason:     { [reason]: entryCount }   (reason = entry line's `reason`, or 'unknown')
 *   - byLadderRung: { [rung]: resolutionCount } (rung = one of LADDER_RUNGS)
 *   - unresolvedCount: entries with no matching resolution line yet
 *   - dwellMsP50 / dwellMsP90: percentiles over resolved episodes' dwellMs (null if none)
 */
function reduceNeedsReviewLedger(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const entriesByKey = new Map();
  const resolutionsByKey = new Map();

  for (const line of list) {
    if (!line || typeof line !== 'object') continue;
    const key = `${line.slug ?? ''}|${line.runId ?? ''}`;
    if (line.kind === 'needs_review_entry') {
      entriesByKey.set(key, line);
    } else if (line.kind === 'needs_review_resolution') {
      resolutionsByKey.set(key, line);
    }
  }

  const byReason = {};
  let unresolvedCount = 0;
  for (const [key, entry] of entriesByKey) {
    const reason = entry.reason ?? 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (!resolutionsByKey.has(key)) unresolvedCount += 1;
  }

  const byLadderRung = {};
  const dwellMsValues = [];
  for (const [key, resolution] of resolutionsByKey) {
    const rung = LADDER_RUNGS.includes(resolution.ladderRung) ? resolution.ladderRung : 'manual-reset';
    byLadderRung[rung] = (byLadderRung[rung] ?? 0) + 1;
    // Only count dwell for episodes that actually matched an entry — a
    // resolution line with no paired entry (e.g. history truncated by
    // retention before the entry aged out — never happens for needs_review
    // rows today since they're excluded from partitionJobs' archivable set,
    // but this stays defensive) has no truthful dwell to report.
    if (entriesByKey.has(key) && typeof resolution.dwellMs === 'number' && Number.isFinite(resolution.dwellMs)) {
      dwellMsValues.push(resolution.dwellMs);
    }
  }
  dwellMsValues.sort((a, b) => a - b);

  return {
    byReason,
    byLadderRung,
    unresolvedCount,
    dwellMsP50: percentile(dwellMsValues, 50),
    dwellMsP90: percentile(dwellMsValues, 90),
  };
}

module.exports = {
  LADDER_RUNGS,
  classifyLadderRung,
  buildNeedsReviewEntryLine,
  buildNeedsReviewResolutionLine,
  reduceNeedsReviewLedger,
};
