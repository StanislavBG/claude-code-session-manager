'use strict';

/**
 * taskIpc.cjs — renderer IPC for the Scheduler Tasks section.
 *
 *   tasks:list        { cwd, ...listTasks filters } → { ok, tasks, total, hasMore, skippedLines }
 *   tasks:get         { cwd, id }                   → { ok, task }   (task null when absent)
 *   tasks:get-switch  { cwd }                       → { ok, enabled, changedAt, by }
 *   tasks:set-switch  { cwd, enabled }              → { ok, enabled, changedAt }
 *
 * tasks:list and tasks:get pass the in-process live registry's taskIds
 * (taskAdminRoutes.liveTaskIdsFor) as liveTaskIds, so a Task this app is
 * still running reads 'running' here exactly as it does on GET /admin/tasks
 * and GET /admin/task — never 'interrupted' past its window.
 *
 * tasks:set-switch is the human-click writer of taskSwitch.setTaskSwitch and
 * records by { via: 'ui' } (the other sanctioned writer is the agent route —
 * see taskSwitch.cjs). After every write, and once at registration,
 * taskSwitch.syncInteractiveReserve() holds the interactive slot exactly while
 * some project has Tasks on. Payloads are validated by strict zod schemas (ipcSchemas.cjs);
 * an invalid payload rejects the invoke.
 */

const { schemas, validated } = require('../../ipcSchemas.cjs');
const taskLedger = require('./taskLedger.cjs');
const taskSwitch = require('./taskSwitch.cjs');
const auditLog = require('../telemetry/auditLog.cjs');

function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * @param {{ ipcMain?: any }} [opts]
 */
function registerTaskIpc(opts = {}) {
  const ipcMain = opts.ipcMain || require('electron').ipcMain;

  ipcMain.handle('tasks:list', validated(schemas.TaskListQuery, async ({ cwd, ...filters }) => {
    try {
      const { liveTaskIdsFor } = require('./taskAdminRoutes.cjs');
      const res = await taskLedger.listTasks(cwd, { ...filters, liveTaskIds: liveTaskIdsFor(cwd) });
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }));

  ipcMain.handle('tasks:get', validated(schemas.TaskGetQuery, async ({ cwd, id }) => {
    try {
      const { liveTaskIdsFor } = require('./taskAdminRoutes.cjs');
      const task = await taskLedger.getTask(cwd, id, { liveTaskIds: liveTaskIdsFor(cwd) });
      return { ok: true, task };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }));

  ipcMain.handle('tasks:get-switch', validated(schemas.TaskSwitchQuery, async ({ cwd }) => {
    try {
      const entry = taskSwitch.getTaskSwitch(cwd);
      if (!entry) return { ok: false, error: 'tasks:get-switch: invalid cwd' };
      return { ok: true, enabled: entry.enabled, changedAt: entry.changedAt, by: entry.by };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }));

  ipcMain.handle('tasks:set-switch', validated(schemas.TaskSwitchSet, async ({ cwd, enabled }) => {
    try {
      const saved = taskSwitch.setTaskSwitch(cwd, enabled, { via: 'ui' });
      auditLog.appendAuditEvent('task_switch_changed', { cwd: saved.cwd, enabled: saved.enabled, via: 'ui' });
      return { ok: true, enabled: saved.enabled, changedAt: saved.changedAt };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    } finally {
      taskSwitch.syncInteractiveReserve();
    }
  }));

  taskSwitch.syncInteractiveReserve();
}

module.exports = { registerTaskIpc };
