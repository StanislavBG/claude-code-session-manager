'use strict';

import { describe, it, expect, vi } from 'vitest';

const { registerLoginItemIpc } = require('../loginItemIpc.cjs');

const STATUS = { supported: true, enabled: false, mechanism: 'autostart-desktop', starts: 'npx', entryPath: '/h/x.desktop', reason: null };

function setup(loginItem) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  registerLoginItemIpc({ ipcMain, loginItem });
  const call = (ch, payload) => handlers.get(ch)({}, payload);
  return { handlers, call };
}

function fakeModule(overrides = {}) {
  return {
    status: vi.fn(() => STATUS),
    setEnabled: vi.fn(async (on) => ({ ...STATUS, enabled: on })),
    ...overrides,
  };
}

describe('registerLoginItemIpc', () => {
  it('registers exactly the two channels', () => {
    const t = setup(fakeModule());
    expect([...t.handlers.keys()].sort()).toEqual(['loginItem:set-enabled', 'loginItem:status']);
  });

  it('loginItem:status answers the module status()', async () => {
    const m = fakeModule();
    const t = setup(m);
    expect(await t.call('loginItem:status')).toEqual(STATUS);
    expect(m.status).toHaveBeenCalledTimes(1);
  });

  it('loginItem:set-enabled switches and answers { ok: true, status }', async () => {
    const m = fakeModule();
    const t = setup(m);
    const r = await t.call('loginItem:set-enabled', { enabled: true });
    expect(m.setEnabled).toHaveBeenCalledWith(true);
    expect(r).toEqual({ ok: true, status: { ...STATUS, enabled: true } });
  });

  it('a bad payload answers { ok: false, error } without calling the module', async () => {
    const m = fakeModule();
    const t = setup(m);
    for (const bad of [undefined, null, {}, { enabled: 'yes' }, { enabled: true, extra: 1 }, 'true']) {
      const r = await t.call('loginItem:set-enabled', bad);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
    }
    expect(m.setEnabled).not.toHaveBeenCalled();
  });

  it('a module error answers { ok: false, error: <the message> }', async () => {
    const m = fakeModule({ setEnabled: vi.fn(async () => { throw new Error('/h/x.desktop was not written by Session Manager; leaving it alone.'); }) });
    const t = setup(m);
    const r = await t.call('loginItem:set-enabled', { enabled: false });
    expect(r).toEqual({ ok: false, error: '/h/x.desktop was not written by Session Manager; leaving it alone.' });
  });
});
