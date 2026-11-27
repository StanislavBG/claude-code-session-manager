'use strict';

/**
 * planReviewHold.cjs — pure rule deciding which plans need an independent plan
 * review, which pending rows are held 'held: plan-review' until it lands, and
 * which holds have timed out. Shaped like computePreflightHolds so the tick can
 * merge `held` into heldSlugs. No fs: the caller passes queue rows and the
 * stored review records ({ [bareValidateSlug]: record }).
 *
 * Record fields read (all optional): `release` (non-null object, as planReviewStore.recordPlanRelease writes it = released),
 * `firstReviewAt` / `reviews[0].at` (hold start when a review exists).
 * Hold-start fields, in order: review record, then validator row `queuedAt`
 * (stamped at enqueue), `planReviewHeldAt`, `createdAt`.
 */

const { bareSlug } = require('../lib/prd/depSlugResolve.cjs');

const DEFAULT_HOLD_MINUTES = 240;
const REVIEWER_AGENT = 'plan-reviewer';

function holdMsFromEnv(env = process.env) {
  const n = Number(env.SM_PLAN_REVIEW_HOLD_MINUTES);
  const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_HOLD_MINUTES;
  return minutes * 60 * 1000;
}

function planReviewEnabled(env = process.env) {
  return String(env.SM_PLAN_REVIEW ?? '') !== '0';
}

/**
 * Transitive dependsOn walk from a validator row. Same-cwd only (a row with no
 * cwd is kept), bare-slug matching. Excludes the validator and reviewer rows.
 * @param {any} validateRow
 * @param {any[]} rows
 * @returns {any[]}
 */
function planMembers(validateRow, rows) {
  if (!validateRow || !Array.isArray(rows)) return [];
  const scoped = rows.filter((r) => r && (!validateRow.cwd || r.cwd == null || r.cwd === validateRow.cwd));
  const byBare = new Map();
  for (const r of scoped) {
    const b = bareSlug(r.slug);
    if (!byBare.has(b)) byBare.set(b, []);
    byBare.get(b).push(r);
  }
  const members = [];
  const seen = new Set();
  const visited = new Set();
  const queue = Array.isArray(validateRow.dependsOn) ? [...validateRow.dependsOn] : [];
  while (queue.length) {
    const dep = bareSlug(queue.shift());
    if (visited.has(dep)) continue;
    visited.add(dep);
    for (const row of byBare.get(dep) ?? []) {
      if (row === validateRow || row.slug === validateRow.slug) continue;
      if (row.agentType === REVIEWER_AGENT || row.agentType === 'validator') continue;
      if (!seen.has(row.slug)) {
        seen.add(row.slug);
        members.push(row);
      }
      for (const d of row.dependsOn ?? []) if (!visited.has(bareSlug(d))) queue.push(d);
    }
  }
  return members;
}

/** True when >= 3 members, or any member depends on another member. */
function qualifiesForReview(members) {
  if (!Array.isArray(members)) return false;
  if (members.length >= 3) return true;
  const bares = new Set(members.map((m) => bareSlug(m.slug)));
  return members.some((m) => (m.dependsOn ?? []).some(
    (d) => bares.has(bareSlug(d)) && bareSlug(d) !== bareSlug(m.slug),
  ));
}

function isReleased(record) {
  return !!record && record.release != null && typeof record.release === 'object';
}

function holdStartMs(validateRow, record) {
  const candidates = [
    record?.firstReviewAt, record?.reviews?.[0]?.at,
    validateRow?.queuedAt, validateRow?.planReviewHeldAt, validateRow?.createdAt,
  ];
  for (const c of candidates) {
    const t = Date.parse(c ?? '');
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * @param {any[]} rows
 * @param {Record<string, any>} reviewsByValidateSlug keyed by bare validate slug
 * @param {{ now?: number, holdMs?: number }} [opts]
 * @returns {{ held: Map<string, string>, needsReview: string[], expired: string[] }}
 */
function computePlanReviewHolds(rows, reviewsByValidateSlug, opts = {}) {
  const now = opts.now ?? Date.now();
  const holdMs = opts.holdMs ?? holdMsFromEnv();
  const held = new Map();
  const needsReview = [];
  const expired = [];
  const reviews = reviewsByValidateSlug || {};
  for (const v of rows || []) {
    if (!v || v.status !== 'pending' || v.agentType !== 'validator' || v.planReview !== 'required') continue;
    const members = planMembers(v, rows);
    if (!qualifiesForReview(members)) continue;
    const record = reviews[bareSlug(v.slug)];
    if (isReleased(record)) continue;
    const hasReview = !!record && (record.firstReviewAt || (Array.isArray(record.reviews) && record.reviews.length > 0));
    if (!hasReview) needsReview.push(v.slug);
    const start = holdStartMs(v, record);
    if (start != null && now - start > holdMs) expired.push(v.slug);
    const reason = `held: plan-review — waiting on independent review of plan ${bareSlug(v.slug)}`;
    for (const m of members) {
      if (m.status === 'pending') held.set(m.slug, reason);
    }
  }
  return { held, needsReview, expired };
}

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
function familyOf(model) {
  const m = String(model ?? '').toLowerCase();
  return MODEL_FAMILIES.find((f) => m.includes(f)) || null;
}

/**
 * The reviewer must not share the planner's model family: personaModel is kept
 * unless it matches plannerModel's family, then 'opus' (persona sonnet) else 'sonnet'.
 */
function reviewerModelFor(personaModel, plannerModel) {
  const persona = String(personaModel ?? '').trim();
  const pf = familyOf(persona);
  const lf = familyOf(plannerModel);
  if (persona && !(pf && lf && pf === lf)) return persona;
  return pf === 'sonnet' ? 'opus' : 'sonnet';
}

module.exports = {
  reviewerModelFor,
  planMembers, qualifiesForReview, computePlanReviewHolds, holdMsFromEnv, planReviewEnabled,
};
