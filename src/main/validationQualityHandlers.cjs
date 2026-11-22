/**
 * validationQualityHandlers.cjs — `history:validation-quality` IPC and
 * GET /admin/validation-quality?cwd=<abs>. Gathers each project's Epic
 * verdict events (active index + archived Epic files) and scheduler rows
 * (queue + the project's own history shard, which carry `fixes`) and feeds
 * the pure calculator in lib/scheduler/validationQuality.cjs.
 *
 * Zero-scan: the IPC never enumerates ~/.claude/projects (lib/CLAUDE.md). Its
 * project list is the cwd values of the scheduler rows, and those same cwds
 * are the registered roots handed to the archive readers, so the archive
 * path never falls back to defaultProjectRoots' allProjectCwds scan.
 *
 * Read-only; every gather resolves { ok: false, error } instead of throwing.
 */

'use strict';

const path = require('path');
const { computeValidationQuality } = require('./lib/scheduler/validationQuality.cjs');

const HISTORY_ROWS_PER_PROJECT = 500;

/** @param {unknown} e */
const errText = (e) => (e instanceof Error ? e.message : String(e));
/** @param {unknown} v */
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** @param {string} p */
const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');

/** Default loaders — required lazily so tests can inject fixtures. */
const defaults = {
  /** Every live queue row (scheduler's merged queue read). */
  async loadQueueJobs() {
    const state = await require('./lib/scheduler/queueStore.cjs').readMerged();
    return Array.isArray(state && state.jobs) ? state.jobs : [];
  },
  /** Newest federated history rows — only used to discover project cwds. */
  async loadRecentHistory() {
    return require('./lib/scheduler/queueHistory.cjs').readHistory({ limit: HISTORY_ROWS_PER_PROJECT });
  },
  /** One project's own history shard (newest-first, bounded tail). */
  /** @param {string} cwd */
  loadProjectHistory(cwd) {
    const { readHistoryFileTailSync } = require('./lib/scheduler/queueHistory.cjs');
    const { projectHistoryPath } = require('./lib/scheduler/queueStore.cjs');
    return readHistoryFileTailSync(projectHistoryPath(cwd), { maxRows: HISTORY_ROWS_PER_PROJECT });
  },
};

/** Terminal history rows only (skip needs_review ledger lines, which carry a `kind`). */
function isHistoryJobRow(r) {
  return isObj(r) && typeof r.slug === 'string' && typeof r.cwd === 'string' && !('kind' in r && r.kind);
}

/**
 * Epic verdict events of one project: open Epics' chains from the active
 * index, plus every archived Epic's events. Unreadable files are skipped.
 * @param {string} cwd @param {() => string[]} projectRoots
 */
function epicsOf(cwd, projectRoots) {
  const { readActiveIndex } = require('./lib/epic/epicMint.cjs');
  const { listArchived, readArchived } = require('./promptSessionsIpc.cjs');
  /** @type {Map<string, any[]>} */
  const byId = new Map();
  try {
    const index = readActiveIndex(cwd);
    for (const [epicId, chain] of Object.entries(isObj(index.events) ? index.events : {})) {
      if (Array.isArray(chain)) byId.set(epicId, chain.slice());
    }
  } catch { /* no active index */ }
  let ids = [];
  try {
    const listed = listArchived(cwd, { projectRoots });
    ids = listed && Array.isArray(listed.ids) ? listed.ids : [];
  } catch { /* unregistered or unreadable */ }
  for (const epicId of ids) {
    try {
      const res = readArchived(cwd, epicId, { projectRoots });
      const events = res && res.exists && isObj(res.data) && Array.isArray(res.data.events) ? res.data.events : [];
      byId.set(epicId, [...(byId.get(epicId) || []), ...events]);
    } catch { /* skip this archive */ }
  }
  return [...byId].map(([epicId, events]) => ({ cwd, epicId, events }));
}

/**
 * Rows of the given projects: live queue rows + each project's history shard.
 * Queue rows come first so a slug's live row wins over its archived copy.
 */
function rowsFor(cwds, queueJobs, loadProjectHistory) {
  const want = new Set(cwds);
  const rows = [];
  for (const j of queueJobs) if (isObj(j) && typeof j.cwd === 'string' && want.has(norm(j.cwd))) rows.push({ ...j, cwd: norm(j.cwd) });
  for (const cwd of cwds) {
    let hist = [];
    try { hist = loadProjectHistory(cwd) || []; } catch { /* no shard */ }
    for (const r of hist) if (isHistoryJobRow(r) && norm(r.cwd) === cwd) rows.push({ ...r, cwd });
  }
  return rows;
}

