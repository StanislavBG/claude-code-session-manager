'use strict';

/**
 * telemetryIpc.cjs — registers the `otel:*` and `telemetry:*` IPC handlers. Moved verbatim out of
 * index.cjs; channel names and handler bodies are unchanged.
 */

const { schemas, validated } = require('./ipcSchemas.cjs');
const otel = require('./otel.cjs');
const otelSettings = require('./otelSettings.cjs');
const telemetrySettings = require('./lib/telemetrySettings.cjs');
const telemetryClient = require('./lib/telemetryClient.cjs');
const telemetryBacklog = require('./lib/telemetryBacklog.cjs');
const telemetryConsent = require('./lib/telemetryConsent.cjs');

/**
 * @param {{ ipcMain: any }} opts
 */
function registerTelemetryHandlers({ ipcMain }) {
  // OTEL telemetry export (opt-in via ~/.claude/session-manager/otel.json).
  ipcMain.handle('otel:get-config', async () => otelSettings.load());
  ipcMain.handle('otel:set-config', async (_e, cfg) => {
    if (!otelSettings.isValid(cfg)) {
      return { ok: false, error: 'invalid config' };
    }
    const saved = await otelSettings.save(cfg);
    const result = await otel.applyConfig(saved);
    return { ok: !!result?.ok, error: result?.error ?? null, config: saved, status: otel.status() };
  });
  ipcMain.handle('otel:status', () => otel.status());
  ipcMain.handle('otel:config-path', () => otelSettings.storePath());

  // Product telemetry (bilko.run) — anonymous, on-by-default, opt-out consent
  // UX + inspector over the client PRDs above wired. Settings > Telemetry's
  // "Product telemetry" section is the sole UI surface for this; see
  // session-manager-operations/architecture/telemetry.md for the data model.
  ipcMain.handle('telemetry:get-config', async () => telemetrySettings.load());
  ipcMain.handle('telemetry:set-config', validated(schemas.telemetrySetConfig, async (cfg) => {
    const saved = await telemetryConsent.applyConsentUpdate(cfg, { telemetrySettings, telemetryClient });
    return { ok: true, config: saved, status: telemetryClient.status() };
  }));
  ipcMain.handle('telemetry:status', () => ({
    ...telemetryClient.status(),
    backlog: telemetryBacklog.lastRunSummary(),
  }));
  ipcMain.handle('telemetry:config-path', () => telemetrySettings.storePath());
  ipcMain.handle('telemetry:recent-records', () => telemetryClient.recentRecords());
  ipcMain.handle('telemetry:flush-now', () => telemetryClient.flush('manual'));
}

module.exports = { registerTelemetryHandlers };
