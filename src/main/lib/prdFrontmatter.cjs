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
 * estimateMinutes, parallelGroup, sourcePromptId, sourceTabId, tag); every
 * other frontmatter key (e.g. dependsOn) round-trips via `extras`, same as
 * the renderer's editor today.
 */

const RECOGNIZED_KEYS = new Set(['title', 'cwd', 'estimateMinutes', 'parallelGroup', 'sourcePromptId', 'sourceTabId', 'tag']);
const EMIT_ORDER = ['title', 'cwd', 'estimateMinutes', 'parallelGroup', 'sourcePromptId', 'sourceTabId', 'tag'];
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
      // Matches the TS source's applyKey exactly: a 'discussion'-tagged
      // ticket never reaches PRD authoring, so that value is never parsed
      // here even if present in a hand-edited file — see this file's header
      // comment.
      if (v === 'feature' || v === 'bug' || v === 'build') fm.tag = v;
      return;
  }
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
      const parsed = parseScalar(after);
      if (parsed !== null && (typeof parsed === 'string' || typeof parsed === 'number')) {
        if (!fm._raw) fm._raw = {};
        fm._raw[key] = { line, parsed };
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
    const cached = fm._raw?.[key];
    if (cached && cached.parsed === v) {
      out.push(cached.line);
      continue;
    }
    if (typeof v === 'number') {
      out.push(`${key}: ${v}`);
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

module.exports = { splitFrontmatter, parsePrdFile, serializePrdFile, RECOGNIZED_KEYS };
