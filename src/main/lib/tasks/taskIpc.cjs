'use strict';

/**
 * taskIpc.cjs — renderer IPC for the Scheduler Tasks section.
 *
 *   tasks:list        { cwd, ...listTasks filters } → { ok, tasks, total, hasMore, skippedLines }
 *   tasks:get         { cwd, id }                   → { ok, task }   (task null when absent)
 *   tasks:get-switch  { cwd }                       → { ok, enabled }
 *   tasks:set-switch  { cwd, enabled }              → { ok, enabled, changedAt }
 *
 * tasks:set-switch is the ONLY caller of taskSwitch.setTaskSwitch — the switch
 * is a human decision made in the renderer (see taskSwitch.cjs). After every
 * write, and once at registration, the held interactive slot in sessionSlots
 * is set to anyTaskSwitchOn(), so it is held exactly while some project has
 * Tasks on. Payloads are validated by strict zod schemas (ipcSchemas.cjs);
 * an invalid payload rejects the invoke.
 */

const { schemas, validated } = require('../../ipcSchemas.cjs');
const taskLedger = require('./taskLedger.cjs');
const taskSwitch = require('./taskSwitch.cjs');
const sessionSlots = require('../scheduler/sessionSlots.cjs');
const auditLog = require('../telemetry/auditLog.cjs');

function errMsg(err) {
  return err && err.message ? err.message : String(err);
}

function syncInteractiveReserve() {
  return sessionSlots.setInteractiveReserve(taskSwitch.anyTaskSwitchOn());
}

/**
 * @param {{ ipcMain?: any }} [opts]
 */
function registerTaskIpc(opts = {}) {
  const ipcMain = opts.ipcMain || require('electron').ipcMain;

  ipcMain.handle('tasks:list', validated(schemas.TaskListQuery, async ({ cwd, ...filters }) => {
    try {
      const res = await taskLedger.listTasks(cwd, filters);
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }));

  ipcMain.handle('tasks:get', validated(schemas.TaskGetQuery, async ({ cwd, id }) => {
    try {
      const task = await taskLedger.getTask(cwd, id);
      return { ok: true, task };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }));

  ipcMain.handle('tasks:get-switch', validated(schemas.TaskSwitchQuery, async ({ cwd }) => {
    try {
      return { ok: true, enabled: taskSwitch.isTaskSwitchOn(cwd) };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }));

  ipcMain.handle('tasks:set-switch', validated(schemas.TaskSwitchSet, async ({ cwd, enabled }) => {
    try {
      const saved = taskSwitch.setTaskSwitch(cwd, enabled);
      auditLog.appendAuditEvent('task_switch_changed', { cwd: saved.cwd, enabled: saved.enabled });
      return { ok: true, enabled: saved.enabled, changedAt: saved.changedAt };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    } finally {
      syncInteractiveReserve();
    }
  }));

  syncInteractiveReserve();
}

module.exports = { registerTaskIpc };
