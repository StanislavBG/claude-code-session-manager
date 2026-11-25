'use strict';

/**
 * Structured PRD acceptance criteria (Managed Agents C-series primitive).
 *
 * A criterion is either a plain string (a `manual` criterion with a generated
 * id `ac-<n>`) or an object `{ id?, statement, check?: { kind, spec } }` so a
 * criterion can be checked mechanically:
 *   - command: spec is one gate command; must pass prdGateFiles.validateGate.
 *   - file:    spec is a repo-relative path string, or { path, contains? }.
 *   - http:    spec is a loopback URL string, or { url, status?, contains? } (status defaults
 *              to 200; contains is one-line text the response body must include).
 *   - manual:  spec is optional one-line guidance for the human/validator.
 *
 * Pure, no I/O. normalizeCriteria throws a CriteriaError naming the 1-based
 * criterion index on any refusal; validateCriteria wraps it as a result object.
 */

const { validateGate, validateFiles } = require('./prdGateFiles.cjs');

const CRITERIA_MAX = 100;
const STATEMENT_MAX_CHARS = 2000;
const ID_MAX_CHARS = 60;
const CONTAINS_MAX_CHARS = 500;
const MANUAL_SPEC_MAX_CHARS = 2000;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECK_KINDS = ['command', 'file', 'http', 'manual'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

class CriteriaError extends Error {
  /** @param {number} index 1-based criterion index (0 = the list itself) @param {string} message */
  constructor(index, message) {
    super(index > 0 ? `criteria entry ${index}: ${message}` : message);
    this.name = 'CriteriaError';
    this.index = index;
  }
}

function oneLine(value, max, what, idx) {
  if (typeof value !== 'string' || value.trim() === '') throw new CriteriaError(idx, `${what} must be a non-empty string.`);
  const s = value.trim();
  if (/[\r\n]/.test(s)) throw new CriteriaError(idx, `${what} must not contain a newline.`);
  if (s.length > max) throw new CriteriaError(idx, `${what} must be at most ${max} chars.`);
  return s;
}

function normalizeCommand(spec, idx) {
  const cmd = oneLine(spec, 1000, 'command check spec', idx);
  const v = validateGate([cmd]);
  if (!v.ok) throw new CriteriaError(idx, `command check spec is not a valid gate command: ${v.error}`);
  if (v.commands.length === 1 && v.commands[0] === 'none') {
    throw new CriteriaError(idx, 'command check spec must be a runnable command, not "none" (use a manual check).');
  }
  return v.commands[0];
}

function normalizeFile(spec, idx) {
  const obj = typeof spec === 'string' ? { path: spec } : spec;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new CriteriaError(idx, 'file check spec must be a repo-relative path or { path, contains? }.');
  }
  const extra = Object.keys(obj).filter((k) => k !== 'path' && k !== 'contains');
  if (extra.length) throw new CriteriaError(idx, `file check spec has unknown key(s): ${extra.join(', ')}.`);
  const p = oneLine(obj.path, 1000, 'file check path', idx);
  const v = validateFiles([p]);
  if (!v.ok) throw new CriteriaError(idx, `file check path is not a repo-relative path: ${v.error}`);
  const out = { path: v.files[0] };
  if (obj.contains !== undefined) out.contains = oneLine(obj.contains, CONTAINS_MAX_CHARS, 'file check contains', idx);
  return out;
}

function normalizeHttp(spec, idx) {
  const obj = typeof spec === 'string' ? { url: spec } : spec;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new CriteriaError(idx, 'http check spec must be a loopback URL or { url, status?, contains? }.');
  }
  const extra = Object.keys(obj).filter((k) => k !== 'url' && k !== 'status' && k !== 'contains');
  if (extra.length) throw new CriteriaError(idx, `http check spec has unknown key(s): ${extra.join(', ')}.`);
  const raw = oneLine(obj.url, 2000, 'http check url', idx);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CriteriaError(idx, 'http check url is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CriteriaError(idx, 'http check url must use http or https.');
  }
  if (url.username || url.password) throw new CriteriaError(idx, 'http check url must not carry credentials.');
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CriteriaError(idx, `http check url must be loopback only (localhost, 127.0.0.1 or [::1]); got host "${url.hostname}".`);
  }
  const status = obj.status === undefined ? 200 : obj.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new CriteriaError(idx, 'http check status must be an integer from 100 to 599.');
  }
  const out = { url: url.href, status };
  if (obj.contains !== undefined) out.contains = oneLine(obj.contains, CONTAINS_MAX_CHARS, 'http check contains', idx);
  return out;
}

