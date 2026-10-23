/**
 * loopEfficiencyHandlers.test.cjs — gatherLoopEfficiency over a temp runs dir.
 * Run: timeout 300 npx vitest run src/main/__tests__/loopEfficiencyHandlers.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let root;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function addRun(runId, slug, cwd, { cost = 1, verdict, log } = {}) {
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.meta.json`), JSON.stringify({ slug, cwd, totalCostUsd: cost }));
  if (verdict) fs.writeFileSync(path.join(dir, `${slug}.verdicts.json`), JSON.stringify({ verdict }));
  if (log) fs.writeFileSync(path.join(dir, `${slug}.log`), log);
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'loopeff-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('aggregates runs, wasted runs and validator verdicts; skips out-of-window runs', async () => {
  const { gatherLoopEfficiency } = require('../loopEfficiencyHandlers.cjs');
  addRun('2026-10-22T01-00-00-000Z', 'a-one', '/p/alpha', { cost: 2, verdict: 'clean' });
  addRun('2026-10-22T02-00-00-000Z', 'b-two', '/p/beta', { cost: 1, verdict: 'deps_unmet' });
  const resultLine = JSON.stringify({ type: 'result', result: 'done\nVALIDATION: one VERIFIED\n' });
  addRun('2026-10-22T03-00-00-000Z', 'plan-validate-x', '/p/alpha', {
    cost: 0.5, verdict: 'clean', log: `noise\n${resultLine}\n`,
  });
  addRun('2026-09-01T00-00-00-000Z', 'old-run', '/p/alpha', { cost: 99, verdict: 'clean' });

  const usage = { seven_day: { utilization: 40, resets_at: new Date(NOW + 2 * 86400000).toISOString() } };
  const r = await gatherLoopEfficiency({ runsRoot: root, nowMs: NOW, usage });

  expect(r.weeklyUtilizationPct).toBe(40);
  expect(r.fromMs).toBe(NOW + 2 * 86400000 - 7 * 86400000);
  expect(r.totals.runs).toBe(3);
  expect(r.totals.wastedRuns).toBe(1);
  expect(r.totals.verified).toBe(1);
  const alpha = r.rows.find((x) => x.project === 'alpha');
  expect(alpha.runs).toBe(2);
  expect(alpha.executorUsd).toBeCloseTo(2.5);
  expect(alpha.verified).toBe(1);
  expect(r.rows.find((x) => x.project === 'beta').wastedRuns).toBe(1);
  expect(r.verifiedPerUsagePct).toBeCloseTo(1 / 40);
});

test('defaultUsage returns usage for ok and ok-stale, null otherwise', async () => {
  const { defaultUsage } = require('../loopEfficiencyHandlers.cjs');
  const usage = { seven_day: { utilization: 12, resets_at: '2026-10-25T00:00:00.000Z' } };
  expect(await defaultUsage(async () => ({ kind: 'ok', data: { usage } }))).toBe(usage);
  expect(await defaultUsage(async () => ({
    kind: 'ok-stale', data: { usage }, staleSince: 1, lastError: 'HTTP 429',
  }))).toBe(usage);
  expect(await defaultUsage(async () => ({ kind: 'error', message: 'boom' }))).toBeNull();
  expect(await defaultUsage(async () => ({ kind: 'ok-stale', data: {} }))).toBeNull();
});

test('falls back to a rolling 7d window with null pct when usage is missing', async () => {
  const { gatherLoopEfficiency } = require('../loopEfficiencyHandlers.cjs');
  const r = await gatherLoopEfficiency({ runsRoot: root, nowMs: NOW, usage: null });
  expect(r.fromMs).toBe(NOW - 7 * 86400000);
  expect(r.weeklyUtilizationPct).toBeNull();
  expect(r.rows).toEqual([]);
});
