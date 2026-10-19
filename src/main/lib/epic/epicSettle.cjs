'use strict';

/**
 * epicSettle.cjs — pure settle evaluator for one Epic.
 *
 * Given the Epic's event chain and the scheduler queue rows, says whether the
 * Epic has settled (no pending/running PRD) and which finished PRDs no
 * validator has checked yet. No fs, no scheduler require.
 */

const { createHash } = require('node:crypto');
const { bareSlug } = require('../prd/depSlugResolve.cjs');

const DEFAULT_SETTLE_HORIZON_MS = 24 * 60 * 60 * 1000;

const ts = (at) => {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

const isValidatorCheckin = (e, bare) =>
  e.agentType === 'validator' || (e.agentType == null && bare.startsWith('validate-'));

// Mirrors the scheduler's cancel rule locally (lib/epic stays free of scheduler deps).
const isCancelledRow = (r) => {
  if (!r || (r.status !== 'failed' && r.status !== 'needs_review')) return false;
  if (typeof r.cancelledAt === 'string' && r.cancelledAt) return true;
  const hist = Array.isArray(r.statusHistory) ? r.statusHistory : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i] && hist[i].to === r.status) return hist[i].source === 'remote:cancelJob';
  }
  return false;
};

/**
 * @param {{ epicId: string, cwd?: string|null, events?: any[], jobs?: any[], now?: number, horizonMs?: number }} args
 */
function evaluateEpicSettle({ epicId, cwd, events, jobs, now, horizonMs } = {}) {
  const evs = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const rows = Array.isArray(jobs) ? jobs : [];
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const horizon = Number.isFinite(horizonMs) ? horizonMs : DEFAULT_SETTLE_HORIZON_MS;

  const epicRows = rows.filter(
    (r) => r && (r.epicId === epicId || r.sourcePromptId === epicId) && (r.cwd == null || cwd == null || r.cwd === cwd),
  );
  const settled = !epicRows.some((r) => r.status === 'pending' || r.status === 'running');
  const cancelled = epicRows
    .filter(isCancelledRow)
    .map((r) => String(r.slug))
    .sort();
  const cancelledSet = new Set(cancelled.flatMap((s) => [s, bareSlug(s)]));
  const parked = epicRows
    .filter((r) => r.status === 'needs_review' && !isCancelledRow(r))
    .map((r) => String(r.slug))
    .sort();

  let windowStart = nowMs - horizon;
  for (const e of evs) {
    if (e.outcome === 'digest') {
      const t = ts(e.at);
      if (t > windowStart) windowStart = t;
    }
  }

  const checkins = new Map(); // bare -> { event, t }
  const verdicts = new Map();
  for (const e of evs) {
    if (e.kind !== 'response' || typeof e.prdSlug !== 'string') continue;
    const t = ts(e.at);
    if (!(t > windowStart)) continue;
    const bare = bareSlug(e.prdSlug);
    let target = null;
    if (e.validation === 'unvalidated' && (e.outcome === 'completed' || e.outcome === 'failed')) {
      if (isValidatorCheckin(e, bare)) continue;
      target = checkins;
    } else if (e.validation === 'verified' || e.validation === 'refuted') {
      target = verdicts;
    }
    if (!target) continue;
    const prev = target.get(bare);
    if (!prev || t >= prev.t) target.set(bare, { event: e, t });
  }

  const verified = [];
  const refuted = [];
  for (const [bare, { event }] of verdicts) {
    if (event.validation === 'verified') verified.push(bare);
    else {
      const text = typeof event.text === 'string' ? event.text : '';
      const i = text.indexOf(' — ');
      refuted.push({ slug: bare, reason: i >= 0 ? text.slice(i + 3).trim() : '' });
    }
  }
  verified.sort();
  refuted.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const uncovered = [];
  const failed = [];
  for (const [bare, { event, t }] of checkins) {
    if (event.outcome === 'failed') {
      if (!cancelledSet.has(event.prdSlug) && !cancelledSet.has(bare)) failed.push(event.prdSlug);
      continue;
    }
    const v = verdicts.get(bare);
    if (v && v.t >= t) continue;
    uncovered.push({ slug: event.prdSlug, bareSlug: bare });
  }
  uncovered.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  failed.sort();

  const digestKey = createHash('sha1')
    .update(JSON.stringify({ verified, refuted, failed, parked, cancelled, uncovered: uncovered.map((u) => u.slug) }))
    .digest('hex')
    .slice(0, 16);
  const hasContent = [uncovered, verified, refuted, failed, parked, cancelled].some((l) => l.length > 0);

  return { settled, uncovered, verified, refuted, failed, parked, cancelled, digestKey, hasContent };
}

module.exports = { evaluateEpicSettle, DEFAULT_SETTLE_HORIZON_MS };
