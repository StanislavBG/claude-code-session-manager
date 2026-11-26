/**
 * prdFrontmatter.cjs — minimal YAML frontmatter parser for scheduled PRD files.
 *
 * PRDs at `~/.claude/session-manager/scheduled-plans/prds/<NN>-<slug>.md` use
 * a small documented frontmatter subset (title, cwd, estimateMinutes,
 * parallelGroup, …). Two callers used to roll their own parser:
 *   - scheduler.cjs::parsePrdRaw — typed extraction of the known keys
 *   - queueOps.cjs::splitFrontmatter — linting; needs the raw map plus the
 *     line-count of the frontmatter region so warnings point at the right line
 *
 * This module owns the parse. Callers transform the raw map into whatever
 * typed shape they need.
 *
 * Format:
 *   ---
 *   key: value
 *   ---
 *   body…
 *
 * - Keys must match /^[A-Za-z][A-Za-z0-9_]*$/ (alpha first; alphanum + _).
 * - Values are read as strings; surrounding ' or " quotes are stripped.
 * - Missing or malformed frontmatter → { fm: {}, body: raw, fmLineCount: 0 }.
 */
'use strict';

const { PRD_WORK_TYPES } = require('./workTypeLibrary.cjs');

const PRD_TAG_VALUES = new Set(PRD_WORK_TYPES);

function splitFrontmatter(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('---\n')) {
    return { fm: {}, body: raw, fmLineCount: 0 };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { fm: {}, body: raw, fmLineCount: 0 };
  const fmRaw = raw.slice(4, end);
  const fm = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[m[1]] = v;
  }
  return {
    fm,
    body: raw.slice(end + 4).replace(/^\n/, ''),
    // +2 for the two `---` fences themselves
    fmLineCount: fmRaw.split('\n').length + 2,
  };
}

/**
 * parsePrdFile / serializePrdFile — CJS port of
 * src/renderer/lib/prdFrontmatter.ts's round-trip parse+serialize pair, so
 * main-process callers (the admin update-prd route, PRD 1024) get the same
 * "unrecognized keys round-trip verbatim via `extras`, recognized keys emit
 * in a stable order, unchanged values re-emit their original line verbatim"
 * guarantee the renderer's PRD editor already relies on — an edit through
 * either surface never reorders or drops a key it didn't touch. Recognized
 * key set intentionally mirrors the TS module exactly (title, cwd,
 * estimateMinutes, parallelGroup, sourcePromptId, sourceTabId, tag,
 * agentType, createdVia, issuedAt, dependsOn); every other frontmatter key
 * round-trips via `extras`, same as the renderer's editor today.
 *
 * `createdVia`/`issuedAt` (PRD provenance-lockdown) are recognized here so
 * the update-prd route (the only sanctioned way to stamp a PRD's provenance
 * after creation — see prdCreate.cjs's buildPrdBody for the create-time
 * stamp) round-trips them like any other known key rather than shunting them
 * into `extras`.
 *
 * `dependsOn` (PRD 1124) is the first ARRAY-valued recognized key — parsed/
 * emitted only in its inline `[a, b]` list form (the sole form prdCreate.cjs
 * ever writes; block-style YAML lists are out of scope). An empty array is
 * never emitted, which is how `scheduler_update_prd` clears a dependency.
 *
 * `fixes` (the earlier PRDs this one repairs) is a one-line JSON array of
 * { prd, missKind, reason } — see parseFixes.
 *
 * `criteria` (structured acceptance criteria, prdCriteria.cjs) is a one-line
 * JSON array of { id, statement, check: { kind, spec? } } — see parseCriteria.
 */

const RECOGNIZED_KEYS = new Set(['title', 'cwd', 'estimateMinutes', 'parallelGroup', 'sourcePromptId', 'sourceTabId', 'tag', 'agentType', 'createdVia', 'issuedAt', 'dependsOn', 'fixes', 'quietMachine', 'disposition', 'planId', 'deliverable', 'artifactPaths', 'macroId', 'effort', 'voiceId', 'riskTools', 'preflight', 'criteria', 'planReview']);
const EMIT_ORDER = ['title', 'cwd', 'estimateMinutes', 'parallelGroup', 'sourcePromptId', 'sourceTabId', 'tag', 'agentType', 'createdVia', 'issuedAt', 'dependsOn', 'fixes', 'quietMachine', 'disposition', 'planId', 'deliverable', 'artifactPaths', 'macroId', 'effort', 'voiceId', 'riskTools', 'preflight', 'criteria', 'planReview'];
// Mirrors modelCatalog.cjs CATALOG_FLOOR.effortLevels. A closed set so the
// value is always safe as a frontmatter line and as a --effort argv token.
const PRD_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// Voice-library id (in-process only, like effort); the one owner is voiceLibrary.cjs.
const { VOICE_ID_RE } = require('../demo-video-kit/voiceLibrary.cjs');
const MACRO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 2;
    else break;
  }
  return n;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the inline `[a, b]` list form used by `dependsOn` — the sole form
 * prdCreate.cjs's buildPrdBody ever writes. Returns null (not recognized as
 * a list) when `raw` isn't bracketed, so a hand-edited non-list value is
 * left unset rather than mis-parsed.
 */
