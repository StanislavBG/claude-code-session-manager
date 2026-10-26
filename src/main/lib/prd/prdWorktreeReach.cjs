/**
 * prdWorktreeReach.cjs — pure PRD worktree-reach advisory rule.
 *
 * Incident: burrow PRD 1516-fb-bilko-first-pumpkin named a gitignored runtime path by RELATIVE
 * path (downloads/fb-tracker.db) and an install-cron.sh that baked a worktree path. Scheduled
 * PRDs run in an isolated git job worktree holding only tracked files plus symlinked or (pnpm) worktree-local
 * dependency dirs (DEFAULT_DEP_DIRS), so that path pointed at a file that did not exist there and the job
 * parked needs_human.
 *
 * Two exports: `extractRepoPathCandidates(text)` pulls repo-relative path-looking tokens out of
 * PRD prose; `worktreeReachWarnings(input, ignoredPaths)` turns the ones the caller found
 * gitignored (via `git check-ignore` — not done here) into one advisory warning. No I/O.
 * Warnings never block a write.
 */
'use strict';

const { DEFAULT_DEP_DIRS } = require('../git/worktreeDeps.cjs');

const MAX_CANDIDATES = 200;
const MAX_NAMED_PATHS = 5;

const LEADING_JUNK_RE = /^[`'"([<]+/;
const TRAILING_JUNK_RE = /[`'")\]>.,:;]+$/;

const FRAGMENT_RE = /#[^/#]*$/;
const LINE_SUFFIX_RE = /:\d+(?:-\d+)?$/;

function isCandidate(token) {
  if (!token.includes('/')) return false;
  if (/^[/~$-]/.test(token)) return false;
  if (token.includes('://')) return false;
  if (token.split('/').includes('..')) return false;
  return true;
}

/** Pure. Deduped repo-relative tokens containing a '/', capped at 200. */
function extractRepoPathCandidates(text) {
  const seen = new Set();
  for (const raw of String(text == null ? '' : text).split(/\s+/)) {
    if (!raw) continue;
    const token = raw
      .replace(LEADING_JUNK_RE, '')
      .replace(TRAILING_JUNK_RE, '')
      .replace(FRAGMENT_RE, '')
      .replace(LINE_SUFFIX_RE, '')
      .replace(TRAILING_JUNK_RE, '');
    if (!token || !isCandidate(token)) continue;
    seen.add(token);
    if (seen.size >= MAX_CANDIDATES) break;
  }
  return [...seen];
}

function normalize(p) {
  return String(p).replace(/^(\.\/)+/, '');
}

/**
 * Pure. `input` mirrors createPrd()'s shape; missing fields are treated as empty.
 * `ignoredPaths` is the caller's list of gitignored repo-relative paths. Returns `[]` when none
 * remain after exempting symlinked dependency dirs, else exactly one warning string.
 */
function worktreeReachWarnings(input, ignoredPaths) {
  const { goal, acceptanceCriteria, implementationNotes } = input || {};
  const ac = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.filter((l) => typeof l === 'string') : [];
  const ignored = (Array.isArray(ignoredPaths) ? ignoredPaths : [])
    .filter((p) => typeof p === 'string' && p)
    .map(normalize)
    .filter((p) => !DEFAULT_DEP_DIRS.includes(p.split('/')[0]));
  if (ignored.length === 0) return [];

  const text = [goal, ...ac, implementationNotes].filter((s) => typeof s === 'string').join('\n');
  const mentioned = new Set(extractRepoPathCandidates(text).map(normalize));
  const offending = [...new Set(ignored)].filter((p) => mentioned.has(p) || mentioned.has(p.replace(/\/+$/, '')));
  const named = (offending.length ? offending : [...new Set(ignored)]).slice(0, MAX_NAMED_PATHS);

  return [
    `This PRD references gitignored path(s) by relative path: ${named.join(', ')}. `
    + 'The job runs in an isolated worktree where gitignored files do not exist, so those paths will '
    + 'be missing (or a baked-in worktree path will dangle). Address the main checkout by absolute path '
    + 'in an artifact-only PRD (or split the PRD) — see PRD_AUTHORING.md section 7.',
  ];
}

module.exports = { extractRepoPathCandidates, worktreeReachWarnings };
