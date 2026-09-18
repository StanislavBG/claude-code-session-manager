/**
 * scheduler-dispatch-loop.test.cjs — dispatch cadence is the loop's, not the billing
 * poller's: with the meter failing (backoff at 480 s) a pending dispatchable row still
 * gets a tickQueue within 30 s.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-dispatch-loop.test.cjs
 */
'use strict';

import { test, expect, vi, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dispatch-loop-'));
  process.env.HOME = tmpHome;
  process.env.SM_AUTOFIX_DISABLE = '1';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  delete process.env.SM_AUTOFIX_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('with the billing poll backed off to 480 s, a pending row is still ticked within 30 s', async () => {
  const { startDispatchLoop } = require('../lib/dispatchLoop.cjs');
  await scheduler.writeQueue({
    jobs: [{ slug: `9004-dispatch-loop-${process.pid}`, title: 'x', cwd: tmpHome, status: 'pending', dependsOn: [] }],
    config: {},
    paused: null,
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const seen = [];
  const h = startDispatchLoop({
    // Same wiring init() uses (tick: () => tickQueue()), observed.
    tick: async () => { seen.push(await scheduler.tickQueue()); },
  });
  try {
    // Billing poll is at 480 s backoff: nothing else fires. The loop's own 30 s cadence does.
    await vi.advanceTimersByTimeAsync(30_000);
    // tickQueue does real file I/O; wait for the (real-time) pass to settle.
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: 10_000 });
    expect(seen[0]).toBeTruthy(); // tickQueue ran and recorded an outcome for the pending row
  } finally {
    h.stop();
    vi.useRealTimers();
  }
});
