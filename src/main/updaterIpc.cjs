'use strict';

/**
 * updaterIpc.cjs — wires the autoUpdater.cjs state machine to the real electron-updater instance, the
 * persisted toggle (updaterSettings) and a busy signal (sessionSlots + live PTYs), and registers the
 * `updater:*` IPC handlers. Local renderer only: no remote/relay command (ipcSchemas ALLOWED_COMMANDS)
 * reaches the updater, and no handler accepts a URL, feed or provider — the feed is the app-update.yml
 * electron-builder bakes in.
 */

const { z } = require('zod');
const { isAutoUpdateSupported, createAutoUpdater } = require('./lib/autoUpdater.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

const schemas = {
  install: z.object({ force: z.boolean() }).strict(),
  setEnabled: z.object({ enabled: z.boolean() }).strict(),
};

function validated(schema, handler) {
  return (_event, payload) => handler(schema.parse(payload));
}

function defaultDeps() {
  return {
    loadUpdater: () => require('electron-updater').autoUpdater,
    isPackaged: () => require('./lib/appRuntime.cjs').isPackagedApp(),
    platform: process.platform,
    env: process.env,
    settings: require('./lib/updaterSettings.cjs'),
    sessionSlots: require('./lib/scheduler/sessionSlots.cjs'),
    currentVersion: () => require('electron').app.getVersion(),
    log: (message, meta) => {
      try {
        require('./logs.cjs').writeLine({ scope: 'updater', level: 'info', message, meta });
      } catch { /* logging must never break the updater */ }
    },
  };
}

/**
 * @param {{ ipcMain: any, getWindow: () => any, ptyManager: any, deps?: object }} opts
 * @returns {{ updater: object, ready: Promise<void> }}
 */
function registerUpdaterIpc({ ipcMain, getWindow, ptyManager, deps = {} }) {
  const d = { ...defaultDeps(), ...deps };
  const supported = isAutoUpdateSupported({ packaged: d.isPackaged() === true, platform: d.platform, env: d.env });

  // electron-updater is only ever loaded for a supported build — an unpackaged/npx run never touches it.
  let realUpdater = null;
  if (supported) {
    realUpdater = d.loadUpdater();
    if (realUpdater) realUpdater.logger = null;
  }

  let enabled = true;
  const isBusy = () => {
    const jobs = d.sessionSlots.inUse();
    const terminals = ptyManager && ptyManager.sessions ? ptyManager.sessions.size : 0;
    return { busy: jobs > 0 || terminals > 0, reason: `${jobs} job(s), ${terminals} terminal(s) running` };
  };
  const currentVersion = typeof d.currentVersion === 'function' ? d.currentVersion() : d.currentVersion;

  const updater = createAutoUpdater({
    updater: realUpdater,
    supported,
    currentVersion,
    isBusy,
    getEnabled: () => enabled,
    log: d.log,
  });

  const snapshot = () => ({ ...updater.status(), enabled });
  updater.subscribe(() => sendIfAlive(getWindow(), 'updater:status', snapshot()));

  ipcMain.handle('updater:status', () => snapshot());
  ipcMain.handle('updater:check', async () => {
    await updater.checkNow();
    return snapshot();
  });
  ipcMain.handle('updater:install', validated(schemas.install, ({ force }) => {
    updater.requestInstall({ force });
    return snapshot();
  }));
  ipcMain.handle('updater:cancel-deferred', () => {
    updater.cancelDeferred();
    return snapshot();
  });
  ipcMain.handle('updater:set-enabled', validated(schemas.setEnabled, async ({ enabled: next }) => {
    await d.settings.save({ enabled: next });
    enabled = next;
    updater.setEnabled(next);
    sendIfAlive(getWindow(), 'updater:status', snapshot());
    return snapshot();
  }));

  const ready = (async () => {
    try {
      const cfg = await d.settings.load();
      enabled = cfg.enabled !== false;
      if (enabled) updater.start();
    } catch (e) {
      d.log('updater start failed', { error: e && e.message });
    }
  })();

  return { updater, ready };
}

module.exports = { registerUpdaterIpc };
