'use strict';

/**
 * epicSettle.cjs — pure settle evaluator for one Epic.
 *
 * Given the Epic's event chain and the scheduler queue rows, says whether the
 * Epic has settled (no running PRD, and no pending PRD other than ones held
 * on a preflight precondition or waiting only on such held rows) and which finished PRDs no
 * validator has checked yet. No fs; only the pure lib/scheduler/cancelledRow
 * predicate, never the scheduler itself.
 */

const { createHash } = require('node:crypto');
const { bareSlug } = require('../prd/depSlugResolve.cjs');
const { isCancelledRow } = require('../scheduler/cancelledRow.cjs');

const DEFAULT_SETTLE_HORIZON_MS = 24 * 60 * 60 * 1000;

const ts = (at) => {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

const isValidatorCheckin = (e, bare) =>
  e.agentType === 'validator' || (e.agentType == null && bare.startsWith('validate-'));

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
  // A pending row is held when its preflight parked it, or when every one of its
  // unfinished dependencies is itself held. Held rows run on their own later, so
  // they do not hold back the settle digest; the digest names them instead.
  const byBare = new Map();
  for (const r of epicRows) if (r && r.slug != null) byBare.set(bareSlug(String(r.slug)), r);
  const isFinished = (r) => r.status === 'completed' || r.status === 'skipped';
  const heldMemo = new Map(); // row -> reason string | null
  /** @returns {string|null} the held reason, or null when the row is not held */
  const heldReasonOf = (row, seen) => {
    if (!row || row.status !== 'pending') return null;
    if (heldMemo.has(row)) return heldMemo.get(row);
    if (row.preflightHold) {
      const reason = typeof row.heldReason === 'string' && row.heldReason ? row.heldReason : 'waiting on precondition';
      heldMemo.set(row, reason);
      return reason;
    }
    if (seen.has(row)) return null;
    seen.add(row);
    const deps = Array.isArray(row.dependsOn) ? row.dependsOn : [];
    let firstHeld = null;
    let result = null;
    let anyUnfinished = false;
    let allHeld = true;
    for (const d of deps) {
      const dep = byBare.get(bareSlug(String(d)));
      if (!dep || isFinished(dep)) continue;
      anyUnfinished = true;
      if (heldReasonOf(dep, seen) == null) { allHeld = false; break; }
      if (firstHeld == null) firstHeld = String(dep.slug);
    }
    if (anyUnfinished && allHeld) result = `waiting on ${firstHeld}`;
    seen.delete(row);
    heldMemo.set(row, result);
    return result;
  };
  const held = epicRows
    .filter((r) => r.status === 'pending')
    .map((r) => ({ slug: String(r.slug), reason: heldReasonOf(r, new Set()) }))
    .filter((h) => h.reason != null)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const heldSet = new Set(held.map((h) => h.slug));
  const settled = !epicRows.some(
    (r) => r.status === 'running' || (r.status === 'pending' && !heldSet.has(String(r.slug))),
  );
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
    .update(JSON.stringify({ verified, refuted, failed, parked, cancelled, uncovered: uncovered.map((u) => u.slug), held: held.map((h) => h.slug) }))
    .digest('hex')
    .slice(0, 16);
  const hasContent = [uncovered, verified, refuted, failed, parked, cancelled].some((l) => l.length > 0);

  return { settled, held, uncovered, verified, refuted, failed, parked, cancelled, digestKey, hasContent };
}

module.exports = { evaluateEpicSettle, DEFAULT_SETTLE_HORIZON_MS };
