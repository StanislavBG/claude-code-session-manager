// @ts-check
'use strict';

/**
 * mdDocRefs — pure helpers for a markdown doc's currency and usage:
 *   - backtickPaths: the repo-path-shaped inline-code tokens a doc names;
 *   - assessRefs: which named paths no longer exist (dead), which name 2+
 *     tracked paths by suffix (ambiguous), and which existing files were
 *     committed after the doc last changed;
 *   - suffixIndex: a resolver from a shorthand token (`lib/x.ts`) to the
 *     tracked paths it names (`src/renderer/lib/x.ts`), built once per scan;
 *   - mentionPatterns / parseMentions: the fixed-string patterns for a
 *     `git grep -F -o --null` run and the parse of its output into
 *     doc -> code files that name it.
 * No fs, no git: all IO is injected (`exists`, `lastCommitOf`, `ignored`) or done by the
 * caller (scanMdNetwork). backtickPaths (fence/comment handling included) is
 * the shared link convention's, from the skill's mdLinks.cjs; re-exported here.
 */

const path = require('node:path');
const { backtickPaths } = require('../../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdLinks.cjs');

const MAX_CHANGED = 20;
const MAX_PATTERNS = 4000;

/**
 * @typedef {{ path: string, ms: number }} ChangedRef
 * @typedef {{
 *   docPath: string,
 *   linkTargets: string[],
 *   tokens: string[],
 *   docMs: number | null,
 *   exists: (repoPath: string) => boolean,
 *   lastCommitOf: (repoPath: string) => number | null | undefined,
 *   ignored?: (repoPath: string) => boolean,
 *   suffixMatches?: (token: string) => string[],
 * }} AssessInput
 */

/** Normalised repo path, or null when it escapes the repo. @param {string} p @returns {string | null} */
function repoPath(p) {
  const n = path.posix.normalize(p).replace(/\/+$/, '');
  if (n === '' || n === '.' || n === '..' || n.startsWith('../')) return null;
  return n;
}

/**
 * Resolver from a token to every tracked path equal to it or ending with
 * '/<token>' (whole segments only), in listing order. One Map by basename.
 * @param {string[]} paths tracked files and folders, repo-relative POSIX
 * @returns {(token: string) => string[]}
 */
function suffixIndex(paths) {
  /** @type {Map<string, string[]>} */
  const byBase = new Map();
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || p === '') continue;
    const base = path.posix.basename(p);
    const list = byBase.get(base);
    if (list) list.push(p);
    else byBase.set(base, [p]);
  }
  return (token) => {
    const t = typeof token === 'string' ? repoPath(token) : null;
    if (t === null) return [];
    const list = byBase.get(path.posix.basename(t)) ?? [];
    return [...new Set(list.filter((p) => p === t || p.endsWith(`/${t}`)))];
  };
}

/**
 * Dead refs (tokens that resolve nowhere: not present, not gitignored, naming
 * no tracked path by suffix), ambiguous refs (a suffix naming 2+ tracked
 * paths), and existing file refs committed after the doc (newest first, at
 * most MAX_CHANGED). A unique suffix match counts as that file.
 * @param {AssessInput} input
 * @returns {{ deadRefs: string[], ambiguousRefs: string[], changedSince: ChangedRef[] }}
 */
function assessRefs({ docPath, linkTargets, tokens, docMs, exists, lastCommitOf, ignored, suffixMatches }) {
  const dir = path.posix.dirname(docPath);
  /** @type {string[]} */
  const deadRefs = [];
  const deadSeen = new Set();
  /** @type {string[]} */
  const ambiguousRefs = [];
  const ambiguousSeen = new Set();
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
    let hit = candidates.find((c) => exists(c));
    if (hit === undefined && typeof ignored === 'function' && candidates.some((c) => ignored(c))) continue;
    if (hit === undefined && root !== null && typeof suffixMatches === 'function') {
      const matches = suffixMatches(root);
      if (matches.length === 1) hit = matches[0];
      else if (matches.length >= 2) {
        if (!ambiguousSeen.has(root)) {
          ambiguousSeen.add(root);
          ambiguousRefs.push(root);
        }
        continue;
      }
    }
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
  return { deadRefs, ambiguousRefs, changedSince: changed.slice(0, MAX_CHANGED) };
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

module.exports = { backtickPaths, assessRefs, suffixIndex, mentionPatterns, parseMentions };
