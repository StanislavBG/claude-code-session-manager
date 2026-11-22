'use strict';

/**
 * validatorVerdictSchema.cjs — the JSON Schema a plan-level validator run must
 * return through `claude -p --json-schema`, the closed list of miss kinds used
 * to group what it finds, and a checker that turns the CLI's
 * `structured_output` into verdict rows (the parseValidationSentinels row
 * shape plus `missKinds`).
 *
 * The CLI enforces the schema itself; parseValidatorVerdict is the defensive
 * second check plus the rules a schema cannot express: a non-empty REFUTED
 * reason, unique `prd` values, and at least one missKind on every REFUTED
 * entry.
 *
 * Pure: no I/O, no dependencies, never throws, never mutates its input.
 */

/** @typedef {'not-landed'|'gate-red'|'behavior-wrong'|'not-checked-live'|'missing-test'|'regression'|'spec-gap'|'security'|'docs-drift'|'other'} MissKind */
/** @typedef {'Critical'|'Important'|'Minor'} Severity */
/** @typedef {{ id: string, met: boolean, evidence: string, missKind?: MissKind }} Criterion */
/** @typedef {{ severity: Severity, text: string, file?: string, missKind?: MissKind }} Finding */
/** @typedef {{ prd: string, verdict: 'VERIFIED'|'REFUTED', reason: string, criteria: Criterion[], findings: Finding[] }} VerdictEntry */
/** @typedef {{ schedulerVerdict: 'PASS'|'FAIL', failReason?: string, verdicts: VerdictEntry[] }} ValidatorVerdict */
/** @typedef {{ slug: string, verdict: 'verified'|'refuted', reason: string, missKinds: MissKind[] }} VerdictRow */

/** One-line meaning per miss kind, in MISS_KINDS order. */
const MISS_KIND_MEANINGS = Object.freeze({
  'not-landed': 'nothing or the wrong thing was committed',
  'gate-red': 'a gate command fails',
  'behavior-wrong': 'runs but does not do what a criterion says',
  'not-checked-live': 'passes tests, wrong against real data or the real UI',
  'missing-test': 'a criterion or change has no test that checks it',
  regression: 'breaks something that worked',
  'spec-gap': 'every criterion met but the goal is not',
  security: 'introduces a security problem',
  'docs-drift': 'docs no longer match the code',
  other: 'none of the above',
});

/** @type {ReadonlyArray<MissKind>} */
const MISS_KINDS = Object.freeze(/** @type {MissKind[]} */ (Object.keys(MISS_KIND_MEANINGS)));

/** @type {ReadonlyArray<Severity>} */
const SEVERITIES = Object.freeze(/** @type {Severity[]} */ (['Critical', 'Important', 'Minor']));

const MISS_KIND_DESCRIPTION =
  'Kind of miss: ' + MISS_KINDS.map((k) => `${k} = ${MISS_KIND_MEANINGS[k]}`).join('; ') + '.';

