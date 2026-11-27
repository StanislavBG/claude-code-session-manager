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
 * entry. With `{ expected }` (prd -> { ids, failedIds }, built by the
 * scheduler from each judged PRD's frontmatter `criteria` and its stored
 * mechanical check results) it also refuses an entry that omits a criterion
 * id or marks met: true a criterion whose mechanical check failed.
 *
 * Pure: no I/O, never throws, never mutates its input. Its one dependency is
 * criteriaChecks.cjs, for the http retry constants the prompt section names.
 */

const { HTTP_RETRY_ATTEMPTS, HTTP_RETRY_DELAY_MS } = require('./criteriaChecks.cjs');

/** @typedef {'not-landed'|'gate-red'|'behavior-wrong'|'not-checked-live'|'missing-test'|'regression'|'spec-gap'|'security'|'docs-drift'|'other'} MissKind */
/** @typedef {'Critical'|'Important'|'Minor'} Severity */
/** @typedef {{ id: string, met: boolean, evidence: string, missKind?: MissKind }} Criterion */
/** @typedef {{ severity: Severity, text: string, file?: string, missKind?: MissKind }} Finding */
/** @typedef {{ prd: string, verdict: 'VERIFIED'|'REFUTED', reason: string, criteria: Criterion[], findings: Finding[] }} VerdictEntry */
/** @typedef {{ schedulerVerdict: 'PASS'|'FAIL', failReason?: string, lessons?: string[], verdicts: VerdictEntry[] }} ValidatorVerdict */
/** @typedef {{ slug: string, verdict: 'verified'|'refuted', reason: string, missKinds: MissKind[] }} VerdictRow */
/** @typedef {{ ids: string[], failedIds?: string[] }} ExpectedCriteria */
/** @typedef {Record<string, ExpectedCriteria> | Map<string, ExpectedCriteria>} ExpectedMap */
/** @typedef {'criterion-missing'|'criterion-met-on-failed-check'} CriteriaErrorCode */
/** @typedef {{ ok: true, value: ValidatorVerdict } | { ok: false, error: string, code?: CriteriaErrorCode }} ParseResult */

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
    lessons: {
      type: 'array',
      maxItems: 3,
      description: 'Optional: at most 3 lessons a future run would need; usually omitted.',
      items: { type: 'string', maxLength: 200 },
    },
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
                  description: "The criterion's id: when the judged PRD lists structured criteria with ids (e.g. 'ac-1'), that id exactly; otherwise its 1-based position in the PRD's # Acceptance criteria list, as a string ('1', '2', ...). Return one entry per criterion id.",
                },
                met: { type: 'boolean', description: 'Never true when that criterion\'s mechanical check failed.' },
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

/** Leading numeric prefix stripped (`3612-a` -> `a`). */
function bareOf(slug) {
  return String(slug).replace(/^\d+-/, '');
}

/**
 * The expected-criteria entry for one judged prd: exact key first, then a
 * bare-slug match (a validator may report `x` for a PRD filed as `3612-x`).
 * @param {ExpectedMap} expected
 * @param {string} prd
 * @returns {ExpectedCriteria|null}
 */
function lookupExpected(expected, prd) {
  const entries = expected instanceof Map ? [...expected.entries()] : Object.entries(expected);
  for (const [k, v] of entries) if (k === prd) return v;
  const bare = bareOf(prd);
  for (const [k, v] of entries) if (bareOf(k) === bare) return v;
  return null;
}

/**
 * Cross-check one entry's criteria against what the scheduler expects.
 * @param {VerdictEntry} entry
 * @param {ExpectedCriteria} exp
 * @param {string} where
 * @returns {{ error: string, code: CriteriaErrorCode }|null}
 */
