'use strict';

/**
 * macroJobIpc.cjs — IPC handlers `macros:dispatch-job` and `macros:job-status`.
 * Thin wiring over dispatchMacroJob / macroJobStatuses; every dependency is
 * injected (index.cjs passes the real scheduler, createPrd and archive).
 *
 * deps: { schemas, validatePath, readActiveIndex, createPrd, loadJobs,
 *         archivePrd, dispatchMacroJob?, macroJobStatuses?, readHistoryTail? }
 * `createPrd` is called as `chat:create-prd` calls it, so its own
 * remote.requestReconcile() queues the row at once — no second rescan here.
 */

const { dispatchMacroJob: realDispatch } = require('./macroJobDispatch.cjs');
const { macroJobStatuses: realStatuses } = require('./macroJobStatus.cjs');

function registerMacroJobIpc(ipcMain, deps = {}) {
  const dispatch = deps.dispatchMacroJob || realDispatch;
  const statuses = deps.macroJobStatuses || realStatuses;

  ipcMain.handle('macros:dispatch-job', async (_event, rawPayload) => {
    const payload = deps.schemas.macrosDispatchJob.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    const index = deps.readActiveIndex(cwd);
    const sessions = index && index.sessions ? index.sessions : {};
    const entry = Object.prototype.hasOwnProperty.call(sessions, payload.epicId) ? sessions[payload.epicId] : null;
    if (!entry || entry.status !== 'active') {
      return { ok: false, error: `epic ${payload.epicId} is not an active session in this project` };
    }
    return dispatch(
      { cwd, macroId: payload.macroId, epicId: payload.epicId, extraInstructions: payload.extraInstructions },
      {
        createPrd: deps.createPrd,
        listRows: async () => deps.loadJobs(),
        archivePrd: (slug, rowCwd) => deps.archivePrd(slug, rowCwd),
      },
    );
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

module.exports = { registerMacroJobIpc };
