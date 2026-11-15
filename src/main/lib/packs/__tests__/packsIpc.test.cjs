'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { registerPacksHandlers } = require('../packsIpc.cjs');

function fakeIpc() {
  const handlers = {};
  return { handlers, ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } };
}

test('packs:list returns display fields only — no dir, laws, or pluginName', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const listPacks = () => ({
    packs: [
      { id: 'ios', label: 'iOS', description: 'Swift rules', dir: '/secret/ios', pluginName: 'sm-pack-ios', laws: 'RULE TEXT', requires: { platform: 'darwin' } },
      { id: 'web', label: 'Web', description: 'Web rules', dir: '/secret/web', pluginName: 'sm-pack-web', laws: '', requires: {} },
    ],
    errors: [{ dir: '/secret/bad', error: 'broken' }],
  });
  registerPacksHandlers({ ipcMain, listPacks });
  assert.equal(typeof handlers['packs:list'], 'function');
  const res = await handlers['packs:list']({});
  assert.deepEqual(res, {
    ok: true,
    packs: [
      { id: 'ios', label: 'iOS', description: 'Swift rules', requires: { platform: 'darwin' }, hasLaws: true },
      { id: 'web', label: 'Web', description: 'Web rules', requires: {}, hasLaws: false },
    ],
  });
  for (const p of res.packs) {
    assert.ok(!('dir' in p));
    assert.ok(!('laws' in p));
  }
  assert.ok(!JSON.stringify(res).includes('/secret'));
  assert.ok(!JSON.stringify(res).includes('RULE TEXT'));
});

test('packs:list returns { ok: false, error } when listing throws', async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPacksHandlers({ ipcMain, listPacks: () => { throw new Error('boom'); } });
  const res = await handlers['packs:list']({});
  assert.deepEqual(res, { ok: false, error: 'boom' });
});

test('defaults listPacks to the shipped catalog', async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPacksHandlers({ ipcMain });
  const res = await handlers['packs:list']({});
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.packs));
  for (const p of res.packs) assert.deepEqual(Object.keys(p).sort(), ['description', 'hasLaws', 'id', 'label', 'requires']);
});
