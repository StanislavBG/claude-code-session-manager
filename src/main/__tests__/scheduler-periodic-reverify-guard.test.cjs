/**
 * scheduler-periodic-reverify-guard.test.cjs
 *
 * The 10-minute periodic tick cheap-guards reverifyNeedsReview() so the log
 * scan only runs when the queue actually holds something rescannable. That
 * guard was hand-written as `jobs.some(j => j.status === 'needs_review')`
 * while PRD 1102 widened isRescanCandidate to also accept an unverified-
 * shaped `failed` row — so reverifyNeedsReview's failed → needs_review
 * looksDone branch was unreachable from the periodic path on any queue with
 * zero needs_review rows. A failed row with no run log stayed wedged for five
 * days (reported 2026-09-10 from social-signals-trader); only an app restart,
 * via the unguarded boot call, could reach it.
 *
 * These tests pin the guard to isRescanCandidate so the two cannot drift again.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — see
 * scheduler-reap-dead-running-jobs.test.cjs's comment for why.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-periodic-reverify-guard.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reverify-guard-test-'));
process.env.HOME = tmpHome;

const { shouldRunPeriodicReverify, isRescanCandidate } = require('../scheduler.cjs');

function writeRunLog(runId, slug, lines) {
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${slug}.log`), lines.join('\n') + '\n');
}

test('a lone unverified-shaped failed row (no needs_review sibling) fires the periodic pass', () => {
  writeRunLog('run-guard-1', '4056-outcome-stats', ['[scheduler] starting 4056-outcome-stats']); // no result event
  const jobs = [
    { slug: '4059-chores-status', status: 'running', runId: 'run-guard-running' },
    {
      slug: '4056-outcome-stats',
      status: 'failed',
      runId: 'run-guard-1',
      error: 'reaped: no runtime.pid recorded after 10m — spawn never completed (outcome=no_result)',
    },
  ];
  assert.equal(isRescanCandidate(jobs[1]), true, 'fixture must be a genuine rescan candidate');
  assert.equal(shouldRunPeriodicReverify(jobs), true);
});

test('a failed row with a real result event (genuine red gate) does NOT fire the pass', () => {
  writeRunLog('run-guard-2', '200-red', [
    '[scheduler] starting 200-red',
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true }),
  ]);
  const jobs = [{ slug: '200-red', status: 'failed', runId: 'run-guard-2' }];
  assert.equal(isRescanCandidate(jobs[0]), false);
  assert.equal(shouldRunPeriodicReverify(jobs), false);
});

test('needs_review with a rescannable verdict still fires; a non-rescannable verdict does not', () => {
  writeRunLog('run-guard-3', '300-nr', ['[scheduler] starting 300-nr']);
  assert.equal(
    shouldRunPeriodicReverify([
      { slug: '300-nr', status: 'needs_review', runId: 'run-guard-3', verifierVerdict: 'verify_unavailable' },
    ]),
    true,
  );
  assert.equal(
    shouldRunPeriodicReverify([
      { slug: '300-nr', status: 'needs_review', runId: 'run-guard-3', verifierVerdict: 'uncommitted_changes' },
    ]),
    false,
  );
});

test('a queue with nothing rescannable, or a non-array, does not fire the pass', () => {
  assert.equal(shouldRunPeriodicReverify([{ slug: 'a', status: 'pending' }, { slug: 'b', status: 'completed' }]), false);
  assert.equal(shouldRunPeriodicReverify([]), false);
  assert.equal(shouldRunPeriodicReverify(undefined), false);
});
