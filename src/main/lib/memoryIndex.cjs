'use strict';

/**
 * Pure helpers for Claude Code's auto-memory index file (MEMORY.md): one line
 * per memory, `- [Title](file.md) — hook`. Claude Code loads only the first
 * 200 lines / 25KB of it per session, so an unlisted memory is invisible.
 * No fs/electron access; callers pass text in and write text out.
 *
 * Top-level (not in a lib/ subfolder) to sit beside its sibling memoryStale.cjs.
 */

const MAX_LINES = 200;
const MAX_BYTES = 25600;
const NEAR_LINES = 180;
const NEAR_BYTES = 23040;

// `- [Title](name.md)` with optional ` — hook` / ` - hook`. Bare file names only
// (no path separators), so links into subfolders or URLs never match.
const LINE_RE = /^\s*[-*]\s+\[([^\]]*)\]\(([^)\s/\\]+\.md)\)(?:\s+(?:—|-)\s+(.*?))?\s*$/;

/** Split into lines; a trailing newline does not add a line. */
function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function matchLine(raw) {
  return LINE_RE.exec(raw.replace(/\r$/, ''));
}

/**
 * Parse index link lines. Complexity: O(lines).
 * @param {string|null} text
 * @returns {{line: string, lineNo: number, title: string, file: string, hook: string}[]}
 */
function parseIndex(text) {
  const out = [];
  splitLines(text).forEach((raw, i) => {
    const m = matchLine(raw);
    if (!m) return;
    out.push({ line: raw.replace(/\r$/, ''), lineNo: i + 1, title: m[1], file: m[2], hook: m[3] || '' });
  });
  return out;
}

/**
 * Append an index line unless `file` is already linked. Complexity: O(lines).
 * @param {string|null} text
 * @param {{file: string, title: string, hook?: string}} entry
 * @returns {string}
 */
function addIndexLine(text, { file, title, hook }) {
  const base = typeof text === 'string' ? text : '';
  if (parseIndex(base).some((e) => e.file === file)) return base;
  const line = `- [${title}](${file})${hook ? ` — ${hook}` : ''}`;
  const trimmed = base.replace(/(\r?\n)+$/, '');
  return `${trimmed === '' ? '' : `${trimmed}\n`}${line}\n`;
}

/**
 * Remove every line linking to `file`; other lines are untouched.
 * Complexity: O(lines).
 * @param {string|null} text
 * @param {string} file
 * @returns {string}
 */
function removeIndexLines(text, file) {
  if (typeof text !== 'string' || text === '') return '';
  const parts = text.split('\n');
  const hadTrailing = parts[parts.length - 1] === '';
  if (hadTrailing) parts.pop();
  const kept = parts.filter((raw) => {
    const m = matchLine(raw);
    return !(m && m[2] === file);
  });
  return kept.length === 0 ? '' : kept.join('\n') + (hadTrailing ? '\n' : '');
}

/**
 * Index budget + consistency report. Complexity: O((lines + files) log n).
 * @param {{indexText: string|null, files: string[]}} args
 */
function indexHealth({ indexText, files }) {
  const text = typeof indexText === 'string' ? indexText : '';
  const lines = splitLines(text).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  const overBudget = lines > MAX_LINES || bytes > MAX_BYTES;
  const nearBudget = !overBudget && (lines >= NEAR_LINES || bytes >= NEAR_BYTES);
  const present = new Set((files || []).filter((f) => f !== 'MEMORY.md'));
  const linked = new Set(parseIndex(text).map((e) => e.file));
  const orphans = [...present].filter((f) => !linked.has(f)).sort();
  const dangling = [...linked].filter((f) => f !== 'MEMORY.md' && !present.has(f)).sort();
  return { lines, bytes, maxLines: MAX_LINES, maxBytes: MAX_BYTES, overBudget, nearBudget, orphans, dangling };
}

module.exports = { parseIndex, addIndexLine, removeIndexLines, indexHealth };
