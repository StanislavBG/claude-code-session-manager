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
 * and the 'prd' kind — one section per PRD of the Epic that landed a commit.
 * Scheduled PRD jobs fork from and land on the project's base branch, not on
 * sm-epic/<id>, so a develop-loop Epic's work shows up only here. PRD slugs
 * come only from this Epic's own prds/ + prds-archived/ dirs (plus ancestor
 * Epic dirs); landedCommit only from THIS project's queue shard + history
 * tail, filtered to this Epic — never a machine-wide scan.
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
const {
  isSafeEpicId, resolveEpicsRoot, ancestorEpicPrdDirs, ancestorEpicArchivedPrdDirs,
} = require('../prd/prdLocations.cjs');
const { parsePrdFile } = require('../prd/prdFrontmatter.cjs');

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_FILES_PER_SECTION = 300;
const MAX_TOTAL_LINES = 20_000;
const MAX_UNTRACKED = 200;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const LIVE_WORKTREE_STATUSES = new Set(['active', 'needs_merge_resolution']);
const PRD_DIFF_CONCURRENCY = 4;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const TERMINAL_JOB_STATUSES = new Set(['completed', 'skipped', 'failed', 'quarantined']);
const HISTORY_TAIL = { maxRows: 5000, maxBytes: 8388608 };
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
    listEpicPrds: deps.listEpicPrds || defaultListEpicPrds,
    landedCommitFor: deps.landedCommitFor || defaultLandedCommitFor,
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

// ---------- 'prd' sections ----------

/** `<slug>.md` files directly in `dir` → [{ slug, title }]. Never throws. */
function prdFilesIn(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    let title = '';
    try {
      if (!fs.statSync(file).isFile()) continue;
      const t = parsePrdFile(fs.readFileSync(file, 'utf8')).frontmatter.title;
      title = typeof t === 'string' ? t.trim() : '';
    } catch { continue; }
    const slug = name.slice(0, -3);
    out.push({ slug, title: title || slug });
  }
  return out;
}

