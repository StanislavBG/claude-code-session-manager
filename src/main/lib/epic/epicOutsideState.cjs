'use strict';

/**
 * epicOutsideState.cjs — pure "what state is this Epic in?" for outside apps.
 *
 * An Epic's own `status` stays `active` until a human closes it, so it cannot
 * say when the work is verified. This turns the session row, the Epic's event
 * chain and the scheduler queue rows into one state with a reason. Finished
 * PRDs whose queue rows are gone are still known from their check-ins.
 *
 * Unlike epicSettle (windowed) this reads the whole event chain and keys
 * verdicts by bare slug with the newest winning, so a refuted PRD stops
 * blocking once a validator later verifies the same PRD. Unlike the renderer's
 * epicDisplayStatus it is not a display rule. No fs, no clock, no mutation.
 */

const { bareSlug } = require('../prd/depSlugResolve.cjs');
const { isCancelledRow } = require('./epicSettle.cjs');

// Mirrors epicSettle's (unexported) isValidatorCheckin.
const isValidatorCheckin = (e, bare) =>
  e.agentType === 'validator' || (e.agentType == null && bare.startsWith('validate-'));

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

// Is `t` (with its array index) newer than `prev`? A dated entry beats an
// undated one; among equals the later array entry wins.
const isNewer = (t, prev) => !prev || (Number.isNaN(t) ? Number.isNaN(prev.t) : Number.isNaN(prev.t) || t >= prev.t);

const isCheckin = (e) => e.kind === 'response' && typeof e.prdSlug === 'string' && e.prdSlug && e.validation === 'unvalidated';

/**
 * The PRDs an Epic is known to have: the union, by bare slug, of its live
 * queue rows and the job check-ins on its chain. The scheduler drops a row
 * soon after its job finishes; the check-in stays on the chain forever.
 *
 * @param {any} session
 * @param {any[]} events  already filtered to objects
 * @param {any[]} allRows already filtered to objects
 * @returns {Map<string, { bare: string, slug: string, row: any, checkin: null | { event: any, t: number }, completedCheckin: null | { event: any, t: number }, status: string, validator: boolean }>}
 */
function buildKnownPrds(session, events, allRows) {
  const sessionId = isObj(session) && typeof session.id === 'string' && session.id ? session.id : null;
  const rows = sessionId
    ? allRows.filter((r) => r.epicId === sessionId || r.sourcePromptId === sessionId)
    : [];
  /** @type {Map<string, any>} */
  const known = new Map();
  const entry = (bare) => {
    let k = known.get(bare);
    if (!k) {
      k = { bare, slug: '', row: null, checkin: null, completedCheckin: null, status: '', validator: false };
      known.set(bare, k);
    }
    return k;
  };
  for (const r of rows) {
    if (typeof r.slug !== 'string' || !r.slug) continue;
    const k = entry(bareSlug(r.slug));
    k.row = r; // a later row for the same PRD wins
  }
  for (const e of events) {
    if (!isCheckin(e)) continue;
    const k = entry(bareSlug(e.prdSlug));
    const t = ts(e.at);
    if (isNewer(t, k.checkin)) k.checkin = { event: e, t };
    if (e.outcome === 'completed' && isNewer(t, k.completedCheckin)) k.completedCheckin = { event: e, t };
  }
  for (const k of known.values()) {
    k.slug = k.row ? k.row.slug : k.checkin.event.prdSlug;
    k.status = k.row
      ? (typeof k.row.status === 'string' ? k.row.status : '')
      : (typeof k.checkin.event.outcome === 'string' ? k.checkin.event.outcome : '');
    const src = k.row || k.checkin.event;
    k.validator = k.row
      ? (k.row.agentType === 'validator' || isValidatorSlug(k.bare))
      : isValidatorCheckin(src, k.bare);
  }
  return known;
}

/**
 * Full slugs (as written in the row or the check-in) of the Epic's known
 * PRDs, sorted, no repeats.
 * @param {{ session?: any, events?: any[], jobs?: any[] }} [args]
 * @returns {string[]}
 */
