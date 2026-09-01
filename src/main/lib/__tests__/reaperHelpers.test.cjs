/**
 * reaperHelpers.test.cjs — selectReapableJobs: the pure predicate behind
 * reapDeadRunningJobs()'s pidless-zombie fix.
 *
 * Prior behaviour: a 'running' row with no runtime.pid was skipped forever,
 * unconditionally ("spawn may be mid-flight; give it a cycle") — no age
 * bound. Repro 2026-09-01: a row sat pidless for 464 minutes against a
 * 24-minute estimate, empty run dir, no claude process anywhere — nothing
 * pid-bound (deadman, idle watchdog, supervisor) could ever see it.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/reaperHelpers.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (CLAUDE.md).
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { selectReapableJobs } = require('../reaperHelpers.cjs');

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60_000).toISOString();
const GRACE = 10 * 60_000;
const alwaysDead = () => false;
const alwaysAlive = () => true;

test('pidless + older than grace → reaped, with a named reason', () => {
  const jobs = [{ slug: 'zombie', status: 'running', startedAt: agoMin(464) }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(reapable.length, 1);
  assert.strictEqual(reapable[0].slug, 'zombie');
  assert.strictEqual(reapable[0].pid, null);
  assert.strictEqual(reapable[0].pidless, true);
  assert.match(reapable[0].reason, /no runtime\.pid recorded after 10m/);
});

test('pidless + within grace → skipped (the genuine mid-flight-spawn case)', () => {
  const jobs = [{ slug: 'fresh', status: 'running', startedAt: agoMin(2) }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.deepStrictEqual(warnings, []);
});

test('pidless + exactly at grace boundary → reaped (>= not >)', () => {
  const jobs = [{ slug: 'boundary', status: 'running', startedAt: agoMin(10) }];
  const { reapable } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.strictEqual(reapable.length, 1);
});

test('live pid → skipped regardless of age', () => {
  const jobs = [{ slug: 'live', status: 'running', runtime: { pid: 4242 }, startedAt: agoMin(500) }];
  const { reapable } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
});

test('dead pid → reaped exactly as before (pidless: false, no reason string)', () => {
  const jobs = [{ slug: 'dead', status: 'running', runtime: { pid: 4242 }, startedAt: agoMin(500) }];
  const { reapable } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysDead, grace: GRACE });
  assert.strictEqual(reapable.length, 1);
  assert.strictEqual(reapable[0].slug, 'dead');
  assert.strictEqual(reapable[0].pid, 4242);
  assert.strictEqual(reapable[0].pidless, false);
});

test('pidless + missing startedAt → skipped and warned, not reaped', () => {
  const jobs = [{ slug: 'no-started-at', status: 'running' }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].slug, 'no-started-at');
});

test('pidless + unparseable startedAt → skipped and warned, not reaped', () => {
  const jobs = [{ slug: 'bad-started-at', status: 'running', startedAt: 'not-a-date' }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].slug, 'bad-started-at');
});

test('pidless + startedAt in the future (clock skew) → skipped, not reaped', () => {
  const jobs = [{ slug: 'future', status: 'running', startedAt: agoMin(-60) }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.deepStrictEqual(warnings, []);
});

test('non-running rows are never considered, pidless or not', () => {
  const jobs = [
    { slug: 'a', status: 'pending', startedAt: agoMin(500) },
    { slug: 'b', status: 'completed', startedAt: agoMin(500) },
    { slug: 'c', status: 'failed', runtime: { pid: 1 }, startedAt: agoMin(500) },
  ];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysDead, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.deepStrictEqual(warnings, []);
});

test('mixed batch: each row classified independently', () => {
  const jobs = [
    { slug: 'zombie', status: 'running', startedAt: agoMin(464) },
    { slug: 'fresh', status: 'running', startedAt: agoMin(2) },
    { slug: 'live', status: 'running', runtime: { pid: 1 }, startedAt: agoMin(500) },
    { slug: 'dead', status: 'running', runtime: { pid: 2 }, startedAt: agoMin(500) },
    { slug: 'bad-started-at', status: 'running', startedAt: 'nope' },
  ];
  const pidAlive = (pid) => pid === 1;
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive, grace: GRACE });
  assert.deepStrictEqual(reapable.map((r) => r.slug).sort(), ['dead', 'zombie']);
  assert.deepStrictEqual(warnings.map((w) => w.slug), ['bad-started-at']);
});
