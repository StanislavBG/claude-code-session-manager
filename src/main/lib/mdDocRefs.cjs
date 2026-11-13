// @ts-check
'use strict';

/**
 * mdDocRefs — pure helpers for a markdown doc's currency and usage:
 *   - backtickPaths: the repo-path-shaped inline-code tokens a doc names;
 *   - assessRefs: which named paths no longer exist, and which existing files
 *     were committed after the doc last changed;
 *   - mentionPatterns / parseMentions: the fixed-string patterns for a
 *     `git grep -F -o --null` run and the parse of its output into
 *     doc -> code files that name it.
 * No fs, no git: all IO is injected (`exists`, `lastCommitOf`) or done by the
 * caller (scanMdNetwork). Fence/comment handling mirrors mdNetworkScan.cjs.
 */

const path = require('node:path');

const MAX_TOKENS = 200;
const MAX_CHANGED = 20;
const MAX_PATTERNS = 4000;

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(`+)(.{0,1024}?)\1/g;
const BAD_START_RE = /^(?:[/~$<]|http)/i;
const BAD_CHAR_RE = /[*{}<>:]/;
const EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * @typedef {{ fence: string, inComment: boolean }} LineState
 * @typedef {{ path: string, ms: number }} ChangedRef
 * @typedef {{
 *   docPath: string,
 *   linkTargets: string[],
 *   tokens: string[],
 *   docMs: number | null,
 *   exists: (repoPath: string) => boolean,
 *   lastCommitOf: (repoPath: string) => number | null | undefined,
 * }} AssessInput
 */

/** Drops HTML comments (which may span lines) from one line. @param {string} line @param {LineState} state */
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

/** One line outside fences, comments removed (inline code kept). @param {string} line @param {LineState} state */
function visibleLine(line, state) {
  const fence = state.inComment ? null : FENCE_RE.exec(line);
  if (state.fence) {
    if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && fence[2].trim() === '') {
      state.fence = '';
    }
    return '';
  }
  if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
    state.fence = fence[1];
    return '';
  }
  return stripComments(line, state);
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
    for (const m of visible.matchAll(INLINE_CODE_RE)) {
      const tok = pathToken(m[2]);
      if (tok === null || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= MAX_TOKENS) return out;
    }
  }
  return out;
}

/** Normalised repo path, or null when it escapes the repo. @param {string} p @returns {string | null} */
function repoPath(p) {
  const n = path.posix.normalize(p).replace(/\/+$/, '');
  if (n === '' || n === '.' || n === '..' || n.startsWith('../')) return null;
  return n;
}

/**
 * Dead refs (tokens that resolve nowhere) and existing file refs committed
 * after the doc (newest first, at most MAX_CHANGED).
 * @param {AssessInput} input
 * @returns {{ deadRefs: string[], changedSince: ChangedRef[] }}
 */
function assessRefs({ docPath, linkTargets, tokens, docMs, exists, lastCommitOf }) {
  const dir = path.posix.dirname(docPath);
  /** @type {string[]} */
  const deadRefs = [];
  const deadSeen = new Set();
  /** @type {string[]} */
  const fileRefs = [];
  const fileSeen = new Set();
  /** @param {string} p */
  const addFile = (p) => {
    if (p === docPath || fileSeen.has(p)) return;
    fileSeen.add(p);
    fileRefs.push(p);
  };
  for (const t of Array.isArray(linkTargets) ? linkTargets : []) {
    const p = typeof t === 'string' ? repoPath(t) : null;
    if (p) addFile(p);
  }
  for (const tok of Array.isArray(tokens) ? tokens : []) {
    if (typeof tok !== 'string' || tok === '') continue;
    const isFolder = tok.endsWith('/');
    const root = repoPath(tok);
    const local = dir === '.' ? null : repoPath(path.posix.join(dir, tok));
    const candidates = [root, local].filter((c) => c !== null);
    if (candidates.length === 0) continue;
    const hit = candidates.find((c) => exists(c));
    if (hit === undefined) {
      const dead = /** @type {string} */ (root ?? candidates[0]);
      if (!deadSeen.has(dead)) {
        deadSeen.add(dead);
        deadRefs.push(dead);
      }
      continue;
    }
    if (!isFolder) addFile(hit);
  }
  /** @type {ChangedRef[]} */
  const changed = [];
  for (const p of fileRefs) {
    const ms = lastCommitOf(p);
    if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
    if (docMs === null || docMs === undefined || ms > docMs) changed.push({ path: p, ms });
  }
  changed.sort((a, b) => b.ms - a.ms || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { deadRefs, changedSince: changed.slice(0, MAX_CHANGED) };
}

/**
 * Fixed-string patterns naming each doc: its full path, plus parent/basename
 * when the path has 3+ segments and no other doc shares that suffix.
 * @param {string[]} docPaths
 * @returns {{ patterns: string[], owner: Map<string, string> }}
 */
function mentionPatterns(docPaths) {
  const docs = [...new Set((Array.isArray(docPaths) ? docPaths : []).filter((p) => typeof p === 'string' && p !== ''))];
  /** @type {Map<string, Set<string>>} */
  const claims = new Map();
  /** @param {string} pattern @param {string} doc */
  const claim = (pattern, doc) => {
    const set = claims.get(pattern) ?? new Set();
    set.add(doc);
    claims.set(pattern, set);
  };
  /** @type {[string, string, boolean][]} pattern, doc, isSuffix */
  const ordered = [];
  for (const doc of docs) {
    claim(doc, doc);
    ordered.push([doc, doc, false]);
    const segs = doc.split('/');
    if (segs.length >= 3) {
      const suffix = segs.slice(-2).join('/');
      claim(suffix, doc);
      ordered.push([suffix, doc, true]);
    }
  }
  /** @type {string[]} */
  const patterns = [];
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const [pattern, doc, isSuffix] of ordered) {
    if (patterns.length >= MAX_PATTERNS) break;
    if (owner.has(pattern)) continue;
    if (isSuffix && /** @type {Set<string>} */ (claims.get(pattern)).size >= 2) continue;
    patterns.push(pattern);
    owner.set(pattern, doc);
  }
  return { patterns, owner };
}

/**
 * Parse `git grep --no-color -I -F -o --null -e <p>...` output ('<file>\0<match>'
 * per line) into doc path -> distinct code files, first-seen order. Never throws.
 * @param {string} stdout
 * @param {Map<string, string>} owner
 * @returns {Map<string, string[]>}
 */
function parseMentions(stdout, owner) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  if (typeof stdout !== 'string' || !(owner instanceof Map)) return out;
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  for (const line of stdout.split('\n')) {
    const nul = line.indexOf('\0');
    if (nul < 1) continue;
    const file = line.slice(0, nul);
    const doc = owner.get(line.slice(nul + 1).replace(/\r$/, ''));
    if (doc === undefined) continue;
    let files = seen.get(doc);
    if (!files) {
      files = new Set();
      seen.set(doc, files);
      out.set(doc, []);
    }
    if (files.has(file)) continue;
    files.add(file);
    /** @type {string[]} */ (out.get(doc)).push(file);
  }
  return out;
}

module.exports = { backtickPaths, assessRefs, mentionPatterns, parseMentions };
