'use strict';

import { test, beforeEach, afterAll, vi } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'job-leftover-sweep-test-'));
process.env.HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

const { runJobLeftoverSweep } = require('../scheduler.cjs');
const jobLeftovers = require('../lib/scheduler/jobLeftovers.cjs');

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const INTERVAL = 5 * 60_000;
let clock = 1_000_000_000_000;
const ENDED = { slug: 'old-job', status: 'completed', finishedAt: new Date(clock - 3_600_000).toISOString() };
const PROC = { pid: 4242, ppid: 1, tty: 0, slug: 'old-job', argv: ['node', 'x'], comm: 'node', etimes: 900 };
const goodScan = () => ({ procs: [PROC], parentOf: new Map([[4242, 1]]) });

function mkDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      now: clock,
      platform: 'linux',
      scan: () => { calls.push('scan'); return goodScan(); },
      readState: async () => { calls.push('read'); return { jobs: [{ ...ENDED, finishedAt: new Date(clock - 3_600_000).toISOString() }], unreadableCwds: [] }; },
      stop: (procs) => { calls.push('stop'); return procs.map((p) => p.pid); },
      ...over,
    },
  };
}

beforeEach(() => {
  clock += INTERVAL * 10; // clear the throttle between tests
  delete process.env.SM_E2E;
});

test('scans /proc before reading the queue, then stops leftovers', async () => {
  const { deps, calls } = mkDeps({ now: clock });
  const out = await runJobLeftoverSweep(deps);
  assert.deepEqual(calls, ['scan', 'read', 'stop']);
  assert.equal(out.length, 1);
});

test('throttled to once per 5 minutes', async () => {
  const a = mkDeps({ now: clock });
  await runJobLeftoverSweep(a.deps);
  const b = mkDeps({ now: clock + INTERVAL - 1 });
  await runJobLeftoverSweep(b.deps);
  assert.deepEqual(b.calls, []);
  const c = mkDeps({ now: clock + INTERVAL });
  await runJobLeftoverSweep(c.deps);
  assert.ok(c.calls.includes('scan'));
});

test('skips off linux without scanning', async () => {
  const { deps, calls } = mkDeps({ now: clock, platform: 'darwin' });
  await runJobLeftoverSweep(deps);
  assert.deepEqual(calls, []);
});

test('skips when SM_E2E=1', async () => {
  process.env.SM_E2E = '1';
  const { deps, calls } = mkDeps({ now: clock });
  await runJobLeftoverSweep(deps);
  assert.deepEqual(calls, []);
});

test('does nothing when state is unreadable', async () => {
  const { deps, calls } = mkDeps({ now: clock, readState: async () => null });
  await runJobLeftoverSweep(deps);
  assert.ok(!calls.includes('stop'));
});

test('does nothing when a shard is quarantined', async () => {
  const { deps, calls } = mkDeps({
    now: clock,
    readState: async () => ({ jobs: [{ ...ENDED }], unreadableCwds: [{ cwd: '/x' }] }),
  });
  await runJobLeftoverSweep(deps);
  assert.ok(!calls.includes('stop'));
});

test('does not stop processes of a still-running row', async () => {
  const { deps, calls } = mkDeps({
    now: clock,
    readState: async () => ({ jobs: [{ slug: 'old-job', status: 'running' }], unreadableCwds: [] }),
  });
  await runJobLeftoverSweep(deps);
  assert.ok(!calls.includes('stop'));
});

test('under vitest with no injected scan, never scans the real /proc', async () => {
  const spy = vi.spyOn(jobLeftovers, 'scanJobProcesses');
  try {
    const { deps } = mkDeps({ now: clock });
    delete deps.scan;
    const out = await runJobLeftoverSweep(deps);
    assert.deepEqual(out, []);
    assert.equal(spy.mock.calls.length, 0);
  } finally {
    spy.mockRestore();
  }
});

test('does nothing for the real unreadable-queue shape, even with a marked process and no row', async () => {
  const { deps, calls } = mkDeps({
    now: clock,
    readState: async () => ({ jobs: [], unreadable: 'x', unreadableCwds: [] }),
  });
  const out = await runJobLeftoverSweep(deps);
  assert.deepEqual(out, []);
  assert.ok(!calls.includes('stop'));
});
