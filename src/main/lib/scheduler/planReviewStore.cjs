'use strict';

/**
 * planReviewStore.cjs — read/write `plan-records/<epic>/<validate-slug>.plan-review.json`:
 * the independent plan review(s), the round count, and the release record.
 * Writes go through opsPath + writeJsonAtomic as the plan-records namespace's
 * owner ('scheduler'). Unsafe ids/slugs are refused before any path is built.
 */

const fs = require('node:fs');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const { writeJsonAtomic } = require('../util/atomicFs.cjs');
const { EPIC_ID_RE } = require('./planRecordHarvest.cjs');

const NAMESPACE = 'plan-records';
const WRITER = 'scheduler';
const SUFFIX = '.plan-review.json';
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELEASE_BY = ['planner', 'auto', 'timeout'];

function safeIds(epicId, validateSlug) {
  return typeof epicId === 'string' && EPIC_ID_RE.test(epicId)
    && typeof validateSlug === 'string' && SLUG_RE.test(validateSlug)
    && !validateSlug.includes('..');
}

function assertSafe(epicId, validateSlug) {
  if (!safeIds(epicId, validateSlug)) {
    throw new Error('planReviewStore: unsafe epicId or validateSlug');
  }
}

/** Absolute record path; throws on an unsafe epicId/slug. */
function planReviewPath(cwd, epicId, validateSlug) {
  assertSafe(epicId, validateSlug);
  return opsPath(cwd, NAMESPACE, epicId, `${validateSlug}${SUFFIX}`);
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The record, or null when missing, malformed, or the ids are unsafe. */
function readPlanReview(cwd, epicId, validateSlug) {
  if (!safeIds(epicId, validateSlug)) return null;
  return readFile(planReviewPath(cwd, epicId, validateSlug));
}

async function writeRecord(cwd, record) {
  const file = planReviewPath(cwd, record.epicId, record.validateSlug);
  assertOpsWrite(file, WRITER);
  await writeJsonAtomic(file, record);
  return file;
}

/** Append one review round; the record's `round` becomes the saved round. */
async function savePlanReviewResult({
  cwd, epicId, validateSlug, round, reviewer, runId, model, review,
} = {}) {
  assertSafe(epicId, validateSlug);
  const prior = readPlanReview(cwd, epicId, validateSlug);
  const reviews = prior && Array.isArray(prior.reviews) ? prior.reviews.slice() : [];
  const n = Number.isFinite(round) ? round : reviews.length + 1;
  reviews.push({ round: n, at: new Date().toISOString(), reviewer, runId, model, review });
  const record = {
    ...(prior || {}),
    validateSlug,
    epicId,
    round: n,
    reviews,
    release: prior && prior.release ? prior.release : null,
  };
  if (n === 2) record.rereviewRequested = false;
  await writeRecord(cwd, record);
  return record;
}

/** Record the release once. An already-released record is left untouched. */
async function recordPlanRelease({
  cwd, epicId, validateSlug, by, rejected = [], accepted = 0,
} = {}) {
  assertSafe(epicId, validateSlug);
  if (!RELEASE_BY.includes(by)) throw new Error(`planReviewStore: bad release actor '${by}'`);
  const prior = readPlanReview(cwd, epicId, validateSlug);
  if (prior && prior.release) return { alreadyReleased: true };
  const record = {
    ...(prior || {}),
    validateSlug,
    epicId,
    round: prior && Number.isFinite(prior.round) ? prior.round : 0,
    reviews: prior && Array.isArray(prior.reviews) ? prior.reviews : [],
    release: {
      at: new Date().toISOString(),
      by,
      rejected: (Array.isArray(rejected) ? rejected : []).map((r) => ({
        finding: String(r && r.finding != null ? r.finding : ''),
        reason: String(r && r.reason != null ? r.reason : ''),
      })),
      accepted: Number.isFinite(accepted) ? accepted : 0,
    },
  };
  await writeRecord(cwd, record);
  return record;
}

/**
 * Mark that the review-PRD create was refused (and audited) for `round`.
 * Merge-preserving. Returns true the first time per round, false after.
 */
async function markCreateRefused(cwd, epicId, validateSlug, round) {
  assertSafe(epicId, validateSlug);
  const prior = readPlanReview(cwd, epicId, validateSlug);
  const logged = prior && Array.isArray(prior.createRefusedLogged) ? prior.createRefusedLogged : [];
  if (logged.includes(round)) return false;
  await writeRecord(cwd, {
    ...(prior || {}),
    validateSlug,
    epicId,
    round: prior && Number.isFinite(prior.round) ? prior.round : 0,
    reviews: prior && Array.isArray(prior.reviews) ? prior.reviews : [],
    release: prior && prior.release ? prior.release : null,
    createRefusedLogged: [...logged, round],
  });
  return true;
}

/** Every readable record in an Epic's folder; [] for unsafe id/missing folder. */
function readPlanReviewFiles(cwd, epicId) {
  if (typeof epicId !== 'string' || !EPIC_ID_RE.test(epicId)) return [];
  const dir = opsPath(cwd, NAMESPACE, epicId);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith(SUFFIX)) continue;
    const rec = readFile(`${dir}/${name}`);
    // markCreateRefused stubs (no review, no release) are not plan reviews; readPlanReview still returns them.
    if (rec && !((!Array.isArray(rec.reviews) || rec.reviews.length === 0) && !rec.release)) out.push(rec);
  }
  return out;
}

module.exports = {
  planReviewPath, readPlanReview, savePlanReviewResult, recordPlanRelease, readPlanReviewFiles, markCreateRefused,
};
