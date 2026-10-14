'use strict';

/**
 * baselineGate.cjs — pure decision rule for "baseline gate authority": whether
 * a needs_review park whose gate is red may complete on its own because every
 * failure at HEAD already existed at the job's base commit.
 *
 * The park class: an executor committed correct work, but the PRD gate is red
 * for reasons the job did not cause ("N pre-existing failures, identical on
 * base"). The proof is a subset test on failing-test ids — HEAD's failing ids
 * in the failing gate step must all appear in the base run's failing ids for
 * that SAME step. A job that adds even one new failing test is refused.
 *
 * Pure: no fs/git/process I/O. scheduler.cjs runs the gate at HEAD and at the
 * base commit and passes the two runGateSequence outcomes (each result carries
 * `outputTail`) plus the git proofs in.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Strip a trailing vitest/jest duration like " 12ms" / " (3 ms)". */
function stripDuration(s) {
  return s.replace(/\s+\(?\d+(?:\.\d+)?\s*m?s\)?\s*$/, '').trim();
}

/**
 * parseFailingTests(output) → sorted unique failing-test ids, or null when the
 * output shows failure but no id is parseable.
 *
 * Formats: pytest `FAILED path::name`; vitest `FAIL  path > ... > name` and
 * `× name` under a FAIL file; jest `● Suite › name`; tsc
 * `file(line,col): error TSnnnn` → `file:TSnnnn`.
 *
 * @param {string} output
 * @returns {string[]|null}
 */
function parseFailingTests(output) {
  const text = typeof output === 'string' ? output.replace(ANSI_RE, '') : '';
  const ids = new Set();
  let currentFile = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^FAILED\s+(\S+?)(?:\s+-\s.*)?$/.exec(line))) {
      ids.add(m[1]);
      continue;
    }
    if ((m = /^\s*FAIL\s+(.+)$/.exec(line))) {
      const body = stripDuration(m[1]);
      if (body.includes(' > ')) {
        ids.add(body);
        currentFile = body.split(' > ')[0].trim();
      } else {
        currentFile = body;
      }
      continue;
    }
    if (currentFile && (m = /^\s*[×✗✕]\s+(.+)$/.exec(line))) {
      ids.add(`${currentFile} > ${stripDuration(m[1])}`);
      continue;
    }
    if ((m = /^\s*●\s+(.+?\s›\s.+)$/.exec(line))) {
      ids.add(m[1].trim());
      continue;
    }
    if ((m = /^(.+?)\(\d+,\d+\):\s*error\s+(TS\d+)\b/.exec(line))) {
      ids.add(`${m[1].trim()}:${m[2]}`);
      continue;
    }
    if ((m = /^(.+?):\d+:\d+\s+-\s*error\s+(TS\d+)\b/.exec(line))) {
      ids.add(`${m[1].trim()}:${m[2]}`);
    }
  }
  return ids.size ? [...ids].sort() : null;
}

/** The failing step of a red outcome: runGateSequence stops at the first failure. */
function failingStep(outcome) {
  const results = Array.isArray(outcome?.results) ? outcome.results : [];
  if (!results.length) return null;
  const index = results.length - 1;
  return { index, output: results[index]?.outputTail };
}

/**
 * decideBaselineAuthority({ job, headOutcome, baseOutcome, evidenceOk, ancestorOk, cleanOk, headStable, env })
 *   → { complete, reason, preexisting }
 *
 * Checks run in a fixed order; the first failed check is the reason.
 *
 * @param {object} params
 * @param {object} params.job - needs_review row: reads `status`, `verifierVerdict`, `landedCommit`.
 * @param {{status: string, results: object[]}} params.headOutcome - runGateSequence at HEAD.
 * @param {{status: string, results: object[]}} params.baseOutcome - runGateSequence at the job's base commit.
 * @param {boolean} params.evidenceOk - landedCommit is git-verified evidence from THIS dispatch.
 * @param {boolean} params.ancestorOk - landedCommit is an ancestor of (or equal to) the pre-gate HEAD.
 * @param {boolean} params.cleanOk - tree clean before and after the gate.
 * @param {boolean} params.headStable - HEAD unmoved across the gate.
 * @param {object} [params.env] - defaults to process.env.
 * @returns {{complete: boolean, reason: string, preexisting: string[]}}
 */
function decideBaselineAuthority({ job, headOutcome, baseOutcome, evidenceOk, ancestorOk, cleanOk, headStable, env = process.env } = {}) {
  const no = (reason) => ({ complete: false, reason, preexisting: [] });
  if (env?.SM_BASELINE_GATE_AUTHORITY_DISABLE === '1') return no('kill-switch');
  if (!job || job.status !== 'needs_review' || job.verifierVerdict !== 'sentinel_fail') {
    return no('verdict-not-eligible');
  }
  if (typeof job.landedCommit !== 'string' || job.landedCommit.length === 0) return no('no-landed-commit');
  if (evidenceOk !== true) return no('commit-not-from-this-run');
  if (ancestorOk !== true) return no('commit-not-on-head');
  if (cleanOk !== true) return no('tree-dirty');
  if (headStable !== true) return no('head-moved-during-gate');
  if (headOutcome?.status !== 'red') return no('head-not-red');
  if (baseOutcome?.status === 'green') return no('base-green');
  if (baseOutcome?.status !== 'red') return no('base-unavailable');
  const head = failingStep(headOutcome);
  const base = failingStep(baseOutcome);
  if (!head || !base || head.index !== base.index) return no('different-failing-step');
  const headIds = parseFailingTests(head.output);
  const baseIds = parseFailingTests(base.output);
  if (!headIds || !baseIds) return no('unparseable-output');
  const baseSet = new Set(baseIds);
  if (headIds.some((id) => !baseSet.has(id))) return no('new-failures');
  return { complete: true, reason: 'baseline-identical', preexisting: headIds };
}

module.exports = { parseFailingTests, decideBaselineAuthority };
