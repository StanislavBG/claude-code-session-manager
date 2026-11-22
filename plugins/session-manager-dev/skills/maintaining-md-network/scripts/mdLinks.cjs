// @ts-check
'use strict';

/**
 * mdLinks.cjs — the single definition of the markdown link convention named in
 * the maintaining-md-network SKILL.md section "What counts as a link": inline
 * `[text](target)` links (images too) and `<target.md>` autolinks, `@path.md`
 * imports and backticked repo paths — all outside code fences and HTML
 * comments (links and imports also outside inline code).
 *
 * The app requires this file from src/main, and the skill's own scripts require
 * it too, so it MUST stay dependency-free: node built-ins only.
 *
 * - linksOf(file) — a doc's followed links, in document order (memoized per file object).
 * - followLink(from, raw, line) — one raw link target -> followed link, or null when ignored.
 * - visibleText(line, state) — the part of one line that can hold links.
 * - importsOf(text, fromPath) — the `@path.md` imports a doc makes, resolved against its folder.
 * - backtickPaths(text) — the path-shaped inline-code tokens a doc names.
 * - toRepoPath(p) — repo-relative POSIX form.
 *
 * For links, ignored: any `scheme:` target, `/absolute` and `//host` targets, and
 * `#anchor`-only links; `#fragment` and `?query` are stripped and the rest
 * resolves against the linking doc's folder.
 */

const path = require('node:path');

/** Longest link destination or title scanned, so a pathological line stays linear. */
const MAX_LINK_CHARS = 1024;
/** Most backticked path tokens returned per doc. */
const MAX_TOKENS = 200;

const MD_RE = /\.md$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(`+).{0,1024}?\1/g;
const INLINE_CODE_TOKEN_RE = /(`+)(.{0,1024}?)\1/g;
const AUTOLINK_RE = /<([^<>\s]{1,1024})>/g;
const IMPORT_RE = /(^|\s)@(\S+)/g;
const TRAILING_PUNCT_RE = /[),.;:!?'"\]]+$/;
const BAD_START_RE = /^(?:[/~$<]|http)/i;
const BAD_CHAR_RE = /[*{}<>:]/;
const EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * @typedef {{ path: string, text: string }} MdFile a doc: repo-relative POSIX path + text
 * @typedef {{ line: number, target: string, to: string, escapes: boolean }} MdLink
 *   `target` as written (fragment/query stripped); `to` resolved repo-relative
 * @typedef {{ fence: string, inComment: boolean }} LineState an open code fence / HTML comment
 */

/** Repo-relative POSIX form: no `./` or trailing `/`; `.` is the root folder. @param {string} p */
function toRepoPath(p) {
  return path.posix.normalize(p).replace(/\/+$/, '') || '.';
}

/** @param {string} s @param {number} i @returns {number} the first index at or after `i` that is not a space/tab */
function skipBlanks(s, i) {
  while (s[i] === ' ' || s[i] === '\t') i += 1;
  return i;
}

/** @param {string} s @param {string} ch @param {number} from @returns {number} `ch`'s index within MAX_LINK_CHARS, or -1 */
function indexWithin(s, ch, from) {
  const i = s.slice(from, from + MAX_LINK_CHARS).indexOf(ch);
  return i === -1 ? -1 : from + i;
}

/**
 * Parses an inline link's destination (+ optional title) starting just after `](`.
 * @param {string} s
 * @param {number} start
 * @returns {{ target: string, end: number } | null} the raw target and the index after `)`
 */