function checkExpectedCriteria(entry, exp, where) {
  const ids = Array.isArray(exp.ids) ? exp.ids.filter((x) => typeof x === 'string') : [];
  const failed = new Set(Array.isArray(exp.failedIds) ? exp.failedIds.filter((x) => typeof x === 'string') : []);
  const reported = new Set(entry.criteria.map((c) => c.id));
  for (const id of ids) {
    if (!reported.has(id)) {
      return { error: `${where} (${entry.prd}): missing criterion id ${id}`, code: 'criterion-missing' };
    }
  }
  for (const c of entry.criteria) {
    if (c.met === true && failed.has(c.id)) {
      return {
        error: `${where} (${entry.prd}): criterion ${c.id} marked met but its mechanical check failed`,
        code: 'criterion-met-on-failed-check',
      };
    }
  }
  return null;
}

/**
 * parseValidatorVerdict(value, { expected }?) → { ok: true, value } | { ok: false, error, code? }.
 * `expected` maps a judged prd slug to { ids, failedIds }; an entry whose prd
 * has no expected record is checked as before. Never throws.
 * @param {unknown} value
 * @param {{ expected?: ExpectedMap|null }} [opts]
 * @returns {ParseResult}
 */
function parseValidatorVerdict(value, opts = {}) {
  try {
    if (!isPlainObject(value)) return { ok: false, error: 'verdict: not an object' };
    const keyErr = checkKeys(value, ['schedulerVerdict', 'verdicts'], ['schedulerVerdict', 'failReason', 'lessons', 'verdicts'], 'verdict');
    if (keyErr) return { ok: false, error: keyErr };
    if (value.schedulerVerdict !== 'PASS' && value.schedulerVerdict !== 'FAIL') {
      return { ok: false, error: 'schedulerVerdict: not PASS or FAIL' };
    }
    if (value.failReason !== undefined && typeof value.failReason !== 'string') {
      return { ok: false, error: 'failReason: not a string' };
    }
    if (value.lessons !== undefined) {
      if (!Array.isArray(value.lessons) || value.lessons.length > 3) return { ok: false, error: 'lessons: not an array of at most 3' };
      if (value.lessons.some((l) => typeof l !== 'string' || l.length > 200)) return { ok: false, error: 'lessons: each must be a string of at most 200 chars' };
    }
    if (!Array.isArray(value.verdicts)) return { ok: false, error: 'verdicts: not an array' };
    const expected = opts && (opts.expected instanceof Map || isPlainObject(opts.expected)) ? opts.expected : null;
    /** @type {Set<string>} */
    const seen = new Set();
    for (let i = 0; i < value.verdicts.length; i++) {
      const where = `verdicts[${i}]`;
      const err = checkEntry(value.verdicts[i], where);
      if (err) return { ok: false, error: err };
      const entry = /** @type {VerdictEntry} */ (value.verdicts[i]);
      if (seen.has(entry.prd)) return { ok: false, error: `${where}.prd: duplicate ${entry.prd}` };
      seen.add(entry.prd);
      if (expected) {
        const exp = lookupExpected(/** @type {ExpectedMap} */ (expected), entry.prd);
        if (exp && typeof exp === 'object') {
          const critErr = checkExpectedCriteria(entry, exp, where);
          if (critErr) return { ok: false, ...critErr };
        }
      }
    }
    return { ok: true, value: /** @type {ValidatorVerdict} */ (/** @type {unknown} */ (value)) };
  } catch (err) {
    return { ok: false, error: `verdict: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * expectedFromCriteria(criteria, checks) → ExpectedCriteria | null.
 * `criteria` is a PRD's frontmatter `criteria` list ({ id, ... }); `checks`
 * its stored mechanical results ({ id, ok }). failedIds = ids whose check
 * came back ok: false (a manual check, ok: null, never counts as failed).
 * Null when the PRD has no structured criteria.
 * @param {unknown} criteria
 * @param {unknown} checks
 * @returns {{ ids: string[], failedIds: string[] }|null}
 */
function expectedFromCriteria(criteria, checks) {
  if (!Array.isArray(criteria)) return null;
  const ids = criteria
    .map((c) => (isPlainObject(c) && typeof c.id === 'string' ? c.id : null))
    .filter((x) => typeof x === 'string' && x !== '');
  if (!ids.length) return null;
  const idSet = new Set(ids);
  const failedIds = (Array.isArray(checks) ? checks : [])
    .filter((c) => isPlainObject(c) && c.ok === false && typeof c.id === 'string' && idSet.has(c.id))
    .map((c) => /** @type {string} */ (/** @type {Record<string, unknown>} */ (c).id));
  return { ids, failedIds: [...new Set(failedIds)] };
}

/**
 * formatCriteriaChecksSection(prds) → Markdown for the validator prompt: per
 * judged PRD, each criterion id, its statement, and its mechanical check
 * result (http/file run at validator dispatch; command as stored), plus the
 * body sidecar path of each http row. '' when no PRD has structured criteria.
 * @param {Array<{ slug: string, criteria: unknown, checks: unknown }>} prds
 * @returns {string}
 */
function formatCriteriaChecksSection(prds) {
  const oneLine = (v, max = 300) => {
    const t = String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  const blocks = [];
  for (const p of Array.isArray(prds) ? prds : []) {
    if (!p || !Array.isArray(p.criteria) || !p.criteria.length) continue;
    /** @type {Map<string, Record<string, unknown>>} */
    const byId = new Map();
    for (const c of Array.isArray(p.checks) ? p.checks : []) {
      if (isPlainObject(c) && typeof c.id === 'string') byId.set(c.id, c);
    }
    const lines = [`### ${oneLine(p.slug, 200)}`];
    for (const c of p.criteria) {
      if (!isPlainObject(c) || typeof c.id !== 'string') continue;
      const r = byId.get(c.id);
      const kind = isPlainObject(c.check) && typeof c.check.kind === 'string' ? c.check.kind : 'manual';
      const result = !r ? 'not run' : r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'manual';
      const detail = r && r.detail ? ` — ${oneLine(r.detail)}` : '';
      const ranAt = r && typeof r.ranAt === 'string' && r.ranAt ? ` (ran ${oneLine(r.ranAt, 40)})` : '';
      const attempts = r && Number.isInteger(r.attempts) && /** @type {number} */ (r.attempts) > 1 ? ` (${r.attempts} attempts)` : '';
      lines.push(`- \`${oneLine(c.id, 60)}\` (${kind}) ${result}${ranAt}${attempts}${detail}: ${oneLine(c.statement)}`);
      if (r && typeof r.bodyPath === 'string' && r.bodyPath) {
        const bytes = Number.isFinite(r.bodyBytes) ? r.bodyBytes : 0;
        lines.push(`  - body: ${oneLine(r.bodyPath, 500)} (${bytes} bytes${r.truncated === true ? ', truncated at 1 MiB' : ''})`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return '';
  const retrySentence = `A failed \`http\` check was retried (up to ${HTTP_RETRY_ATTEMPTS} attempts, ${Math.round(HTTP_RETRY_DELAY_MS / 1000)} s apart) before it was recorded, so a FAIL row is a repeated failure.`;
  return [
    '## Stored mechanical check results',
    '',
    'The `http` and `file` checks below were run by the scheduler outside your sandbox just before you started. `command` rows show a stored result or `not run` — re-run those yourself. Your Bash cannot reach host loopback, so never probe a running service: judge `http` criteria from these results. ' + retrySentence + ' Each `http` row names a `body:` file holding the response body; judge structural expectations (for example every item has a non-empty field) by reading that file inside your sandbox. In your verdict JSON, return one `criteria` entry per criterion id below, using that id exactly. A criterion whose check is FAIL must be `met: false` — a verdict marking it met is refused.',
    '',
    ...blocks,
  ].join('\n');
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
  expectedFromCriteria,
  formatCriteriaChecksSection,
};
