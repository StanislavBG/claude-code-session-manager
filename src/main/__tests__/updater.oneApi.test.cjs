'use strict';
import { describe, it, expect, vi } from 'vitest';
const { getUpdateStatus } = require('../lib/updateCheck.cjs');
const { registerUpdaterIpc } = require('../updaterIpc.cjs');

const baseDeps = (over = {}) => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/x' },
  isPackaged: () => false,
  env: {},
  now: () => 1000,
  writeJson: async () => {},
  packageName: () => 'pkg',
  ...over,
});

describe('update probe respects auto-update setting', () => {
  it('does not fetch when auto-update is disabled', async () => {
    const fetchJson = vi.fn(async () => ({ latest: '2.0.0' }));
    const r = await getUpdateStatus({ deps: baseDeps({ fetchJson, isAutoUpdateEnabled: async () => false }) });
    expect(fetchJson).not.toHaveBeenCalled();
    expect(r.latest).toBeNull();
  });
  it('fetches when enabled; SM_UPDATE_CHECK=0 still disables', async () => {
    const fetchJson = vi.fn(async () => ({ latest: '2.0.0' }));
    const on = await getUpdateStatus({ deps: baseDeps({ fetchJson, isAutoUpdateEnabled: async () => true }) });
    expect(on).toMatchObject({ latest: '2.0.0', behind: true });
    const off = await getUpdateStatus({ deps: baseDeps({ fetchJson, env: { SM_UPDATE_CHECK: '0' }, isAutoUpdateEnabled: async () => true }) });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(off.latest).toBeNull();
  });
});

describe('updater:status carries the probe result', () => {
  it('includes check fields and passes the enabled flag', async () => {
    const handlers = {};
    const ipcMain = { handle: (n, f) => { handlers[n] = f; } };
    const getUpdateStatus2 = vi.fn(async ({ deps }) => ({
      current: '1.0.0', latest: '2.0.0', behind: true, channel: 'npm', enabledSeen: await deps.isAutoUpdateEnabled(),
    }));
    registerUpdaterIpc({
      ipcMain, getWindow: () => null, ptyManager: null,
      deps: {
        isPackaged: () => false, platform: 'linux', env: {}, currentVersion: '1.0.0',
        settings: { load: async () => ({ enabled: true }), save: async () => {} },
        sessionSlots: { inUse: () => 0 }, log: () => {}, getUpdateStatus: getUpdateStatus2,
      },
    });
    const s = await handlers['updater:status']();
    expect(s.check).toMatchObject({ latest: '2.0.0', behind: true, channel: 'npm' });
    expect(typeof s.check.enabledSeen).toBe('boolean');
  });
});
