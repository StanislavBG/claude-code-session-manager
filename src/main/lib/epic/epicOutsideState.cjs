'use strict';

/**
 * epicOutsideState.cjs — pure "what state is this Epic in?" for outside apps.
 *
 * An Epic's own `status` stays `active` until a human closes it, so it cannot
 * say when the work is verified. This turns the session row, the Epic's event
 * chain and the scheduler queue rows into one state with a reason.
 *
 * Unlike epicSettle (windowed) this reads the whole event chain and keys
 * verdicts by bare slug with the newest winning, so a refuted PRD stops
 * blocking once a validator later verifies the same PRD. Unlike the renderer's
 * epicDisplayStatus it is not a display rule. No fs, no clock, no mutation.
 */

const { bareSlug } = require('../prd/depSlugResolve.cjs');
const { isCancelledRow } = require('./epicSettle.cjs');

const EPIC_OUTSIDE_STATES = Object.freeze([
  'closed',
  'awaiting_approval',
  'needs_input',
  'blocked',
  'working',
  'in_review',
  'verified',
  'open',
]);

const REASON_MAX = 300;

const ts = (at) => {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

const cut = (s) => (typeof s === 'string' ? s.slice(0, REASON_MAX) : '');

const isObj = (v) => v != null && typeof v === 'object';

const isValidatorSlug = (bare) => bare.startsWith('validate-');

const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

function refutedReason(text) {
  const s = typeof text === 'string' ? text : '';
  const i = s.indexOf(' — ');
  return i >= 0 ? s.slice(i + 3).trim() : '';
}

function reviewReason(row) {
  const n = isObj(row.reviewNotice) ? row.reviewNotice : null;
  if (!n) return '';
  if (typeof n.reason === 'string' && n.reason) return n.reason;
  return typeof n.summary === 'string' ? n.summary : '';
}

/**
 * @param {{ session?: any, events?: any[], jobs?: any[], needsInput?: boolean, chatBusy?: boolean }} [args]
 * @returns {{
 *   state: string,
 *   blocked: null | { kind: 'refuted'|'failed'|'needs_review'|'quarantined', prds: { slug: string, reason: string }[] },
 *   prds: { total: number, pending: number, running: number, completed: number, failed: number, needsReview: number, quarantined: number, skipped: number },
 *   verified: string[],
 *   refuted: { slug: string, reason: string }[],
 *   unvalidated: string[],
 * }}
 */
function computeEpicOutsideState(args) {
  const a = isObj(args) ? args : {};
  const session = isObj(a.session) ? a.session : {};
  const sessionId = typeof session.id === 'string' && session.id ? session.id : null;
  const events = Array.isArray(a.events) ? a.events.filter(isObj) : [];
  const allRows = Array.isArray(a.jobs) ? a.jobs.filter(isObj) : [];
  const needsInput = a.needsInput === true;
  const chatBusy = a.chatBusy === true;

  const rows = sessionId
    ? allRows.filter((r) => r.epicId === sessionId || r.sourcePromptId === sessionId)
    : [];

  const prds = { total: 0, pending: 0, running: 0, completed: 0, failed: 0, needsReview: 0, quarantined: 0, skipped: 0 };
  for (const r of rows) {
    prds.total++;
    switch (r.status) {
      case 'pending': prds.pending++; break;
      case 'running':
      case 'investigating': prds.running++; break;
      case 'completed': prds.completed++; break;
      case 'failed': prds.failed++; break;
      case 'needs_review': prds.needsReview++; break;
      case 'quarantined': prds.quarantined++; break;
      case 'skipped': prds.skipped++; break;
      default: break;
    }
  }

  // Newest verdict per bare slug over the whole chain (later array entry wins a tie).
  const verdicts = new Map(); // bare -> { event, t }
  for (const e of events) {
    if (e.kind !== 'response' || typeof e.prdSlug !== 'string') continue;
    if (e.validation !== 'verified' && e.validation !== 'refuted') continue;
    const bare = bareSlug(e.prdSlug);
    const t = ts(e.at);
    const prev = verdicts.get(bare);
    // A dated verdict beats an undated one; among equals the later entry wins.
    const newer = !prev || (Number.isNaN(t) ? Number.isNaN(prev.t) : Number.isNaN(prev.t) || t >= prev.t);
    if (newer) verdicts.set(bare, { event: e, t });
  }

  const verified = [];
  const refuted = [];
  for (const [bare, { event }] of verdicts) {
    if (event.validation === 'verified') verified.push(bare);
    else refuted.push({ slug: bare, reason: cut(refutedReason(event.text)) });
  }
  verified.sort();
  refuted.sort(bySlug);

  const unvalidatedSet = new Set();
  let completedWork = 0;
  for (const r of rows) {
    if (r.status !== 'completed') continue;
    const bare = bareSlug(r.slug);
    if (isValidatorSlug(bare)) continue;
    completedWork++;
    const v = verdicts.get(bare);
    if (!v) { unvalidatedSet.add(bare); continue; }
    const finished = ts(r.finishedAt);
    if (Number.isFinite(finished) && (!Number.isFinite(v.t) || v.t < finished)) unvalidatedSet.add(bare);
  }
  const unvalidated = [...unvalidatedSet].sort();

  const rowPrds = (status, reasonOf) => rows
    .filter((r) => r.status === status && !isCancelledRow(r))
    .map((r) => ({ slug: bareSlug(r.slug), reason: cut(reasonOf(r)) }))
    .sort(bySlug);

  const result = (state, blocked = null) => ({ state, blocked, prds, verified, refuted, unvalidated });

  if (session.status === 'completed') return result('closed');
  if (session.status === 'proposed') return result('awaiting_approval');
  if (needsInput && !chatBusy) return result('needs_input');

  if (refuted.length > 0) return result('blocked', { kind: 'refuted', prds: refuted.map((p) => ({ ...p })) });
  const failed = rowPrds('failed', (r) => (typeof r.error === 'string' ? r.error : ''));
  if (failed.length > 0) return result('blocked', { kind: 'failed', prds: failed });
  const parked = rowPrds('needs_review', reviewReason);
  if (parked.length > 0) return result('blocked', { kind: 'needs_review', prds: parked });
  const quarantined = rows
    .filter((r) => r.status === 'quarantined')
    .map((r) => ({ slug: bareSlug(r.slug), reason: cut(reviewReason(r) || (typeof r.error === 'string' ? r.error : '')) }))
    .sort(bySlug);
  if (quarantined.length > 0) return result('blocked', { kind: 'quarantined', prds: quarantined });

  if (chatBusy || rows.some((r) => r.status === 'pending' || r.status === 'running' || r.status === 'investigating')) {
    return result('working');
  }
  if (completedWork > 0 && unvalidated.length === 0) return result('verified');
  if (unvalidated.length > 0) return result('in_review');
  return result('open');
}

module.exports = { computeEpicOutsideState, EPIC_OUTSIDE_STATES };