function knownPrdSlugs(args) {
  const a = isObj(args) ? args : {};
  const events = Array.isArray(a.events) ? a.events.filter(isObj) : [];
  const allRows = Array.isArray(a.jobs) ? a.jobs.filter(isObj) : [];
  const known = buildKnownPrds(isObj(a.session) ? a.session : {}, events, allRows);
  return [...new Set([...known.values()].map((k) => k.slug))].sort();
}

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
  const events = Array.isArray(a.events) ? a.events.filter(isObj) : [];
  const allRows = Array.isArray(a.jobs) ? a.jobs.filter(isObj) : [];
  const needsInput = a.needsInput === true;
  const chatBusy = a.chatBusy === true;

  const known = [...buildKnownPrds(session, events, allRows).values()];

  const prds = { total: 0, pending: 0, running: 0, completed: 0, failed: 0, needsReview: 0, quarantined: 0, skipped: 0 };
  for (const k of known) {
    prds.total++;
    switch (k.status) {
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
    if (isNewer(t, verdicts.get(bare))) verdicts.set(bare, { event: e, t });
  }

  const verified = [];
  const refuted = [];
  for (const [bare, { event }] of verdicts) {
    if (event.validation === 'verified') verified.push(bare);
    else refuted.push({ slug: bare, reason: cut(typeof event.reason === 'string' ? event.reason : refutedReason(event.text)) });
  }
  verified.sort();
  refuted.sort(bySlug);

  // A completed work PRD is unvalidated unless a verdict lands at or after its
  // newest completed check-in (or after the row's finishedAt when it has none).
  const unvalidatedSet = new Set();
  let completedWork = 0;
  for (const k of known) {
    if (k.status !== 'completed' || k.validator) continue;
    completedWork++;
    const v = verdicts.get(k.bare);
    if (!v) { unvalidatedSet.add(k.bare); continue; }
    const finished = k.completedCheckin ? k.completedCheckin.t : ts(k.row ? k.row.finishedAt : undefined);
    if (Number.isFinite(finished) && (!Number.isFinite(v.t) || v.t < finished)) unvalidatedSet.add(k.bare);
  }
  const unvalidated = [...unvalidatedSet].sort();

  const checkinText = (k) => (k.checkin && typeof k.checkin.event.text === 'string' ? k.checkin.event.text : '');
  const errorOf = (k) => (k.row ? (typeof k.row.error === 'string' ? k.row.error : '') : checkinText(k));
  const reviewOf = (k) => (k.row ? reviewReason(k.row) : checkinText(k));
  const knownPrds = (status, reasonOf, skipCancelled = true) => known
    .filter((k) => k.status === status && !(skipCancelled && k.row && isCancelledRow(k.row)))
    .map((k) => ({ slug: k.bare, reason: cut(reasonOf(k)) }))
    .sort(bySlug);

  const result = (state, blocked = null) => ({ state, blocked, prds, verified, refuted, unvalidated });

  if (session.status === 'completed') return result('closed');
  if (session.status === 'proposed') return result('awaiting_approval');
  if (needsInput && !chatBusy) return result('needs_input');

  if (refuted.length > 0) return result('blocked', { kind: 'refuted', prds: refuted.map((p) => ({ ...p })) });
  const failed = knownPrds('failed', errorOf);
  if (failed.length > 0) return result('blocked', { kind: 'failed', prds: failed });
  const parked = knownPrds('needs_review', reviewOf);
  if (parked.length > 0) return result('blocked', { kind: 'needs_review', prds: parked });
  const quarantined = knownPrds('quarantined', (k) => reviewOf(k) || errorOf(k), false);
  if (quarantined.length > 0) return result('blocked', { kind: 'quarantined', prds: quarantined });

  if (chatBusy || known.some((k) => k.status === 'pending' || k.status === 'running' || k.status === 'investigating')) {
    return result('working');
  }
  if (completedWork > 0 && unvalidated.length === 0) return result('verified');
  if (unvalidated.length > 0) return result('in_review');
  return result('open');
}

module.exports = { computeEpicOutsideState, knownPrdSlugs, EPIC_OUTSIDE_STATES };
