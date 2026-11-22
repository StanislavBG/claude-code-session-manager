/**
 * validationQuality.cjs — pure calculator for the validator's quality numbers,
 * per project, each with the PRD slugs behind it:
 *   - firstPass: share of judged work PRDs whose EARLIEST verdict is VERIFIED
 *   - refuted:   share of judged work PRDs with ANY REFUTED verdict
 *   - fixWaves:  fix-wave plans per original plan (a plan = a non-sweep
 *                validator row + its dependsOn; a fix wave = a plan holding a
 *                row with `fixes`)
 *   - escapes:   a fix row naming a PRD whose newest verdict strictly before
 *                the fix row's creation was VERIFIED (the validator missed it)
 *   - week:      the 7 days ending at nowMs — miss kinds counted over REFUTED
 *                verdicts and escapes, the top one, and one proposed standard
 *                check for a human to approve. A REFUTED verdict with no
 *                missKinds array (written before checked JSON verdicts) is
 *                unclassified: listed in week.unclassified, never ranked.
 *
 * No cost or usage numbers — those stay in loopEfficiency.cjs.
 * Pure: no I/O, no Date.now(), no mutation of inputs.
 */

'use strict';

const path = require('path');
const { bareSlug } = require('../prd/depSlugResolve.cjs');
const { isSweepValidatorSlug } = require('../epic/epicSweepValidator.cjs');
const { MISS_KINDS } = require('./validatorVerdictSchema.cjs');
const { refutedReason } = require('../epic/epicOutsideState.cjs');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One proposed standard check per miss kind, in MISS_KINDS order. */
const PROPOSED_CHECKS = Object.freeze({
  'not-landed': 'Before VERIFIED, confirm the PRD\'s commit is on the branch and its diff touches the files the criteria name.',
  'gate-red': 'Before VERIFIED, re-run every gate command yourself and cite its exit code and last lines as evidence.',
  'behavior-wrong': 'Before VERIFIED, exercise each criterion\'s behavior directly and cite the observed output next to the criterion text.',
  'not-checked-live': 'Before VERIFIED on a UI or data change, run it against real data or the live page and cite that output as evidence.',
  'missing-test': 'Before VERIFIED, name the test that checks each criterion and refute any criterion that has none.',
  regression: 'Before VERIFIED, run the full test suite of every module the diff touches, not only the PRD\'s own test.',
  'spec-gap': 'Before VERIFIED, restate the PRD\'s goal and check it is met end to end, not only criterion by criterion.',
  security: 'Before VERIFIED, review the diff for new input paths, shell calls, secrets and permission changes and cite what was checked.',
  'docs-drift': 'Before VERIFIED, grep the docs for every renamed or changed name in the diff and confirm they still match the code.',
  other: 'Before VERIFIED, list what was checked for each criterion and how, so a later miss can be traced to a missing step.',
});

