/**
 * loopEfficiency.cjs — pure calculator for the scheduler's real throughput
 * metric: validated PRDs per unit of usage, per project.
 *
 * Why: the scheduler is bound by the account's usage window, not by slots, so
 * "verified PRDs per usage %" (and $ per verified PRD) is what matters. Also
 * makes the "wasted runs <= 5%" target in scheduler-operations.md computable.
 *
 * Pure: no I/O, no Date.now(), no mutation of inputs.
 * Complexity O(R + V + P log P): one pass over runs, one over validations,
 * then a sort of the P project rows.
 */

'use strict';

const path = require('path');
const { COMPLETED_EQUIVALENT_VERDICTS } = require('./terminalRunOutcome.cjs');

/** @param {unknown} t @param {number} fromMs @param {number} toMs */
function inWindow(t, fromMs, toMs) {
  return typeof t === 'number' && Number.isFinite(t) && t >= fromMs && t < toMs;
}

/** @param {unknown} slug */
function normSlug(slug) {
  return String(slug == null ? '' : slug).replace(/^\d+-/, '');
}

/**
 * @param {{
 *   runs?: Array<{ cwd: string, slug: string, startedAtMs: number, costUsd?: number, verdict: string | null }>,
 *   validations?: Array<{ cwd: string, slug: string, verdict: 'VERIFIED' | 'REFUTED', atMs: number }>,
 *   fromMs: number,
 *   toMs: number,
 *   weeklyUtilizationPct?: number | null,
 * }} input
 */
function computeLoopEfficiency({ runs, validations, fromMs, toMs, weeklyUtilizationPct }) {
  /** @type {Map<string, { cwd: string, runs: number, wastedRuns: number, executorUsd: number, last: Map<string, { atMs: number, verdict: string }> }>} */
  const byCwd = new Map();
  const bucket = (/** @type {string} */ cwd) => {
    let b = byCwd.get(cwd);
    if (!b) {
      b = { cwd, runs: 0, wastedRuns: 0, executorUsd: 0, last: new Map() };
      byCwd.set(cwd, b);
    }
    return b;
  };

  for (const r of runs || []) {
    if (!r || !inWindow(r.startedAtMs, fromMs, toMs)) continue;
    const b = bucket(String(r.cwd));
    b.runs += 1;
    const v = r.verdict;
    if (v != null && v !== 'clean' && !COMPLETED_EQUIVALENT_VERDICTS.has(v)) b.wastedRuns += 1;
    const cost = Number(r.costUsd);
    if (Number.isFinite(cost)) b.executorUsd += cost;
  }

  for (const v of validations || []) {
    if (!v || !inWindow(v.atMs, fromMs, toMs)) continue;
    const b = bucket(String(v.cwd));
    const key = normSlug(v.slug);
    const prev = b.last.get(key);
    if (!prev || v.atMs >= prev.atMs) b.last.set(key, { atMs: v.atMs, verdict: v.verdict });
  }

  const rows = [];
  const totals = { runs: 0, wastedRuns: 0, verified: 0, refuted: 0, executorUsd: 0, wastedRunRate: 0 };
  for (const b of byCwd.values()) {
    let verified = 0;
    let refuted = 0;
    for (const { verdict } of b.last.values()) {
      if (verdict === 'VERIFIED') verified += 1;
      else if (verdict === 'REFUTED') refuted += 1;
    }
    rows.push({
      cwd: b.cwd,
      project: path.basename(b.cwd),
      runs: b.runs,
      wastedRuns: b.wastedRuns,
      verified,
      refuted,
      executorUsd: b.executorUsd,
      usdPerVerified: verified > 0 ? b.executorUsd / verified : null,
    });
    totals.runs += b.runs;
    totals.wastedRuns += b.wastedRuns;
    totals.verified += verified;
    totals.refuted += refuted;
    totals.executorUsd += b.executorUsd;
  }
  totals.wastedRunRate = totals.runs > 0 ? totals.wastedRuns / totals.runs : 0;

  rows.sort((a, b) => b.executorUsd - a.executorUsd || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));

  const pct = typeof weeklyUtilizationPct === 'number' ? weeklyUtilizationPct : NaN;
  const hasPct = Number.isFinite(pct) && pct > 0;
  return {
    fromMs,
    toMs,
    rows,
    totals,
    weeklyUtilizationPct: weeklyUtilizationPct == null ? null : weeklyUtilizationPct,
    verifiedPerUsagePct: hasPct ? totals.verified / pct : null,
  };
}

module.exports = { computeLoopEfficiency };
