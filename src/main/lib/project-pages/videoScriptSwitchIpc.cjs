'use strict';

/**
 * videoScriptSwitchIpc.cjs — IPC handlers over the per-project human switch
 * 'Scripts may run Demo Video' (videoScriptPress.cjs), shown and changed in
 * Project Home ▸ Video.
 *
 *   videos:script-switch-get  { cwd }          → { enabled, changedAt, by }
 *   videos:script-switch-set  { cwd, enabled } → { enabled, changedAt, by }
 *
 * script-switch-set is the human-click writer of setVideoScriptSwitch and
 * records by { via: 'ui' } (the other sanctioned writer is the agent route —
 * see videoScriptPress.cjs), then appends one 'video_script_switch_changed'
 * audit event. Payloads are validated by strict zod schemas (ipcSchemas.cjs)
 * and cwd goes through validatePath; an invalid payload rejects the invoke.
 * Renderer IPC only — mirrors tasks:get-switch / tasks:set-switch (taskIpc.cjs).
 *
 * deps: { schemas, validatePath } plus optional videoScriptPress /
 *       appendAuditEvent overrides for tests.
 */

const CHANNELS = Object.freeze(['videos:script-switch-get', 'videos:script-switch-set']);

function defaultAppendAuditEvent() {
  return require('../telemetry/auditLog.cjs').appendAuditEvent;
}

function registerVideoScriptSwitchIpc(ipcMain, deps = {}) {
  const press = () => deps.videoScriptPress || require('./videoScriptPress.cjs');

  ipcMain.handle('videos:script-switch-get', async (_event, rawPayload) => {
    const payload = deps.schemas.videosScriptSwitchGet.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    const entry = press().getVideoScriptSwitch(cwd);
    if (!entry) throw new Error('videos:script-switch-get: invalid cwd');
    return { enabled: entry.enabled, changedAt: entry.changedAt, by: entry.by };
  });

  ipcMain.handle('videos:script-switch-set', async (_event, rawPayload) => {
    const payload = deps.schemas.videosScriptSwitchSet.parse(rawPayload);
    const cwd = deps.validatePath(payload.cwd);
    const saved = press().setVideoScriptSwitch(cwd, payload.enabled, { via: 'ui' });
    const append = deps.appendAuditEvent || defaultAppendAuditEvent();
    append('video_script_switch_changed', { cwd: saved.cwd, enabled: saved.enabled, via: 'ui' });
    return { enabled: saved.enabled, changedAt: saved.changedAt, by: saved.by };
  });
}

module.exports = { registerVideoScriptSwitchIpc, CHANNELS };