function normalizeCheck(check, idx) {
  if (check === undefined || check === null) return { kind: 'manual' };
  if (typeof check !== 'object' || Array.isArray(check)) throw new CriteriaError(idx, 'check must be an object { kind, spec }.');
  const extra = Object.keys(check).filter((k) => k !== 'kind' && k !== 'spec');
  if (extra.length) throw new CriteriaError(idx, `check has unknown key(s): ${extra.join(', ')}.`);
  const { kind, spec } = check;
  if (!CHECK_KINDS.includes(kind)) {
    throw new CriteriaError(idx, `check kind must be one of ${CHECK_KINDS.join(', ')} (got ${JSON.stringify(kind)}).`);
  }
  if (kind === 'manual') {
    if (spec === undefined || spec === null) return { kind };
    return { kind, spec: oneLine(spec, MANUAL_SPEC_MAX_CHARS, 'manual check spec', idx) };
  }
  if (spec === undefined || spec === null) throw new CriteriaError(idx, `${kind} check needs a spec.`);
  if (kind === 'command') return { kind, spec: normalizeCommand(spec, idx) };
  if (kind === 'file') return { kind, spec: normalizeFile(spec, idx) };
  return { kind, spec: normalizeHttp(spec, idx) };
}

/**
 * @param {unknown} input array of string | { id?, statement, check? }
 * @param {{ previous?: unknown }} [opts] previous: the PRD's current normalized
 *   criteria (update path). An entry with no explicit id whose statement
 *   matches a previous criterion keeps that criterion's id, so re-sending the
 *   same lines in a new order or with one line added never renumbers the rest.
 *   A generated id that is already taken moves to the next free ac-<n>.
 * @returns {Array<{id: string, statement: string, check: {kind: string, spec?: unknown}}>}
 */
function normalizeCriteria(input, opts = {}) {
  const previousIds = new Map();
  if (Array.isArray(opts.previous)) {
    for (const p of opts.previous) {
      if (p && typeof p.id === 'string' && typeof p.statement === 'string' && !previousIds.has(p.statement)) {
        previousIds.set(p.statement, p.id);
      }
    }
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > CRITERIA_MAX) {
    throw new CriteriaError(0, `criteria must be an array of 1 to ${CRITERIA_MAX} entries.`);
  }
  const out = [];
  const seen = new Map();
  for (let i = 0; i < input.length; i++) {
    const idx = i + 1;
    const entry = input[i];
    let crit;
    if (typeof entry === 'string') {
      crit = { id: null, statement: oneLine(entry, STATEMENT_MAX_CHARS, 'statement', idx), check: { kind: 'manual' } };
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const extra = Object.keys(entry).filter((k) => k !== 'id' && k !== 'statement' && k !== 'check');
      if (extra.length) throw new CriteriaError(idx, `unknown key(s): ${extra.join(', ')}.`);
      let id = null;
      if (entry.id !== undefined) {
        if (typeof entry.id !== 'string' || !ID_RE.test(entry.id) || entry.id.length > ID_MAX_CHARS) {
          throw new CriteriaError(idx, `id must be a kebab-case id (a-z, 0-9, single dashes, at most ${ID_MAX_CHARS} chars).`);
        }
        id = entry.id;
      }
      crit = {
        id,
        statement: oneLine(entry.statement, STATEMENT_MAX_CHARS, 'statement', idx),
        check: normalizeCheck(entry.check, idx),
      };
    } else {
      throw new CriteriaError(idx, 'must be a string or an object { id?, statement, check? }.');
    }
    if (crit.id === null) {
      const reused = previousIds.get(crit.statement);
      if (reused && !seen.has(reused)) {
        crit.id = reused;
      } else {
        let n = idx;
        while (previousIds.size && (seen.has(`ac-${n}`) || reservedByPrevious(previousIds, `ac-${n}`, input, i))) n++;
        crit.id = `ac-${n}`;
      }
    }
    if (seen.has(crit.id)) {
      throw new CriteriaError(idx, `duplicate id "${crit.id}" (already used by entry ${seen.get(crit.id)}).`);
    }
    seen.set(crit.id, idx);
    out.push(crit);
  }
  return out;
}

/**
 * True when `id` belongs to a previous criterion whose statement appears
 * later in `input` (that later entry will reclaim it), so a generated id
 * must not take it first.
 */
function reservedByPrevious(previousIds, id, input, fromIndex) {
  for (let j = fromIndex + 1; j < input.length; j++) {
    const e = input[j];
    const stmt = typeof e === 'string' ? e.trim() : (e && typeof e === 'object' && e.id === undefined && typeof e.statement === 'string' ? e.statement.trim() : null);
    if (stmt !== null && previousIds.get(stmt) === id) return true;
  }
  return false;
}

/** Result-object wrapper for callers that accumulate errors (createPrd). */
function validateCriteria(input, opts) {
  try {
    return { ok: true, criteria: normalizeCriteria(input, opts) };
  } catch (e) {
    if (e instanceof CriteriaError) return { ok: false, error: e.message, index: e.index };
    throw e;
  }
}

/** One-line JSON for the PRD frontmatter `criteria:` key. */
function serializeCriteria(criteria) {
  return JSON.stringify(criteria);
}

/** `- [ ] <id>: <statement>` checklist lines for # Acceptance criteria. */
function renderCriteriaLines(criteria) {
  return criteria.map((c) => `- [ ] ${c.id}: ${c.statement}`);
}

module.exports = {
  normalizeCriteria,
  validateCriteria,
  serializeCriteria,
  renderCriteriaLines,
  CriteriaError,
  CHECK_KINDS,
};