const VALIDATOR_VERDICT_SCHEMA = {
  type: 'object',
  description: 'Result of one validator run over a finished plan: one entry per judged PRD.',
  additionalProperties: false,
  required: ['schedulerVerdict', 'verdicts'],
  properties: {
    schedulerVerdict: {
      type: 'string',
      enum: ['PASS', 'FAIL'],
      description: 'PASS when the validator run itself completed; FAIL when it could not judge the plan.',
    },
    failReason: { type: 'string', description: 'Why the run is FAIL.' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prd', 'verdict', 'reason', 'criteria', 'findings'],
        properties: {
          prd: { type: 'string', minLength: 1, description: 'Slug of the judged PRD, e.g. 3612-validator-verdict-schema.' },
          verdict: { type: 'string', enum: ['VERIFIED', 'REFUTED'] },
          reason: { type: 'string', description: 'One line; required (non-empty) when REFUTED.' },
          criteria: {
            type: 'array',
            description: "One entry per item of the judged PRD's # Acceptance criteria list.",
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'met', 'evidence'],
              properties: {
                id: {
                  type: 'string',
                  description: "The criterion's 1-based position in the judged PRD's # Acceptance criteria list, as a string ('1', '2', ...).",
                },
                met: { type: 'boolean' },
                evidence: { type: 'string', description: 'What was checked and what it showed.' },
                missKind: { type: 'string', enum: [...MISS_KINDS], description: MISS_KIND_DESCRIPTION + ' Set it on every unmet criterion.' },
              },
            },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['severity', 'text'],
              properties: {
                severity: { type: 'string', enum: [...SEVERITIES] },
                text: { type: 'string' },
                file: { type: 'string', description: 'Repo-relative path the finding is about.' },
                missKind: { type: 'string', enum: [...MISS_KINDS], description: 'Kind of miss (same list as criteria[].missKind).' },
              },
            },
          },
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

/** @param {unknown} v @param {string} where @returns {string|null} */
function checkMissKind(v, where) {
  if (v === undefined) return null;
  return MISS_KINDS.includes(/** @type {MissKind} */ (v)) ? null : `${where}.missKind: not one of ${MISS_KINDS.join(', ')}`;
}

/** @param {unknown} c @param {string} where @returns {string|null} */
function checkCriterion(c, where) {
  if (!isPlainObject(c)) return `${where}: not an object`;
  const keyErr = checkKeys(c, ['id', 'met', 'evidence'], ['id', 'met', 'evidence', 'missKind'], where);
  if (keyErr) return keyErr;
  if (typeof c.id !== 'string') return `${where}.id: not a string`;
  if (typeof c.met !== 'boolean') return `${where}.met: not a boolean`;
  if (typeof c.evidence !== 'string') return `${where}.evidence: not a string`;
  return checkMissKind(c.missKind, where);
}

/** @param {unknown} f @param {string} where @returns {string|null} */
function checkFinding(f, where) {
  if (!isPlainObject(f)) return `${where}: not an object`;
  const keyErr = checkKeys(f, ['severity', 'text'], ['severity', 'text', 'file', 'missKind'], where);
  if (keyErr) return keyErr;
  if (!SEVERITIES.includes(/** @type {Severity} */ (f.severity))) return `${where}.severity: not one of ${SEVERITIES.join(', ')}`;
  if (typeof f.text !== 'string') return `${where}.text: not a string`;
  if (f.file !== undefined && typeof f.file !== 'string') return `${where}.file: not a string`;
  return checkMissKind(f.missKind, where);
}

/**
 * Miss kinds of one entry: from its unmet criteria and all its findings,
 * deduped and sorted.
 * @param {VerdictEntry} entry
 * @returns {MissKind[]}
 */
function entryMissKinds(entry) {
  /** @type {Set<MissKind>} */
  const kinds = new Set();
  for (const c of entry.criteria) if (!c.met && c.missKind) kinds.add(c.missKind);
  for (const f of entry.findings) if (f.missKind) kinds.add(f.missKind);
  return [...kinds].sort();
}

/** @param {unknown} e @param {string} where @returns {string|null} */
function checkEntry(e, where) {
  if (!isPlainObject(e)) return `${where}: not an object`;
  const keyErr = checkKeys(e, ['prd', 'verdict', 'reason', 'criteria', 'findings'], ['prd', 'verdict', 'reason', 'criteria', 'findings'], where);
  if (keyErr) return keyErr;
  if (typeof e.prd !== 'string' || e.prd.length < 1) return `${where}.prd: not a non-empty string`;
  if (e.verdict !== 'VERIFIED' && e.verdict !== 'REFUTED') return `${where}.verdict: not VERIFIED or REFUTED`;
  if (typeof e.reason !== 'string') return `${where}.reason: not a string`;
  if (!Array.isArray(e.criteria)) return `${where}.criteria: not an array`;
  if (!Array.isArray(e.findings)) return `${where}.findings: not an array`;
  for (let i = 0; i < e.criteria.length; i++) {
    const err = checkCriterion(e.criteria[i], `${where}.criteria[${i}]`);
    if (err) return err;
  }
  for (let i = 0; i < e.findings.length; i++) {
    const err = checkFinding(e.findings[i], `${where}.findings[${i}]`);
    if (err) return err;
  }
  if (e.verdict === 'REFUTED') {
    if (e.reason.trim() === '') return `${where} (${e.prd}): REFUTED with an empty reason`;
    if (entryMissKinds(/** @type {VerdictEntry} */ (/** @type {unknown} */ (e))).length === 0) {
      return `${where} (${e.prd}): REFUTED with no missKind on any unmet criterion or finding`;
    }
  }
  return null;
}

/**
 * parseValidatorVerdict(value) → { ok: true, value } | { ok: false, error }.
 * Never throws.
 * @param {unknown} value
 * @returns {{ ok: true, value: ValidatorVerdict } | { ok: false, error: string }}
 */
function parseValidatorVerdict(value) {
  try {
    if (!isPlainObject(value)) return { ok: false, error: 'verdict: not an object' };
    const keyErr = checkKeys(value, ['schedulerVerdict', 'verdicts'], ['schedulerVerdict', 'failReason', 'verdicts'], 'verdict');
    if (keyErr) return { ok: false, error: keyErr };
    if (value.schedulerVerdict !== 'PASS' && value.schedulerVerdict !== 'FAIL') {
      return { ok: false, error: 'schedulerVerdict: not PASS or FAIL' };
    }
    if (value.failReason !== undefined && typeof value.failReason !== 'string') {
      return { ok: false, error: 'failReason: not a string' };
    }
    if (!Array.isArray(value.verdicts)) return { ok: false, error: 'verdicts: not an array' };
    /** @type {Set<string>} */
    const seen = new Set();
    for (let i = 0; i < value.verdicts.length; i++) {
      const where = `verdicts[${i}]`;
      const err = checkEntry(value.verdicts[i], where);
      if (err) return { ok: false, error: err };
      const prd = /** @type {VerdictEntry} */ (value.verdicts[i]).prd;
      if (seen.has(prd)) return { ok: false, error: `${where}.prd: duplicate ${prd}` };
      seen.add(prd);
    }
    return { ok: true, value: /** @type {ValidatorVerdict} */ (/** @type {unknown} */ (value)) };
  } catch (err) {
    return { ok: false, error: `verdict: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * verdictRowsFromStructured(value) → VerdictRow[] in input order; [] when the
 * value does not pass parseValidatorVerdict.
 * @param {unknown} value
 * @returns {VerdictRow[]}
 */
function verdictRowsFromStructured(value) {
  const parsed = parseValidatorVerdict(value);
  if (!parsed.ok) return [];
  return parsed.value.verdicts.map((e) => ({
    slug: e.prd,
    verdict: e.verdict === 'VERIFIED' ? 'verified' : 'refuted',
    reason: e.reason,
    missKinds: entryMissKinds(e),
  }));
}

module.exports = {
  VALIDATOR_VERDICT_SCHEMA,
  MISS_KINDS,
  MISS_KIND_MEANINGS,
  SEVERITIES,
  parseValidatorVerdict,
  verdictRowsFromStructured,
};