/** Immediate subdirectories of `dir` (prds-archived/<ISO>/). Never throws. */
function subdirsOf(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * The Epic's PRDs → [{ slug, title }], first occurrence of a slug winning.
 * Reads only <epicsRoot>/<epicId>/prds/ and both archived layouts —
 * flat prds-archived/<NN>-<slug>.md (how the scheduler archives today) and
 * nested prds-archived/<ISO>/<NN>-<slug>.md — plus the ancestor Epic dirs of
 * the same id. Order: prds/ dirs, then each prds-archived root followed by
 * its immediate subfolders. Never throws.
 */
function defaultListEpicPrds(cwd, epicId) {
  const liveDirs = [];
  const archivedRoots = [];
  try {
    const epicDir = path.join(resolveEpicsRoot(cwd), epicId);
    liveDirs.push(path.join(epicDir, 'prds'));
    archivedRoots.push(path.join(epicDir, 'prds-archived'));
  } catch { /* unresolvable ops root: ancestors only */ }
  try { liveDirs.push(...ancestorEpicPrdDirs(cwd, epicId)); } catch { /* none */ }
  try { archivedRoots.push(...ancestorEpicArchivedPrdDirs(cwd, epicId)); } catch { /* none */ }
  const dirs = [...liveDirs, ...archivedRoots.flatMap((root) => [root, ...subdirsOf(root)])];
  const seen = new Map();
  for (const dir of dirs) {
    for (const p of prdFilesIn(dir)) if (!seen.has(p.slug)) seen.set(p.slug, p);
  }
  return [...seen.values()];
}

/** Queue shard rows (`{ jobs: [...] }`) from one file. Missing/corrupt → []. */
function readQueueRows(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data && data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

/**
 * readLandedCommits({ queuePath, historyPath, epicId, slugs }) →
 *   Map slug -> { sha, cwd }
 * Considers only terminal rows of this Epic ((row.epicId || row.sourcePromptId)
 * === epicId) whose slug is in `slugs`. The newest terminal row per slug wins
 * (by finishedAt; on a tie, queue rows beat history, newer history lines beat
 * older); a winner without landedCommit drops the slug. Never throws.
 */
function readLandedCommits({ queuePath, historyPath, epicId, slugs }) {
  const want = new Set(slugs);
  /** @type {Map<string, { row: any, at: string }>} */
  const best = new Map();
  const consider = (row) => {
    if (!row || typeof row !== 'object' || typeof row.slug !== 'string' || !want.has(row.slug)) return;
    if ((row.epicId || row.sourcePromptId) !== epicId) return;
    if (row.kind && row.kind !== 'terminal') return;
    if (!TERMINAL_JOB_STATUSES.has(row.status)) return;
    const at = typeof row.finishedAt === 'string' ? row.finishedAt : '';
    const cur = best.get(row.slug);
    if (!cur || at >= cur.at) best.set(row.slug, { row, at });
  };
  let history = [];
  try {
    const { readHistoryFileTailSync } = require('../scheduler/queueHistory.cjs');
    history = historyPath ? readHistoryFileTailSync(historyPath, HISTORY_TAIL) : [];
  } catch { history = []; }
  // Tail is newest-first: walk oldest → newest, then the live queue shard.
  for (let i = history.length - 1; i >= 0; i -= 1) consider(history[i]);
  if (queuePath) for (const row of readQueueRows(queuePath)) consider(row);
  const out = new Map();
  for (const [slug, { row }] of best) {
    const sha = typeof row.landedCommit === 'string' ? row.landedCommit.trim() : '';
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    out.set(slug, { sha, cwd: typeof row.cwd === 'string' && path.isAbsolute(row.cwd) ? row.cwd : null });
  }
  return out;
}

/** Default landedCommitFor: this project's queue shard + history file only. */
function defaultLandedCommitFor(cwd, slugs, epicId) {
  const { projectQueuePath, projectHistoryPath } = require('../scheduler/queueStore.cjs');
  let queuePath = null;
  let historyPath = null;
  try { queuePath = projectQueuePath(cwd); } catch { queuePath = null; }
  try { historyPath = projectHistoryPath(cwd); } catch { historyPath = null; }
  if (!queuePath && !historyPath) return new Map();
  return readLandedCommits({ queuePath, historyPath, epicId, slugs });
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const prdNumber = (slug) => {
  const m = /^(\d+)/.exec(slug);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

/** The 'prd' sections: one per PRD of this Epic with a resolvable landedCommit. */
async function buildPrdSections({ cwd, epicId, deps: d }) {
  let prds = [];
  try { prds = await d.listEpicPrds(cwd, epicId); } catch { prds = []; }
  prds = (Array.isArray(prds) ? prds : []).filter((p) => p && typeof p.slug === 'string' && p.slug);
  if (!prds.length) return [];
  let landed;
  try { landed = await d.landedCommitFor(cwd, prds.map((p) => p.slug), epicId); } catch { landed = null; }
  if (!(landed instanceof Map)) return [];
  const todo = [];
  for (const p of prds) {
    const v = landed.get(p.slug);
    const sha = typeof v === 'string' ? v : v && typeof v.sha === 'string' ? v.sha : '';
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    const rowCwd = v && typeof v === 'object' && typeof v.cwd === 'string' && path.isAbsolute(v.cwd) ? v.cwd : null;
    todo.push({ slug: p.slug, title: typeof p.title === 'string' && p.title ? p.title : p.slug, sha, gitCwd: rowCwd || cwd });
  }
  todo.sort((a, b) => (prdNumber(a.slug) - prdNumber(b.slug)) || a.slug.localeCompare(b.slug));
  const built = await mapLimit(todo, PRD_DIFF_CONCURRENCY, async (t) => {
    try {
      await git(d, t.gitCwd, ['cat-file', '-e', `${t.sha}^{commit}`]);
    } catch {
      return null; // unknown sha: skip silently
    }
    const head = t.sha;
    const meta = { kind: 'prd', key: `prd:${t.slug}`, label: t.title, slug: t.slug, base: `${head}^1`, head, live: false };
    try {
      const hasParent = !!(await tryCommit(d, t.gitCwd, `${head}^1`));
      const files = await runDiff(d, t.gitCwd, [hasParent ? `${head}^1` : EMPTY_TREE, head, '--']);
      return { ...meta, files };
    } catch (err) {
      return { ...meta, files: [], error: errText(err) };
    }
  });
  return built.filter(Boolean);
}

/** Section builders by kind, in display order. */
const SECTION_BUILDERS = { session: buildSessionSections, prd: buildPrdSections };

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
 * deps (all optional, for tests): loadEpic, listEpicPrds, landedCommitFor,
 * listEpicReviewRanges,
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

/**
 * Register 'epicChanges:get'. Concurrent calls for the same (cwd, epicId)
 * share one in-flight getEpicChanges run; the entry is dropped once it
 * settles, so nothing is cached across calls. deps.getEpicChanges is a test seam.
 */
function registerEpicChangesHandlers(ipcMain = require('electron').ipcMain, deps = {}) {
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');
  const run = deps.getEpicChanges || getEpicChanges;
  /** @type {Map<string, Promise<unknown>>} */
  const inFlight = new Map();
  ipcMain.handle('epicChanges:get', v(s.epicChangesGet, ({ cwd, epicId }) => {
    const key = `${cwd}\u0000${epicId}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    let started;
    try { started = Promise.resolve(run({ cwd, epicId })); } catch (err) { started = Promise.reject(err); }
    const p = started.finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
    inFlight.set(key, p);
    return p;
  }));
}

module.exports = {
  getEpicChanges,
  registerEpicChangesHandlers,
  SECTION_BUILDERS,
  buildSessionSections,
  buildPrdSections,
  defaultListEpicPrds,
  defaultLandedCommitFor,
  readLandedCommits,
  runDiff,
  applyCaps,
  defaultLoadEpic,
  MAX_FILES_PER_SECTION,
  MAX_TOTAL_LINES,
};