/**
 * One project (cwd given) or every project that has scheduler rows (no cwd).
 * @param {{ cwd?: string, nowMs?: number, projectRoots?: () => string[], loadQueueJobs?: () => Promise<any[]> | any[], loadRecentHistory?: () => Promise<any[]> | any[], loadProjectHistory?: (cwd: string) => any[] }} [opts]
 * @returns {Promise<{ ok: true, projects: any[] } | { ok: false, error: string }>}
 */
async function gatherValidationQuality(opts = {}) {
  try {
    const o = isObj(opts) ? opts : {};
    const now = typeof o.nowMs === 'number' && Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const loadQueueJobs = o.loadQueueJobs || defaults.loadQueueJobs;
    const loadRecentHistory = o.loadRecentHistory || defaults.loadRecentHistory;
    const loadProjectHistory = o.loadProjectHistory || defaults.loadProjectHistory;

    const queueJobs = (await loadQueueJobs()) || [];
    /** @type {string[]} */
    let cwds;
    if (o.cwd !== undefined) {
      if (typeof o.cwd !== 'string' || !path.isAbsolute(o.cwd)) return { ok: false, error: 'cwd must be an absolute path' };
      cwds = [norm(o.cwd)];
    } else {
      const seen = new Set();
      for (const j of queueJobs) if (isObj(j) && typeof j.cwd === 'string' && path.isAbsolute(j.cwd)) seen.add(norm(j.cwd));
      let recent = [];
      try { recent = (await loadRecentHistory()) || []; } catch { /* queue rows alone */ }
      for (const r of recent) if (isHistoryJobRow(r) && path.isAbsolute(r.cwd)) seen.add(norm(r.cwd));
      cwds = [...seen].sort();
    }
    // The rows' own cwds are the registered roots for the IPC (no machine scan);
    // the admin route passes its own registration source.
    const projectRoots = o.projectRoots || (() => cwds);

    const rows = rowsFor(cwds, queueJobs, loadProjectHistory);
    const epics = cwds.flatMap((cwd) => epicsOf(cwd, projectRoots));
    // A project with no rows and no Epic still gets its (empty) row.
    for (const cwd of cwds) if (!epics.some((e) => e.cwd === cwd)) epics.push({ cwd, epicId: '', events: [] });
    const { projects } = computeValidationQuality({ epics, rows, nowMs: now });
    return { ok: true, projects };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/**
 * GET /admin/validation-quality?cwd=<abs>
 *   → 200 { ok: true, project } | 400 missing/relative cwd | 404 unregistered project
 *   | 500 { ok: false, error } when the gather fails.
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ projectRoots?: () => string[], nowMs?: () => number, loadQueueJobs?: () => any, loadProjectHistory?: (cwd: string) => any[] }} [deps]
 */
function registerAdminRoute(adminHttp, deps = {}) {
  const { sendJson } = require('./lib/feedback-remote/localAdminHttp.cjs');
  adminHttp.registerRoute('GET', '/admin/validation-quality', async (/** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ query) => {
    const cwd = query && typeof query.get === 'function' ? query.get('cwd') : null;
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
      sendJson(res, 400, { ok: false, error: 'cwd must be an absolute path' });
      return;
    }
    const root = norm(cwd);
    try {
      require('./lib/opsOwnership.cjs').opsPath(root);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: errText(e) });
      return;
    }
    const { listArchived, defaultProjectRoots } = require('./promptSessionsIpc.cjs');
    const projectRoots = deps.projectRoots || defaultProjectRoots;
    try {
      listArchived(root, { projectRoots });
    } catch {
      sendJson(res, 404, { ok: false, error: 'not a registered project' });
      return;
    }
    const out = await gatherValidationQuality({
      cwd: root,
      nowMs: deps.nowMs ? deps.nowMs() : Date.now(),
      projectRoots,
      loadQueueJobs: deps.loadQueueJobs,
      loadProjectHistory: deps.loadProjectHistory,
    });
    if (!out.ok) {
      sendJson(res, 500, out);
      return;
    }
    const project = out.projects.find((p) => p.cwd === root) || out.projects[0] || null;
    sendJson(res, 200, { ok: true, project });
  });
}

/**
 * @param {{ ipcMain?: { handle: Function }, gather?: typeof gatherValidationQuality }} [deps]
 */
function registerValidationQualityHandlers(deps = {}) {
  const ipc = deps.ipcMain || require('electron').ipcMain;
  const gather = deps.gather || gatherValidationQuality;
  ipc.handle('history:validation-quality', async () => gather({ nowMs: Date.now() }));
}

module.exports = { gatherValidationQuality, registerValidationQualityHandlers, registerAdminRoute };
