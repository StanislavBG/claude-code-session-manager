'use strict';

/**
 * planReviewSchema.cjs — the JSON Schema the plan-reviewer returns through
 * `claude -p --json-schema`, a strict parser, and an allOk predicate.
 * Mirrors validatorVerdictSchema.cjs: the CLI enforces the simple schema
 * (enums + required); parsePlanReview adds the cross-field rules (PRD slugs
 * match `expected`, amend|block needs findings, no unknown keys).
 *
 * Pure: no I/O, never throws, never mutates its input.
 */

/** @typedef {'Critical'|'Important'|'Minor'} Severity */
/** @typedef {'ok'|'amend'|'block'} Decision */
/** @typedef {{ severity: Severity, check: string, text: string, suggestedEdit?: string, field?: string }} PrdFinding */
/** @typedef {{ prd: string, decision: Decision, findings: PrdFinding[] }} PrdReview */
/** @typedef {{ severity: Severity, check: string, text: string }} PlanFinding */
/** @typedef {{ prds: PrdReview[], planFindings: PlanFinding[] }} PlanReview */
/** @typedef {{ ok: true, value: PlanReview } | { ok: false, error: string }} ParseResult */

const PLAN_REVIEW_CHECKS = [
  'provable-criterion',
  'failure-path',
  'edge-case',
  'vacuous-by-sibling',
  'depends-on',
  'gate-green-at-base',
  'http-criterion',
  'doc-after-code',
];
const SEVERITIES = ['Critical', 'Important', 'Minor'];
const DECISIONS = ['ok', 'amend', 'block'];

const PLAN_REVIEW_SCHEMA = {
  type: 'object',
  required: ['prds', 'planFindings'],
  properties: {
    prds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['prd', 'decision', 'findings'],
        properties: {
          prd: { type: 'string' },
          decision: { type: 'string', enum: DECISIONS },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['severity', 'check', 'text'],
              properties: {
                severity: { type: 'string', enum: SEVERITIES },
                check: { type: 'string', enum: PLAN_REVIEW_CHECKS },
                text: { type: 'string' },
                suggestedEdit: { type: 'string' },
                field: { type: 'string' },
              },
            },
          },
        },
      },
    },
    planFindings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'check', 'text'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          check: { type: 'string', enum: PLAN_REVIEW_CHECKS },
          text: { type: 'string' },
        },
      },
    },
  },
};

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} required
 * @param {string[]} allowed
 * @param {string} where
 * @returns {string|null}
 */
function checkKeys(obj, required, allowed, where) {
  for (const k of required) if (!(k in obj)) return `${where}: missing ${k}`;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${where}: unexpected key ${k}`;
  return null;
}

/**
 * @param {unknown} f
 * @param {string} where
 * @param {boolean} prdLevel
 * @returns {string|null}
 */
function checkFinding(f, where, prdLevel) {
  if (!isPlainObject(f)) return `${where}: not an object`;
  const keyErr = checkKeys(
    f,
    ['severity', 'check', 'text'],
    prdLevel ? ['severity', 'check', 'text', 'suggestedEdit', 'field'] : ['severity', 'check', 'text'],
    where,
  );
  if (keyErr) return keyErr;
  if (!SEVERITIES.includes(/** @type {string} */ (f.severity))) return `${where}.severity: not one of ${SEVERITIES.join(', ')}`;
  if (!PLAN_REVIEW_CHECKS.includes(/** @type {string} */ (f.check))) return `${where}.check: unknown check ${String(f.check)}`;
  if (typeof f.text !== 'string') return `${where}.text: not a string`;
  if (f.suggestedEdit !== undefined && typeof f.suggestedEdit !== 'string') return `${where}.suggestedEdit: not a string`;
  if (f.field !== undefined && typeof f.field !== 'string') return `${where}.field: not a string`;
  return null;
}

/**
 * parsePlanReview(value, { expected }) → { ok, value | error }.
 * `expected` is the list (array or Set) of PRD slugs the review must cover
 * exactly: none missing, none extra, none duplicated.
 * @param {unknown} value
 * @param {{ expected?: Iterable<string>|null }} [opts]
 * @returns {ParseResult}
 */
function parsePlanReview(value, opts = {}) {
  try {
    if (!isPlainObject(value)) return { ok: false, error: 'review: not an object' };
    const keyErr = checkKeys(value, ['prds', 'planFindings'], ['prds', 'planFindings'], 'review');
    if (keyErr) return { ok: false, error: keyErr };
    if (!Array.isArray(value.prds)) return { ok: false, error: 'prds: not an array' };
    if (!Array.isArray(value.planFindings)) return { ok: false, error: 'planFindings: not an array' };
    /** @type {Set<string>} */
    const seen = new Set();
    for (let i = 0; i < value.prds.length; i++) {
      const where = `prds[${i}]`;
      const p = value.prds[i];
      if (!isPlainObject(p)) return { ok: false, error: `${where}: not an object` };
      const pe = checkKeys(p, ['prd', 'decision', 'findings'], ['prd', 'decision', 'findings'], where);
      if (pe) return { ok: false, error: pe };
      if (typeof p.prd !== 'string' || !p.prd) return { ok: false, error: `${where}.prd: not a non-empty string` };
      if (seen.has(p.prd)) return { ok: false, error: `${where}.prd: duplicate ${p.prd}` };
      seen.add(p.prd);
      if (!DECISIONS.includes(/** @type {string} */ (p.decision))) {
        return { ok: false, error: `${where}.decision: not one of ${DECISIONS.join(', ')}` };
      }
      if (!Array.isArray(p.findings)) return { ok: false, error: `${where}.findings: not an array` };
      for (let j = 0; j < p.findings.length; j++) {
        const err = checkFinding(p.findings[j], `${where}.findings[${j}]`, true);
        if (err) return { ok: false, error: err };
      }
      if (p.decision !== 'ok' && p.findings.length === 0) {
        return { ok: false, error: `${where}: decision ${p.decision} needs at least one finding` };
      }
    }
    for (let i = 0; i < value.planFindings.length; i++) {
      const err = checkFinding(value.planFindings[i], `planFindings[${i}]`, false);
      if (err) return { ok: false, error: err };
    }
    if (opts && opts.expected) {
      const exp = new Set(opts.expected);
      for (const slug of exp) if (!seen.has(slug)) return { ok: false, error: `prds: missing ${slug}` };
      for (const slug of seen) if (!exp.has(slug)) return { ok: false, error: `prds: unexpected ${slug}` };
    }
    return { ok: true, value: /** @type {PlanReview} */ (/** @type {unknown} */ (value)) };
  } catch (err) {
    return { ok: false, error: `review: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * True only when every PRD decision is ok and planFindings is empty.
 * @param {PlanReview} review
 * @returns {boolean}
 */
function isAllOk(review) {
  if (!review || !Array.isArray(review.prds) || !Array.isArray(review.planFindings)) return false;
  return review.planFindings.length === 0 && review.prds.every((p) => p && p.decision === 'ok');
}

module.exports = { PLAN_REVIEW_SCHEMA, PLAN_REVIEW_CHECKS, parsePlanReview, isAllOk };