function parseInlineList(raw) {
  const v = raw.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) return null;
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter((s) => s.length > 0);
}

/**
 * Quote-aware inline list for `riskTools` — tool-risk rule strings carry
 * parentheses, spaces, colons and sometimes commas (`Bash(echo a,b)`), so a
 * plain comma split cannot carry them. An entry that would be ambiguous bare
 * (comma, bracket, quote, `#`, edge whitespace) is written as a JSON string;
 * every other entry is written bare, so `riskTools: [a, b]` reads as ['a','b'].
 * Returns null when `raw` isn't a well-formed bracketed list.
 */
function parseQuotedInlineList(raw) {
  const v = String(raw ?? '').trim();
  if (!v.startsWith('[') || !v.endsWith(']')) return null;
  const inner = v.slice(1, -1);
  const out = [];
  let i = 0;
  const skipWs = () => { while (i < inner.length && /\s/.test(inner[i])) i++; };
  skipWs();
  if (i === inner.length) return [];
  for (;;) {
    skipWs();
    let item;
    if (inner[i] === '"') {
      let j = i + 1;
      while (j < inner.length && inner[j] !== '"') j += inner[j] === '\\' ? 2 : 1;
      if (j >= inner.length) return null;
      try { item = JSON.parse(inner.slice(i, j + 1)); } catch { return null; }
      i = j + 1;
      skipWs();
      if (i < inner.length && inner[i] !== ',') return null;
    } else {
      const j = inner.indexOf(',', i);
      const end = j === -1 ? inner.length : j;
      item = inner.slice(i, end).trim();
      i = end;
    }
    if (item.length > 0) out.push(item);
    if (i >= inner.length) break;
    i++; // past ','
  }
  return out;
}

