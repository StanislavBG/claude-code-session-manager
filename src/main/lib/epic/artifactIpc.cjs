// @ts-check
'use strict';

/**
 * artifactIpc.cjs — read-only renderer IPC for a project's Artifacts store and its
 * unmerged Epic worktrees, so the File Explorer can show work that has not landed yet.
 *
 *   artifacts:list       { cwd } → { ok, artifacts: [...listArtifacts entry, epicTitle] }
 *   artifacts:worktrees  { cwd } → { ok, worktrees: [{ epicId, title, path, branch, aheadOfBase }] }
 *
 * Both payloads are strict zod schemas (ipcSchemas.cjs); `cwd` additionally passes
 * config.cjs's validatePath, like every other renderer-supplied cwd. Epic records come
 * from the project's prompt-sessions active index (epicMint.readActiveIndex) — titles of
 * Epics no longer in the index fall back to their prompt-sessions/<id>.json mirror.
 * Nothing here scans ~/.claude/projects, and nothing writes.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Per-git-call bound — one slow repo must not hang the Explorer. */
const GIT_TIMEOUT_MS = 10_000;

/** goalText's first paragraph (an Epic's title), or null. */
/** @param {{ goalText?: unknown } | null | undefined} record */
function titleOf(record) {
  const goalText = record && typeof record.goalText === 'string' ? record.goalText : '';
  const m = /\r?\n[ \t]*\r?\n/.exec(goalText);
  const head = (m ? goalText.slice(0, m.index) : goalText).trim();
  return head || null;
}

/** @param {string} p */
function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** @param {string} p */
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * @param {{
 *   readActiveIndex?: (cwd: string) => { sessions: Record<string, any> },
 *   readMirror?: (cwd: string, epicId: string) => any,
 *   listArtifacts?: (cwd: string) => any[],
 *   execGit?: (cwd: string, args: string[], opts?: { timeout?: number }) => Promise<string>,
 * }} [deps]
 */
function makeArtifactReaders(deps = {}) {
  const readActiveIndex = deps.readActiveIndex || ((cwd) => require('./epicMint.cjs').readActiveIndex(cwd));
  const listArtifacts = deps.listArtifacts || ((cwd) => require('./artifactStore.cjs').listArtifacts(cwd));
  const execGit = deps.execGit || require('../git/gitExec.cjs').execGit;
  const readMirror = deps.readMirror || ((cwd, epicId) => {
    const { epicMirrorPath } = require('./epicStatusMirror.cjs');
    const { readJsonOrSync } = require('../util/atomicFs.cjs');
    const doc = readJsonOrSync(epicMirrorPath(cwd, epicId), null);
    return doc && doc.session && typeof doc.session === 'object' ? doc.session : doc;
  });

  /** artifacts:list — listArtifacts entries joined with each owning Epic's title. */
  /** @param {string} cwd */
  function listWithTitles(cwd) {
    const { sessions } = readActiveIndex(cwd);
    /** @type {Map<string, string|null>} */
    const titles = new Map();
    const titleFor = (/** @type {unknown} */ ownerId) => {
      if (typeof ownerId !== 'string' || ownerId.startsWith('_tasks/')) return null;
      if (titles.has(ownerId)) return titles.get(ownerId) ?? null;
      let t = Object.prototype.hasOwnProperty.call(sessions, ownerId) ? titleOf(sessions[ownerId]) : null;
      if (t === null) { try { t = titleOf(readMirror(cwd, ownerId)); } catch { t = null; } }
      titles.set(ownerId, t);
      return t;
    };
    const artifacts = listArtifacts(cwd).map((e) => ({ ...e, epicTitle: titleFor(e.ownerId) }));
    return { ok: true, artifacts };
  }

  /**
   * artifacts:worktrees — active Epics of `cwd` whose recorded worktree is on disk and
   * registered with git, with commits on the Epic branch not yet on the base.
   */
  /** @param {string} cwd */
  async function listWorktrees(cwd) {
    const { sessions } = readActiveIndex(cwd);
    let registered;
    try {
      const { parseWorktreePorcelain } = require('../git/gitExec.cjs');
      const out = await execGit(cwd, ['worktree', 'list', '--porcelain'], { timeout: GIT_TIMEOUT_MS });
      registered = new Map(parseWorktreePorcelain(out).map((w) => [realOrResolved(w.worktree), w.branch]));
    } catch {
      return { ok: true, worktrees: [] }; // not a git repo (or git unavailable): nothing unmerged to show
    }
    const rows = [];
    for (const [epicId, rec] of Object.entries(sessions)) {
      if (!rec || rec.status !== 'active') continue;
      const wt = rec.worktree;
      if (!wt || typeof wt.dir !== 'string' || !wt.dir || (wt.status && wt.status !== 'active')) continue;
      if (!isDir(wt.dir)) continue;
      const real = realOrResolved(wt.dir);
      if (!registered.has(real)) continue;
      const branch = registered.get(real) || (typeof wt.branch === 'string' ? wt.branch : null);
      if (!branch) continue;
      rows.push({ epicId, title: titleOf(rec), path: wt.dir, branch, base: typeof wt.baseBranch === 'string' && wt.baseBranch ? wt.baseBranch : 'HEAD' });
    }
    const worktrees = await Promise.all(rows.map(async ({ base, ...row }) => {
      let aheadOfBase = null;
      try {
        const out = await execGit(cwd, ['rev-list', '--count', `${base}..${row.branch}`, '--'], { timeout: GIT_TIMEOUT_MS });
        const n = Number.parseInt(out.trim(), 10);
        aheadOfBase = Number.isFinite(n) ? n : null;
      } catch { aheadOfBase = null; }
      return { ...row, aheadOfBase };
    }));
    return { ok: true, worktrees };
  }

  return { listWithTitles, listWorktrees };
}

/**
 * @param {{ ipcMain?: any, validatePath?: (p: string) => string } & Parameters<typeof makeArtifactReaders>[0]} [deps]
 */
function registerArtifactHandlers(deps = {}) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const validatePath = deps.validatePath || require('../../config.cjs').validatePath;
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');
  const readers = makeArtifactReaders(deps);
  ipcMain.handle('artifacts:list', v(s.artifactsList, async ({ cwd }) => {
    validatePath(cwd);
    return readers.listWithTitles(cwd);
  }));
  ipcMain.handle('artifacts:worktrees', v(s.artifactsWorktrees, async ({ cwd }) => {
    validatePath(cwd);
    return readers.listWorktrees(cwd);
  }));
}

module.exports = { registerArtifactHandlers, makeArtifactReaders, GIT_TIMEOUT_MS };
