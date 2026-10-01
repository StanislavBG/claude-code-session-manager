'use strict';

/**
 * gateAuthority.cjs — pure decision rule for "gate authority": whether a
 * green gate re-run may complete a needs_review park on its own, with no
 * human in the loop.
 *
 * Scoped to transcript-noise verdicts only (GATE_AUTHORITY_VERDICTS). Those
 * parks are jobs whose real work landed, but whose transcript had
 * error-looking text, no verdict line, or an abandoned background task — not
 * a real defect. A green re-run of the SAME gate the PRD authored, against
 * the job's own landed commit, with the tracked tree clean, is as much proof
 * of done-ness as the live run's own gate step would have been.
 *
 * Pure: no fs/git/process I/O here. scheduler.cjs computes `outcome`
 * (runGateSequence's result), `ancestorOk` and `cleanOk` and passes them in,
 * so this stays unit-testable with plain objects.
 */

// The only verdicts a green gate re-run may override. Any other verdict
// (for example `shared_tree_reverted`) is a different kind of park, handled
// elsewhere (isStaleSharedTreeRevertedPark in scheduler.cjs) — never widen
// this set to cover those.
const GATE_AUTHORITY_VERDICTS = Object.freeze([
  'transcript_errors',
  'no_verdict_sentinel',
  'abandoned_background_task',
]);

/**
 * decideGateAuthority({ job, gate, outcome, ancestorOk, cleanOk, env }) → { complete, reason }
 *
 * Checks run in a fixed order; the first failed check is the reason. Every
 * check must pass for `complete: true`.
 *
 * @param {object} params
 * @param {object} params.job - the needs_review job row: reads `status`, `verifierVerdict`, `landedCommit`.
 * @param {{source: string, sequence: unknown[]}} params.gate - resolveGate(prdText) output for this PRD.
 * @param {{status: string}} params.outcome - runGateSequence output ('green'|'red'|'unavailable'|'busy').
 * @param {boolean} params.ancestorOk - true when job.landedCommit is an ancestor of the project's current HEAD.
 * @param {boolean} params.cleanOk - true when the tracked tree (app-owned churn stripped) is clean.
 * @param {object} [params.env] - defaults to process.env; pass a plain object in tests.
 * @returns {{complete: boolean, reason: string}}
 */
function decideGateAuthority({ job, gate, outcome, ancestorOk, cleanOk, env = process.env } = {}) {
  if (env?.SM_GATE_AUTHORITATIVE_DISABLE === '1') {
    return { complete: false, reason: 'kill-switch' };
  }
  if (!job || job.status !== 'needs_review' || !GATE_AUTHORITY_VERDICTS.includes(job.verifierVerdict)) {
    return { complete: false, reason: 'verdict-not-eligible' };
  }
  if (typeof job.landedCommit !== 'string' || job.landedCommit.length === 0) {
    return { complete: false, reason: 'no-landed-commit' };
  }
  if (ancestorOk !== true) {
    return { complete: false, reason: 'commit-not-on-head' };
  }
  if (cleanOk !== true) {
    return { complete: false, reason: 'tree-dirty' };
  }
  const gateSource = gate?.source;
  const gateSequence = gate?.sequence;
  const hasGate = (gateSource === 'explicit' || gateSource === 'ac-line') && Array.isArray(gateSequence) && gateSequence.length > 0;
  if (!hasGate) {
    return { complete: false, reason: 'no-gate' };
  }
  if (outcome?.status !== 'green') {
    return { complete: false, reason: 'gate-not-green' };
  }
  return { complete: true, reason: 'gate-green' };
}

module.exports = { GATE_AUTHORITY_VERDICTS, decideGateAuthority };
