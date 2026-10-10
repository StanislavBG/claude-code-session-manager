'use strict';

import { describe, it, expect, vi } from 'vitest';

const { registerUpdaterIpc } = require('../updaterIpc.cjs');
const { ALLOWED_COMMANDS } = require('../ipcSchemas.cjs');

function setup({ packaged = true, jobs = 0, terminals = 0, enabled = true } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const listeners = {};
  const fakeUpdater = {
    on: vi.fn((ev, fn) => { listeners[ev] = fn; }),
    checkForUpdates: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
  };
  const loadUpdater = vi.fn(() => fakeUpdater);
  const settings = {
    load: vi.fn(async () => ({ enabled, schemaVersion: 1 })),
    save: vi.fn(async (p) => ({ ...p, schemaVersion: 1 })),
  };
  const sessionSlots = { inUse: vi.fn(() => jobs) };
  const ptyManager = { sessions: new Map(Array.from({ length: terminals }, (_, i) => [`t${i}`, {}])) };
  const reg = registerUpdaterIpc({
    ipcMain,
    getWindow: () => null,
    ptyManager,
    deps: {
      loadUpdater, settings, sessionSlots,
      isPackaged: () => packaged, platform: 'win32', env: {},
      currentVersion: '1.0.0', log: () => {},
    },
  });
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { handlers, call, listeners, loadUpdater, settings, reg, fakeUpdater };
}

describe('registerUpdaterIpc', () => {
  it('never loads electron-updater on an unsupported build', async () => {
    const t = setup({ packaged: false });
    await t.reg.ready;
    expect(t.loadUpdater).not.toHaveBeenCalled();
    expect((await t.call('updater:status')).state).toBe('unsupported');
  });

  it('install with jobs running defers', async () => {
    const t = setup({ jobs: 2, terminals: 1 });
    await t.reg.ready;
    await t.call('updater:check');
    t.listeners['update-downloaded']({ version: '2.0.0' });
    const s = await t.call('updater:install', { force: false });
    expect(s.state).toBe('deferred');
    expect(s.busyReason).toBe('2 job(s), 1 terminal(s) running');
    expect(t.fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    t.reg.updater.stop();
  });

  it('set-enabled false persists and disables', async () => {
    const t = setup();
    await t.reg.ready;
    const s = await t.call('updater:set-enabled', { enabled: false });
    expect(t.settings.save).toHaveBeenCalledWith({ enabled: false });
    expect(s.state).toBe('disabled');
    expect(s.enabled).toBe(false);
    t.reg.updater.stop();
  });

  it('rejects install payloads with extra keys', () => {
    const t = setup();
    expect(() => t.call('updater:install', { force: true, url: 'x' })).toThrow();
    expect(() => t.call('updater:set-enabled', { enabled: true, feed: 'x' })).toThrow();
  });

  it('exposes no remote updater command', () => {
    for (const c of ALLOWED_COMMANDS) expect(String(c).startsWith('cmd:updater')).toBe(false);
  });
});