/** @param {unknown} t @returns {number} NaN when unparseable */
function toMs(t) {
  if (typeof t === 'number') return Number.isFinite(t) ? t : NaN;
  if (typeof t === 'string' && t) {
    const n = Date.parse(t);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** @param {any} r */
function rowCreatedMs(r) {
  for (const k of ['createdAt', 'enqueuedAt', 'issuedAt']) {
    const ms = toMs(r && r[k]);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

/** @param {unknown} k @returns {string} */
function normMissKind(k) {
  return typeof k === 'string' && MISS_KINDS.includes(/** @type {any} */ (k)) ? k : 'other';
}

/** @param {number} num @param {number} den */
function pct(num, den) {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null;
}

/** @param {Iterable<string>} xs */
function sortedUnique(xs) {
  return [...new Set(xs)].sort();
}

/** @param {unknown} list @returns {string[]} */
function bareList(list) {
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s).map(bareSlug) : [];
}

/** @param {any} r */
function isValidatorRow(r) {
  return !!r && (r.agentType === 'validator' || bareSlug(r.slug).startsWith('validate-'));
}

/**
 * @param {{ epics?: Array<{ cwd: string, epicId?: string, events?: any[] }>, rows?: any[], nowMs: number }} input
 */
function computeValidationQuality({ epics, rows, nowMs }) {
  /** @type {Map<string, { cwd: string, verdicts: Map<string, Array<{ at: number, verdict: 'verified'|'refuted', reason: string|null, missKinds: string[], legacy: boolean, validator: string|null }>>, rows: any[] }>} */
  const byCwd = new Map();
  const bucket = (/** @type {string} */ cwd) => {
    let b = byCwd.get(cwd);
    if (!b) {
      b = { cwd, verdicts: new Map(), rows: [] };
      byCwd.set(cwd, b);
    }
    return b;
  };

  for (const e of epics || []) {
    if (!e || typeof e.cwd !== 'string') continue;
    const b = bucket(e.cwd);
    for (const ev of e.events || []) {
      if (!ev || ev.kind !== 'response' || typeof ev.prdSlug !== 'string' || !ev.prdSlug) continue;
      const verdict = String(ev.validation || '').toLowerCase();
      if (verdict !== 'verified' && verdict !== 'refuted') continue;
      const at = toMs(ev.at);
      if (!Number.isFinite(at)) continue;
      const key = bareSlug(ev.prdSlug);
      let list = b.verdicts.get(key);
      if (!list) b.verdicts.set(key, (list = []));
      list.push({
        at,
        verdict,
        reason: (typeof ev.reason === 'string' && ev.reason) || refutedReason(ev.text) || null,
        missKinds: Array.isArray(ev.missKinds) ? ev.missKinds : [],
        legacy: !Array.isArray(ev.missKinds),
        validator: typeof ev.validator === 'string' && ev.validator ? ev.validator : null,
      });
    }
  }
  for (const r of rows || []) {
    if (!r || typeof r.cwd !== 'string' || typeof r.slug !== 'string') continue;
    bucket(r.cwd).rows.push(r);
  }

  const fromMs = nowMs - WEEK_MS;
  const inWeek = (/** @type {number} */ t) => t > fromMs && t <= nowMs;

  const projects = [];
  for (const b of byCwd.values()) {
    for (const list of b.verdicts.values()) list.sort((x, y) => x.at - y.at);

    /** @type {Map<string, any>} */
    const rowByBare = new Map();
    for (const r of b.rows) if (!rowByBare.has(bareSlug(r.slug))) rowByBare.set(bareSlug(r.slug), r);
    const isValidatorBare = (/** @type {string} */ s) =>
      s.startsWith('validate-') || isValidatorRow(rowByBare.get(s));

    // --- firstPass / refuted -------------------------------------------------
    let judged = 0;
    const firstPassPrds = [];
    const refutedPrds = [];
    for (const [slug, list] of b.verdicts) {
      if (isValidatorBare(slug) || list.length === 0) continue;
      judged += 1;
      if (list[0].verdict === 'verified') firstPassPrds.push(slug);
      if (list.some((x) => x.verdict === 'refuted')) refutedPrds.push(slug);
    }

    // --- plans and fix waves -------------------------------------------------
    /** @type {Map<string, string[]>} plan (bare validator slug) -> member bare slugs */
    const plans = new Map();
    for (const r of b.rows) {
      if (!isValidatorRow(r) || isSweepValidatorSlug(r.slug)) continue;
      const key = bareSlug(r.slug);
      const members = plans.get(key) || [];
      plans.set(key, sortedUnique([...members, ...bareList(r.dependsOn)]));
    }
    const fixTargetsOf = (/** @type {string} */ plan) =>
      (plans.get(plan) || []).flatMap((m) => bareList(rowByBare.get(m) && rowByBare.get(m).fixes));
    const isFixWave = (/** @type {string} */ plan) => fixTargetsOf(plan).length > 0;

    /** Original (non-fix-wave) plans a plan's fixes trace back to. */
    const originsOf = (/** @type {string} */ plan, /** @type {Set<string>} */ seen) => {
      if (seen.has(plan)) return [];
      seen.add(plan);
      if (!isFixWave(plan)) return [plan];
      const out = [];
      for (const target of fixTargetsOf(plan)) {
        for (const [other, members] of plans) {
          if (other !== plan && members.includes(target)) out.push(...originsOf(other, seen));
        }
      }
      return out;
    };

    /** @type {Map<string, Set<string>>} */
    const wavesByOrigin = new Map();
    let fixWavePlans = 0;
    for (const plan of plans.keys()) if (!isFixWave(plan)) wavesByOrigin.set(plan, new Set());
    for (const plan of plans.keys()) {
      if (!isFixWave(plan)) continue;
      fixWavePlans += 1;
      for (const origin of originsOf(plan, new Set())) {
        const set = wavesByOrigin.get(origin);
        if (set) set.add(plan);
      }
    }
    const originalPlans = wavesByOrigin.size;
    const fixWaves = {
      perPlan: originalPlans > 0 ? Math.round((fixWavePlans / originalPlans) * 100) / 100 : null,
      plans: [...wavesByOrigin.keys()].sort().map((plan) => ({ plan, fixWaves: sortedUnique(/** @type {Set<string>} */ (wavesByOrigin.get(plan))) })),
    };

    // --- escapes -------------------------------------------------------------
    const escapes = [];
    for (const r of b.rows) {
      const targets = sortedUnique(bareList(r.fixes));
      if (targets.length === 0) continue;
      const created = rowCreatedMs(r);
      if (!Number.isFinite(created)) continue;
      for (const target of targets) {
        const list = b.verdicts.get(target) || [];
        let newest = null;
        for (const x of list) if (x.at < created) newest = x;
        if (!newest || newest.verdict !== 'verified') continue;
        escapes.push({
          fixPrd: bareSlug(r.slug),
          escapedPrd: target,
          verifiedBy: newest.validator,
          missKind: normMissKind(r.missKind ?? (Array.isArray(r.missKinds) ? r.missKinds[0] : undefined)),
          reason: typeof r.reason === 'string' && r.reason ? r.reason : null,
          at: created,
        });
      }
    }
    escapes.sort((x, y) => x.at - y.at || (x.fixPrd < y.fixPrd ? -1 : x.fixPrd > y.fixPrd ? 1 : 0) || (x.escapedPrd < y.escapedPrd ? -1 : 1));

    // --- week ----------------------------------------------------------------
    /** @type {Record<string, number>} */
    const missKinds = Object.fromEntries(MISS_KINDS.map((k) => [k, 0]));
    /** @type {Map<string, { prds: string[], reasons: string[] }>} */
    const detail = new Map(MISS_KINDS.map((k) => [k, { prds: [], reasons: [] }]));
    const note = (/** @type {string} */ kind, /** @type {string} */ prd, /** @type {string|null} */ reason) => {
      missKinds[kind] += 1;
      const d = /** @type {{ prds: string[], reasons: string[] }} */ (detail.get(kind));
      d.prds.push(prd);
      if (reason && !d.reasons.includes(reason)) d.reasons.push(reason);
    };
    let unclassifiedCount = 0;
    const unclassifiedPrds = [];
    const unclassifiedReasons = [];
    for (const [slug, list] of b.verdicts) {
      for (const x of list) {
        if (x.verdict !== 'refuted' || !inWeek(x.at)) continue;
        if (x.legacy) {
          unclassifiedCount += 1;
          unclassifiedPrds.push(slug);
          if (x.reason && !unclassifiedReasons.includes(x.reason)) unclassifiedReasons.push(x.reason);
          continue;
        }
        const kinds = x.missKinds.length ? [...new Set(x.missKinds.map(normMissKind))] : ['other'];
        for (const k of kinds) note(k, slug, x.reason);
      }
    }
    for (const e of escapes) if (inWeek(e.at)) note(e.missKind, e.escapedPrd, e.reason);

    let topMiss = null;
    for (const k of MISS_KINDS) {
      if (missKinds[k] > 0 && (!topMiss || missKinds[k] > topMiss.count)) {
        const d = /** @type {{ prds: string[], reasons: string[] }} */ (detail.get(k));
        topMiss = { missKind: k, count: missKinds[k], prds: sortedUnique(d.prds), reasons: d.reasons.slice(0, 5), proposal: PROPOSED_CHECKS[k] };
      }
    }

    projects.push({
      cwd: b.cwd,
      project: path.basename(b.cwd),
      firstPass: { pct: pct(firstPassPrds.length, judged), prds: sortedUnique(firstPassPrds) },
      refuted: { pct: pct(refutedPrds.length, judged), prds: sortedUnique(refutedPrds) },
      fixWaves,
      escapes,
      week: {
        fromMs,
        toMs: nowMs,
        missKinds,
        topMiss,
        unclassified: { count: unclassifiedCount, prds: sortedUnique(unclassifiedPrds), reasons: unclassifiedReasons.slice(0, 5) },
      },
    });
  }

  projects.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : a.cwd < b.cwd ? -1 : 1));
  return { projects };
}

module.exports = { computeValidationQuality, PROPOSED_CHECKS };
