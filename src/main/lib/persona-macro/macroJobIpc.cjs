'use strict';

/**
 * macroJobIpc.cjs — IPC handlers `macros:dispatch-job` and `macros:job-status`.
 * Thin wiring over dispatchMacroJob / macroJobStatuses; every dependency is
 * injected (index.cjs passes the real scheduler, createPrd and archive).
 *
 * deps: { schemas, validatePath, readActiveIndex, createPrd, loadJobs,
 *         archivePrd, appendResponseEventWithReason?, dispatchMacroJob?,
 *         macroJobStatuses?, readHistoryTail?, builtins? }
 *
 * When a dispatch returns ok:false for an Epic that exists in the cwd's
 * active-index.json (and no build is already running for it — `activeSlug`),
 * one durable 'response' event marked `notice: 'job-not-queued'` is appended
 * to that Epic naming the macro, the error and the retry path (PRD 2950), so
 * a job-macro Epic whose build never queued cannot read as a silently running
 * session. The append is best effort: it never changes the returned result.
 * `createPrd` is called as `chat:create-prd` calls it, so its own
 * remote.requestReconcile() queues the row at once — no second rescan here.
 */

const { dispatchMacroJob: realDispatch } = require('./macroJobDispatch.cjs');
const { macroJobStatuses: realStatuses } = require('./macroJobStatus.cjs');
const { BUILTIN_MACROS } = require('./builtinMacros.cjs');

const JOB_NOT_QUEUED_NOTICE = 'job-not-queued';

function noticeText(label, error) {
  return `${label} background build was not queued: ${error} — press it again in Project Home ▸ Tools to retry.`;
}

function registerMacroJobIpc(ipcMain, deps = {}) {
  const dispatch = deps.dispatchMacroJob || realDispatch;
  const statuses = deps.macroJobStatuses || realStatuses;
  const builtins = deps.builtins || BUILTIN_MACROS;

  async function appendNotice(cwd, macroId, epicId, error) {
    if (typeof deps.appendResponseEventWithReason !== 'function') return;
    try {
      const macro = (builtins || []).find((m) => m && m.id === macroId);
      const label = (macro && macro.label) || macroId;
      const res = await deps.appendResponseEventWithReason(
        cwd, epicId, noticeText(label, error),
        { notice: JOB_NOT_QUEUED_NOTICE, allowInactive: true },
      );
      if (res && res.ok === false) console.warn('[macroJobIpc] job-not-queued notice not appended', epicId, res.reason);
    } catch (e) {
      console.warn('[macroJobIpc] job-not-queued notice append failed', epicId, e?.message ?? e);
    }
  }

  ipcMain.handle('macros:dispatch-job', async (_event, rawPayload) => {
    const payload = deps.schemas.macrosDispatchJob.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    const index = deps.readActiveIndex(cwd);
    const sessions = index && index.sessions ? index.sessions : {};
    const entry = Object.prototype.hasOwnProperty.call(sessions, payload.epicId) ? sessions[payload.epicId] : null;
    if (!entry) {
      return { ok: false, error: `epic ${payload.epicId} is not an active session in this project` };
    }
    if (entry.status !== 'active') {
      const refused = { ok: false, error: `epic ${payload.epicId} is not an active session in this project` };
      await appendNotice(cwd, payload.macroId, payload.epicId, refused.error);
      return refused;
    }
    let result;
    try {
      result = await dispatch(
        { cwd, macroId: payload.macroId, epicId: payload.epicId, extraInstructions: payload.extraInstructions, effort: payload.effort },
        {
          createPrd: deps.createPrd,
          listRows: async () => deps.loadJobs(),
          archivePrd: (slug, rowCwd) => deps.archivePrd(slug, rowCwd),
        },
      );
    } catch (e) {
      await appendNotice(cwd, payload.macroId, payload.epicId, e?.message ?? String(e));
      throw e;
    }
    if (result && result.ok === false && !result.activeSlug) {
      await appendNotice(cwd, payload.macroId, payload.epicId, result.error || 'unknown error');
    }
    return result;
  });

  ipcMain.handle('macros:job-status', async (_event, rawPayload) => {
    const payload = deps.schemas.macrosJobStatus.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    return statuses({ cwd }, {
      loadJobs: deps.loadJobs,
      ...(deps.readHistoryTail ? { readHistoryTail: deps.readHistoryTail } : {}),
    });
  });
}

module.exports = { registerMacroJobIpc, JOB_NOT_QUEUED_NOTICE };
