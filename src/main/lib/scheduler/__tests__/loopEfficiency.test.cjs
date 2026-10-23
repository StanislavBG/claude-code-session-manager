// loopEfficiency — pure calculator: validated PRDs per unit of usage, per project.
import { test, expect } from 'vitest';
const { computeLoopEfficiency } = require('../loopEfficiency.cjs');

const W = { fromMs: 1000, toMs: 2000 };
const run = (o) => ({ cwd: '/p/a', slug: 's', startedAtMs: 1500, costUsd: 1, verdict: 'clean', ...o });
const val = (o) => ({ cwd: '/p/a', slug: 's', verdict: 'VERIFIED', atMs: 1500, ...o });

test('empty input yields empty rows and null ratios', () => {
  const r = computeLoopEfficiency({ runs: [], validations: [], ...W, weeklyUtilizationPct: null });
  expect(r.rows).toEqual([]);
  expect(r.totals).toMatchObject({ runs: 0, wastedRuns: 0, verified: 0, refuted: 0, executorUsd: 0, wastedRunRate: 0 });
  expect(r.verifiedPerUsagePct).toBeNull();
  expect(r.fromMs).toBe(1000);
  expect(r.toMs).toBe(2000);
  expect(computeLoopEfficiency({ ...W }).rows).toEqual([]);
});

test('window bounds: from inclusive, to exclusive', () => {
  const r = computeLoopEfficiency({
    runs: [run({ startedAtMs: 999 }), run({ startedAtMs: 1000 }), run({ startedAtMs: 1999 }), run({ startedAtMs: 2000 })],
    validations: [val({ atMs: 999 }), val({ atMs: 2000 })],
    ...W,
  });
  expect(r.rows[0].runs).toBe(2);
  expect(r.rows[0].verified).toBe(0);
});

test('waste vs completed-equivalent verdicts; missing/NaN cost is 0', () => {
  const r = computeLoopEfficiency({
    runs: [
      run({ verdict: null }),
      run({ verdict: 'clean' }),
      run({ verdict: 'pass_no_commit_already_shipped' }),
      run({ verdict: 'halt', costUsd: NaN }),
      run({ verdict: 'refire_capped', costUsd: undefined }),
    ],
    validations: [],
    ...W,
  });
  expect(r.rows[0].runs).toBe(5);
  expect(r.rows[0].wastedRuns).toBe(2);
  expect(r.rows[0].executorUsd).toBe(3);
  expect(r.totals.wastedRunRate).toBeCloseTo(0.4);
});

test('NN-prefix dedupe with last-verdict-wins', () => {
  const r = computeLoopEfficiency({
    runs: [],
    validations: [
      val({ slug: '12-foo', verdict: 'REFUTED', atMs: 1100 }),
      val({ slug: 'foo', verdict: 'VERIFIED', atMs: 1200 }),
      val({ slug: 'bar', verdict: 'VERIFIED', atMs: 1300 }),
      val({ slug: '07-bar', verdict: 'REFUTED', atMs: 1400 }),
    ],
    ...W,
  });
  expect(r.rows[0]).toMatchObject({ verified: 1, refuted: 1 });
});

test('null usdPerVerified, null pct, and pct ratio', () => {
  const none = computeLoopEfficiency({ runs: [run()], validations: [], ...W, weeklyUtilizationPct: 10 });
  expect(none.rows[0].usdPerVerified).toBeNull();
  expect(none.verifiedPerUsagePct).toBe(0);
  const inputs = { runs: [run({ costUsd: 4 })], validations: [val()], ...W };
  const ok = computeLoopEfficiency({ ...inputs, weeklyUtilizationPct: 50 });
  expect(ok.rows[0].usdPerVerified).toBe(4);
  expect(ok.verifiedPerUsagePct).toBe(1 / 50);
  for (const bad of [0, -1, NaN, null, undefined, Infinity]) {
    expect(computeLoopEfficiency({ ...inputs, weeklyUtilizationPct: bad }).verifiedPerUsagePct).toBeNull();
  }
});

test('sort: executorUsd desc then project asc; project is basename', () => {
  const r = computeLoopEfficiency({
    runs: [
      run({ cwd: '/x/zeta', costUsd: 1 }),
      run({ cwd: '/x/alpha', costUsd: 1 }),
      run({ cwd: '/x/big', costUsd: 5 }),
    ],
    validations: [],
    ...W,
  });
  expect(r.rows.map((x) => x.project)).toEqual(['big', 'alpha', 'zeta']);
});

test('does not mutate inputs', () => {
  const runs = [run()];
  const validations = [val()];
  const snap = JSON.stringify({ runs, validations });
  computeLoopEfficiency({ runs, validations, ...W });
  expect(JSON.stringify({ runs, validations })).toBe(snap);
});
