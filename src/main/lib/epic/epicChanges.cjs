'use strict';

/**
 * epicChanges.cjs — the single main-process read API behind an Epic's Changes
 * view: getEpicChanges({ cwd, epicId }) → { ok, epicId, status, sections, truncated }.
 *
 * Sections are built per kind by SECTION_BUILDERS. This module builds the
 * 'session' kind:
 *   - session:live    — active worktree: diff <fork> (working tree, committed +
 *                       uncommitted) plus untracked files, minus base-tree WIP
 *                       carried in at mint and still unchanged.
 *   - session:branch  — checkout removed but sm-epic/<id> still alive.
 *   - session:<head>  — one per pinned review range (refs/sm-epic-review/).
 * A follow-up adds a 'prd' kind (one section per landed PRD) in this file.
 *
 * Every git call goes through gitExec.execGit with an argv array, a bounded
 * timeout and a 32 MiB maxBuffer; every diff uses fixed flags so user config
 * (quotepath, color, external diff, textconv, prefixes) cannot break parsing.
 * Commands run inside a live worktree carry --no-optional-locks so they never
 * take index.lock under the agent working there. Worktree dirs come only from
 * the Epic record — never from joining a caller-supplied cwd.
 *
 * Never throws: every failure is { ok: false, reason } or a section `error`.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const gitExec = require('../git/gitExec.cjs');
const gitWorktree = require('../git/gitWorktree.cjs');
const { parseUnifiedDiff } = require('../git/unifiedDiff.cjs');
const { isSafeEpicId } = require('../prd/prdLocations.cjs');

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_FILES_PER_SECTION = 300;
const MAX_TOTAL_LINES = 20_000;
const MAX_UNTRACKED = 200;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const LIVE_WORKTREE_STATUSES = new Set(['active', 'needs_merge_resolution']);
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

/** Default record lookup: the active index entry, else the archived record. */
function defaultLoadEpic(cwd, epicId) {
  const { loadActiveIndex, readArchived } = require('../../promptSessionsIpc.cjs');
  const idx = loadActiveIndex(cwd);
  const sessions = idx && idx.data && idx.data.sessions;
  if (sessions && typeof sessions === 'object' && sessions[epicId]) return sessions[epicId];
  const arch = readArchived(cwd, epicId);
  return arch && arch.exists && arch.data ? arch.data : null;
}

function resolveDeps(deps = {}) {
  return {
    loadEpic: deps.loadEpic || defaultLoadEpic,
    listEpicReviewRanges: deps.listEpicReviewRanges || gitWorktree.listEpicReviewRanges,
    resolveForkSha: deps.resolveForkSha || gitWorktree.resolveForkSha,
    unchangedCarriedPaths: deps.unchangedCarriedPaths || gitWorktree.unchangedCarriedPaths,
    resolveDefaultBranch: deps.resolveDefaultBranch || gitWorktree.resolveDefaultBranch,
    execGit: deps.execGit || gitExec.execGit,
    validatePath: deps.validatePath || require('../../config.cjs').validatePath,
  };
}

function errText(err) {
  const e = /** @type {any} */ (err);
  return String((e && (e.stderrText || e.message)) || e || 'git failure').trim().split('\n')[0] || 'git failure';
}