function parseDestination(s, start) {
  let j = skipBlanks(s, start);
  let target;
  if (s[j] === '<') {
    const close = indexWithin(s, '>', j + 1);
    if (close === -1) return null;
    target = s.slice(j + 1, close);
    j = close + 1;
  } else {
    const from = j;
    const limit = Math.min(s.length, from + MAX_LINK_CHARS);
    let depth = 0;
    for (; j < limit; j += 1) {
      const c = s[j];
      if (c === ' ' || c === '\t') break;
      if (c === '(') depth += 1;
      else if (c === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (j === limit && j < s.length) return null;
    target = s.slice(from, j);
  }
  j = skipBlanks(s, j);
  const quote = s[j];
  if (quote === '"' || quote === "'" || quote === '(') {
    const close = indexWithin(s, quote === '(' ? ')' : quote, j + 1);
    if (close === -1) return null;
    j = skipBlanks(s, close + 1);
  }
  return s[j] === ')' ? { target, end: j + 1 } : null;
}

/** Raw targets of one line's inline links, then of its `<x.md>` autolinks. @param {string} s @returns {string[]} */
function lineTargets(s) {
  /** @type {string[]} */
  const targets = [];
  let outside = ''; // the line minus its inline links, so `[x](<a.md>)` is not also an autolink
  let last = 0;
  for (let i = s.indexOf(']('); i !== -1; ) {
    const dest = parseDestination(s, i + 2);
    if (dest) {
      targets.push(dest.target);
      outside += `${s.slice(last, i)} `;
      last = dest.end;
      i = s.indexOf('](', dest.end);
    } else {
      i = s.indexOf('](', i + 2);
    }
  }
  outside += s.slice(last);
  for (const m of outside.matchAll(AUTOLINK_RE)) {
    if (MD_RE.test(m[1].replace(/[?#].*$/, ''))) targets.push(m[1]);
  }
  return targets;
}

/**
 * Drops HTML comments (which may span lines) from one line. The one copy shared
 * by visibleText (links) and visibleLine (backticked paths).
 * @param {string} line @param {LineState} state
 */
function stripComments(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inComment) {
      const close = line.indexOf('-->', i);
      if (close === -1) return out;
      state.inComment = false;
      i = close + 3;
    } else {
      const open = line.indexOf('<!--', i);
      if (open === -1) return out + line.slice(i);
      out += `${line.slice(i, open)} `;
      state.inComment = true;
      i = open + 4;
    }
  }
  return out;
}

/**
 * Advances fence state for one line. @param {string} line @param {LineState} state
 * @returns {boolean} true when the line is a fence line or inside a fence (nothing visible)
 */
function fenced(line, state) {
  const fence = state.inComment ? null : FENCE_RE.exec(line);
  if (state.fence) {
    if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && fence[2].trim() === '') {
      state.fence = '';
    }
    return true;
  }
  if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
    state.fence = fence[1];
    return true;
  }
  return false;
}

/** The part of one line that can hold links. @param {string} line @param {LineState} state @returns {string} */
function visibleText(line, state) {
  if (fenced(line, state)) return '';
  return stripComments(line.replace(INLINE_CODE_RE, ' '), state);
}

/** One line outside fences, comments removed (inline code kept). @param {string} line @param {LineState} state */
function visibleLine(line, state) {
  if (fenced(line, state)) return '';
  return stripComments(line, state);
}

/**
 * The followed link for one raw target written in doc `from`, or null when ignored.
 * @param {string} from @param {string} raw @param {number} line 1-based
 * @returns {MdLink | null}
 */
function followLink(from, raw, line) {
  const written = raw.trim();
  if (written === '' || written[0] === '#' || written[0] === '/' || SCHEME_RE.test(written)) return null;
  const target = written.replace(/[?#].*$/, '');
  if (target === '') return null;
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // a stray `%` is part of the file name
  }
  const to = toRepoPath(path.posix.join(path.posix.dirname(from), decoded));
  return { line, target, to, escapes: to === '..' || to.startsWith('../') };
}

/**
 * Memo for linksOf: callers may walk the docs more than once, so each doc is
 * parsed once. File objects are treated as immutable.
 * @type {WeakMap<MdFile, MdLink[]>}
 */
const linkMemo = new WeakMap();

/** A doc's followed links, in document order. @param {MdFile} file @returns {MdLink[]} */
function linksOf(file) {
  const memo = linkMemo.get(file);
  if (memo) return memo;
  const from = toRepoPath(file.path);
  /** @type {MdLink[]} */
  const links = [];
  /** @type {LineState} */
  const state = { fence: '', inComment: false };
  const lines = file.text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n += 1) {
    const visible = visibleText(lines[n], state);
    if (visible === '') continue;
    for (const raw of lineTargets(visible)) {
      const link = followLink(from, raw, n + 1);
      if (link) links.push(link);
    }
  }
  linkMemo.set(file, links);
  return links;
}

/**
 * The `@path.md` imports in `text`, outside fenced and inline code, resolved
 * against `fromPath`'s folder. Skips `@~/...`, absolute and escaping targets.
 * (HTML comments are not stripped here — as in mdDocCensus.cjs importsOf.)
 * @param {string} text @param {string} fromPath @returns {string[]}
 */
function importsOf(text, fromPath) {
  if (typeof text !== 'string' || typeof fromPath !== 'string') return [];
  const dir = path.posix.dirname(fromPath);
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  let fence = '';
  for (const line of text.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && f[2].trim() === '') fence = '';
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      continue;
    }
    const visible = line.replace(INLINE_CODE_RE, ' ');
    for (const m of visible.matchAll(IMPORT_RE)) {
      const target = m[2].replace(TRAILING_PUNCT_RE, '');
      if (!MD_RE.test(target) || target.startsWith('~') || target.startsWith('/')) continue;
      const resolved = path.posix.normalize(path.posix.join(dir, target));
      if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

/** The repo-path form of one inline-code token, or null. @param {string} raw @returns {string | null} */
function pathToken(raw) {
  const t = raw.trim();
  if (t === '' || !t.includes('/') || /\s/.test(t) || BAD_START_RE.test(t)) return null;
  const bare = t.replace(/:\d+$/, '').replace(/#.*$/, '');
  if (bare === '' || BAD_CHAR_RE.test(bare)) return null;
  if (!bare.endsWith('/') && !EXT_RE.test(bare)) return null;
  return bare;
}

/**
 * Distinct path-shaped inline-code tokens outside fenced code and HTML comments,
 * in document order, at most MAX_TOKENS. O(text length).
 * @param {string} text
 * @returns {string[]}
 */
function backtickPaths(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {LineState} */
  const state = { fence: '', inComment: false };
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const visible = visibleLine(line, state);
    if (visible === '' || !visible.includes('`')) continue;
    for (const m of visible.matchAll(INLINE_CODE_TOKEN_RE)) {
      const tok = pathToken(m[2]);
      if (tok === null || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= MAX_TOKENS) return out;
    }
  }
  return out;
}

module.exports = { linksOf, followLink, visibleText, importsOf, backtickPaths, toRepoPath };