function formatQuotedInlineList(list) {
  const enc = (s) => (/[,\[\]"'#]|^\s|\s$/.test(s) ? JSON.stringify(s) : s);
  return `[${list.map(enc).join(', ')}]`;
}

/**
 * The one definition of an artifact-only PRD: `deliverable: artifact` plus a
 * non-empty `artifactPaths` list. Used by runVerify's artifact exemption,
 * executeJob's finish-protocol variant and the scheduler's queue-row checks —
 * keep every caller on this predicate so the copies cannot drift apart.
 *
 * @param {{ deliverable?: unknown, artifactPaths?: unknown } | null | undefined} decl
 * @returns {boolean}
 */
function isArtifactOnlyDeclaration(decl) {
  if (decl == null || typeof decl !== 'object') return false;
  return decl.deliverable === 'artifact'
    && Array.isArray(decl.artifactPaths)
    && decl.artifactPaths.length > 0;
}

/**
 * Parse the `fixes` value — a one-line JSON array of { prd, missKind, reason }
 * (the sole form prdCreate.cjs's buildPrdBody writes). Returns null for anything
 * else (not JSON, not an array, or an entry missing a string field), so a
 * hand-mangled value is left unset rather than half-parsed.
 */
function parseFixes(raw) {
  const v = String(raw ?? '').trim();
  if (!v.startsWith('[')) return null;
  let arr;
  try { arr = JSON.parse(v); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const e of arr) {
    if (e == null || typeof e !== 'object' || Array.isArray(e)) return null;
    if (typeof e.prd !== 'string' || typeof e.missKind !== 'string' || typeof e.reason !== 'string') return null;
    out.push({ prd: e.prd, missKind: e.missKind, reason: e.reason });
  }
  return out;
}

/**
 * Parse the `criteria` value — a one-line JSON array of { id, statement,
 * check: { kind, spec? } } (the sole form prdCreate.cjs writes; shape rules
 * live in prdCriteria.cjs, not required here because definitionOfDone.cjs ->
 * this file would cycle). Returns null for anything malformed.
 */
function parseCriteria(raw) {
  const v = String(raw ?? '').trim();
  if (!v.startsWith('[')) return null;
  let arr;
  try { arr = JSON.parse(v); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  for (const e of arr) {
    if (e == null || typeof e !== 'object' || Array.isArray(e)) return null;
    if (typeof e.id !== 'string' || typeof e.statement !== 'string') return null;
    if (e.check == null || typeof e.check !== 'object' || typeof e.check.kind !== 'string') return null;
  }
  return arr;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function applyKey(fm, key, after) {
  const v = parseScalar(after);
  if (v === null) return;
  switch (key) {
    case 'estimateMinutes':
      fm.estimateMinutes = typeof v === 'number' ? v : Number(v);
      return;
    case 'parallelGroup':
      fm.parallelGroup = typeof v === 'number' ? v : Number(v);
      return;
    case 'title':
      fm.title = String(v);
      return;
    case 'cwd':
      fm.cwd = String(v);
      return;
    case 'sourcePromptId':
      fm.sourcePromptId = String(v);
      return;
    case 'sourceTabId':
      fm.sourceTabId = String(v);
      return;
    case 'tag':
      // Matches the TS source's applyKey exactly — see PRD_TAG_VALUES above.
      if (PRD_TAG_VALUES.has(v)) fm.tag = v;
      return;
    case 'agentType':
      // WHO executes this PRD — a persona name, not a closed enum (the
      // Agent Library is user-editable). FK resolution against the Agent
      // Library happens in prdAgentType.cjs, not here — this parser only
      // round-trips the string.
      fm.agentType = String(v);
      return;
    case 'planReview':
      if (String(v) === 'required') fm.planReview = 'required';
      return;
    case 'createdVia':
      fm.createdVia = String(v);
      return;
    case 'issuedAt':
      fm.issuedAt = String(v);
      return;
    case 'dependsOn': {
      // Only the inline `[a, b]` list form is recognized (see parseInlineList's
      // header) — a malformed/hand-edited non-list value is left unset.
      const list = parseInlineList(after);
      if (list) fm.dependsOn = list;
      return;
    }
    case 'fixes': {
      const list = parseFixes(after);
      if (list && list.length) fm.fixes = list;
      return;
    }
    case 'criteria': {
      const list = parseCriteria(after);
      if (list && list.length) fm.criteria = list;
      return;
    }
    case 'quietMachine':
      // Opt-in exclusive-lease flag (PRD 1107) — only a literal `true`
      // frontmatter value opts in; anything else (including an explicit
      // `false`) is treated as "not set" so the field never round-trips as
      // a no-op line for the overwhelming majority of PRDs that omit it.
      if (v === true) fm.quietMachine = true;
      return;
    case 'planId':
      // Durable wave identity stamped by createPrd(); a garbage value is dropped.
      if (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v)) fm.planId = v;
      return;
    case 'disposition':
      // Wave-authoring decision ('append'/'new-head') — see
      // src/renderer/lib/prdFrontmatter.ts's mirror of this field for the
      // full rationale. Only these two values are recognized.
      if (v === 'append' || v === 'new-head') fm.disposition = v;
      return;
    case 'deliverable':
      // Artifact-only PRD declaration — only the literal `artifact` is
      // recognized; anything else is dropped so a typo can never opt in.
      if (v === 'artifact') fm.deliverable = v;
      return;
    case 'macroId':
      // Id of the macro whose press dispatched this PRD; anything off-pattern is dropped.
      if (typeof v === 'string' && MACRO_ID_RE.test(v.trim())) fm.macroId = v.trim();
      return;
    case 'effort':
      // In-process-only per-PRD effort override; anything outside PRD_EFFORT_LEVELS is dropped.
      if (typeof v === 'string' && PRD_EFFORT_LEVELS.includes(v.trim())) fm.effort = v.trim();
      return;
    case 'voiceId':
      // In-process-only per-PRD library voice; anything off VOICE_ID_RE is dropped.
      if (typeof v === 'string' && VOICE_ID_RE.test(v.trim())) fm.voiceId = v.trim();
      return;
    case 'artifactPaths': {
      // Inline `[a, b]` list, same shape as dependsOn.
      const list = parseInlineList(after);
      if (list) fm.artifactPaths = list;
      return;
    }
    case 'riskTools': {
      // Quote-aware inline list (rule strings can hold commas) — see parseQuotedInlineList.
      const list = parseQuotedInlineList(after);
      if (list) fm.riskTools = list;
      return;
    }
    case 'preflight': {
      // One-line precondition command (preflightCheck.cjs). Written as a JSON
      // string so quotes/`#` inside a command survive; a bare hand-written
      // value is read as-is.
      const s = parsePreflightValue(after);
      if (s) fm.preflight = s;
      return;
    }
  }
}

function parsePreflightValue(raw) {
  const t = String(raw ?? '').trim();
  if (t.startsWith('"')) {
    try {
      const j = JSON.parse(t);
      if (typeof j === 'string') return j.trim() || null;
    } catch { /* fall through to the bare form */ }
  }
  const s = t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1) : t;
  return s.trim() || null;
}

/** Parse a full PRD file into { frontmatter, body }, same shape as the TS module. */
function parsePrdFile(text) {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: text };
  const fmText = m[1];
  const body = m[2] ?? '';

  const lines = fmText.split(/\r?\n/);
  const fm = {};
  const extras = {};

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) { i++; continue; }
    const ind = indentOf(line);
    if (ind !== 0) { i++; continue; }
    const colon = line.indexOf(':');
    if (colon < 0) { i++; continue; }
    const key = line.slice(0, colon).trim();
    const after = line.slice(colon + 1);
    let j = i + 1;
    const band = [line];
    while (j < lines.length) {
      const nxt = lines[j];
      if (nxt.trim() === '' || nxt.trimStart().startsWith('#')) { band.push(nxt); j++; continue; }
      if (indentOf(nxt) === 0 && nxt.indexOf(':') >= 0) break;
      band.push(nxt);
      j++;
    }

    if (RECOGNIZED_KEYS.has(key)) {
      applyKey(fm, key, after);
      if (key === 'dependsOn' || key === 'artifactPaths' || key === 'fixes' || key === 'riskTools' || key === 'preflight' || key === 'criteria') {
        if (fm[key]) {
          if (!fm._raw) fm._raw = {};
          fm._raw[key] = { line, parsed: fm[key] };
        }
      } else {
        const parsed = parseScalar(after);
        if (parsed !== null && (typeof parsed === 'string' || typeof parsed === 'number')) {
          if (!fm._raw) fm._raw = {};
          fm._raw[key] = { line, parsed };
        }
      }
    } else {
      extras[key] = { lines: band };
    }
    i = j;
  }

  if (Object.keys(extras).length) fm.extras = extras;
  return { frontmatter: fm, body };
}

function serializeScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  const needsQuote =
    s === '' ||
    /^(true|false|null|~)$/.test(s) ||
    /^-?\d+(\.\d+)?$/.test(s) ||
    /^\s|\s$/.test(s) ||
    s.startsWith("'") ||
    s.startsWith('"') ||
    s.includes('\n');
  if (!needsQuote) return s;
  if (s.includes("'")) return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s}'`;
}

/** Serialize { frontmatter, body } back to a full file. Byte-identical round-trip when unchanged. */
function serializePrdFile(fm, body) {
  const out = [];
  for (const key of EMIT_ORDER) {
    const v = fm[key];
    if (v === undefined || v === null || v === '') continue;
    // An empty dependsOn array is how scheduler_update_prd CLEARS the
    // dependency — never emitted, same as an absent key.
    if (Array.isArray(v) && v.length === 0) continue;
    const cached = fm._raw?.[key];
    if (key === 'criteria') {
      const line = `criteria: ${JSON.stringify(v)}`;
      out.push(cached && cached.line.trim() === line ? cached.line : line);
      continue;
    }
    if (key === 'fixes') {
      const line = `fixes: ${JSON.stringify(v.map((f) => ({ prd: f.prd, missKind: f.missKind, reason: f.reason })))}`;
      out.push(cached && cached.line.trim() === line ? cached.line : line);
      continue;
    }
    if (cached && (Array.isArray(v) ? arraysEqual(cached.parsed, v) : cached.parsed === v)) {
      out.push(cached.line);
      continue;
    }
    if (typeof v === 'number') {
      out.push(`${key}: ${v}`);
      continue;
    }
    if (key === 'riskTools') {
      out.push(`${key}: ${formatQuotedInlineList(v)}`);
      continue;
    }
    if (key === 'preflight') {
      out.push(`${key}: ${JSON.stringify(String(v))}`);
      continue;
    }
    if (Array.isArray(v)) {
      out.push(`${key}: [${v.join(', ')}]`);
      continue;
    }
    out.push(`${key}: ${serializeScalar(v)}`);
  }
  if (fm.extras) {
    for (const k of Object.keys(fm.extras)) {
      const band = fm.extras[k];
      if (!band || !band.lines.length) continue;
      out.push(band.lines.join('\n'));
    }
  }

  const fmText = out.join('\n');
  return `---\n${fmText}\n---\n${body}`;
}

module.exports = {
  splitFrontmatter,
  parsePreflightValue,
  parsePrdFile,
  serializePrdFile,
  parseInlineList,
  parseQuotedInlineList,
  formatQuotedInlineList,
  parseFixes,
  parseCriteria,
  isArtifactOnlyDeclaration,
  RECOGNIZED_KEYS,
  PRD_EFFORT_LEVELS,
};