/** Run git with the fixed limits. `live` adds --no-optional-locks. */
function git(d, cwd, args, { live = false } = {}) {
  const pre = ['-c', 'core.quotepath=off'];
  if (live) pre.push('--no-optional-locks');
  return d.execGit(cwd, [...pre, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
}

/** `git diff` with the fixed flags → parsed files (throws on git failure). */
async function runDiff(d, cwd, revArgs, opts = {}) {
  const pre = ['-c', 'core.quotepath=off'];
  if (opts.live) pre.push('--no-optional-locks');
  const out = await d.execGit(cwd, [...pre, 'diff', ...DIFF_FLAGS, ...revArgs], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  return parseUnifiedDiff(out).map((f) => ({ ...f, tooLarge: false }));
}

/** A section whose diff came from `produce()`; a git failure becomes `error`. */
async function makeSection(meta, produce) {
  try {
    return { kind: 'session', ...meta, files: await produce() };
  } catch (err) {
    return { kind: 'session', ...meta, files: [], error: errText(err) };
  }
}

async function tryCommit(d, cwd, rev) {
  try {
    const sha = String(await git(d, cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Fork point of `branch`: resolveForkSha, else merge-base with the default branch. */
async function forkPoint(d, cwd, forkCwd, branch) {
  let fork = null;
  try { fork = await d.resolveForkSha({ cwd: forkCwd, branch }); } catch { fork = null; }
  if (fork) return fork;
  try {
    const base = await d.resolveDefaultBranch(cwd);
    const out = String(await git(d, cwd, ['merge-base', `refs/heads/${base}`, `refs/heads/${branch}`])).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Untracked files in a live worktree as 'added' diff files. */
async function untrackedFiles(d, dir, state) {
  const out = String(await git(d, dir, ['ls-files', '--others', '--exclude-standard', '-z'], { live: true }));
  const all = out.split('\0').filter(Boolean);
  if (all.length > MAX_UNTRACKED) state.truncated = true;
  const files = [];
  for (const rel of all.slice(0, MAX_UNTRACKED)) {
    let st = null;
    try { st = await fsp.lstat(path.join(dir, rel)); } catch { continue; }
    if (st.isFile() && st.size > MAX_UNTRACKED_BYTES) {
      state.truncated = true;
      files.push({ path: rel, oldPath: null, status: 'added', binary: false, additions: 0, deletions: 0, hunks: [], truncated: true, tooLarge: true });
      continue;
    }
    let text = '';
    try {
      text = await git(d, dir, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', rel], { live: true });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (!e || e.code !== 1) throw err; // exit 1 = "has differences"
      text = e.stdoutText || '';
    }
    for (const f of parseUnifiedDiff(text)) files.push({ ...f, path: f.path || rel, tooLarge: false });
  }
  return files;
}

/** The 'session' sections for an Epic record. */
async function buildSessionSections({ cwd, epicId, record, deps: d, state }) {
  const sections = [];
  const wt = record && record.worktree && typeof record.worktree === 'object' ? record.worktree : null;
  const branch = wt && typeof wt.branch === 'string' && wt.branch && !wt.branch.startsWith('-') ? wt.branch : null;
  const dir = wt && typeof wt.dir === 'string' && path.isAbsolute(wt.dir) ? wt.dir : null;
  const baseCwd = wt && typeof wt.baseCwd === 'string' && wt.baseCwd ? wt.baseCwd : cwd;

  if (branch) {
    const dirExists = !!dir && fs.existsSync(dir);
    if (dirExists && LIVE_WORKTREE_STATUSES.has(wt.status)) {
      const fork = await forkPoint(d, cwd, baseCwd, branch);
      const meta = { key: 'session:live', label: 'Session edits (not yet merged)', base: fork, head: null, live: true };
      sections.push(await makeSection(meta, async () => {
        if (!fork) throw new Error('no fork point');
        const files = [...await runDiff(d, dir, [fork, '--'], { live: true }), ...await untrackedFiles(d, dir, state)];
        const carried = Array.isArray(wt.carriedPaths) ? wt.carriedPaths.filter((p) => typeof p === 'string' && p) : [];
        if (!carried.length) return files;
        const unchanged = new Set(await d.unchangedCarriedPaths({ cwd: baseCwd, dir, paths: carried }));
        return files.filter((f) => !unchanged.has(f.path));
      }));
    } else if (!dirExists) {
      const tip = await tryCommit(d, cwd, `refs/heads/${branch}`);
      if (tip) {
        const fork = await forkPoint(d, cwd, baseCwd, branch);
        const meta = { key: 'session:branch', label: 'Session edits (committed; checkout removed)', base: fork, head: tip, live: false };
        sections.push(await makeSection(meta, async () => {
          if (!fork) throw new Error('no fork point');
          return runDiff(d, cwd, [fork, `refs/heads/${branch}`, '--']);
        }));
      }
    }
  }

  let ranges = [];
  try { ranges = await d.listEpicReviewRanges({ cwd, epicId }); } catch { ranges = []; }
  for (const r of Array.isArray(ranges) ? ranges : []) {
    if (!r || !r.base || !r.head) continue;
    const day = typeof r.headCommittedAt === 'string' ? r.headCommittedAt.slice(0, 10) : '';
    const meta = { key: `session:${r.head}`, label: `Session edits landed ${day}`.trim(), base: r.base, head: r.head, live: false };
    sections.push(await makeSection(meta, () => runDiff(d, cwd, [r.base, r.head, '--'])));
  }
  return sections;
}

/** Section builders by kind, in display order. A follow-up PRD adds 'prd'. */
const SECTION_BUILDERS = { session: buildSessionSections };

/** Enforce the per-section file cap and the total line cap in place. */
function applyCaps(sections, state) {
  let lines = 0;
  for (const s of sections) {
    s.files.forEach((f, i) => {
      // Real diff size: the parser keeps at most 3000 lines per file, so the
      // kept-hunk count alone would under-count a huge file.
      const kept = (f.hunks || []).reduce((acc, h) => acc + ((h && h.lines) ? h.lines.length : 0), 0);
      const n = Math.max(kept, (f.additions || 0) + (f.deletions || 0));
      if (f.tooLarge) return;
      if (f.truncated) state.truncated = true;
      if (i >= MAX_FILES_PER_SECTION || lines + n > MAX_TOTAL_LINES) {
        f.hunks = [];
        f.tooLarge = true;
        state.truncated = true;
        return;
      }
      lines += n;
    });
  }
}

/**
 * getEpicChanges({ cwd, epicId }, deps?) → Promise<
 *   { ok: true, epicId, status, sections, truncated } | { ok: false, reason }>
 * deps (all optional, for tests): loadEpic, listEpicReviewRanges,
 * resolveForkSha, unchangedCarriedPaths, resolveDefaultBranch, execGit,
 * validatePath. Never throws.
 */
async function getEpicChanges(input, deps) {
  try {
    const { cwd, epicId } = input || {};
    const d = resolveDeps(deps);
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return { ok: false, reason: 'cwd must be an absolute path' };
    try { d.validatePath(cwd); } catch (err) { return { ok: false, reason: errText(err) }; }
    if (!isSafeEpicId(epicId)) return { ok: false, reason: 'invalid epicId' };
    let record;
    try { record = await d.loadEpic(cwd, epicId); } catch (err) { return { ok: false, reason: errText(err) }; }
    if (!record || typeof record !== 'object') return { ok: false, reason: 'epic not found' };
    const state = { truncated: false };
    const sections = [];
    for (const build of Object.values(SECTION_BUILDERS)) {
      sections.push(...await build({ cwd, epicId, record, deps: d, state }));
    }
    applyCaps(sections, state);
    return { ok: true, epicId, status: record.status ?? null, sections, truncated: state.truncated };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

module.exports = {
  getEpicChanges,
  SECTION_BUILDERS,
  buildSessionSections,
  runDiff,
  applyCaps,
  defaultLoadEpic,
  MAX_FILES_PER_SECTION,
  MAX_TOTAL_LINES,
};
