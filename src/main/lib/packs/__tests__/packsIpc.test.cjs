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

test('packs:terminal-args returns plugin-dir args plus laws for an Epic with packs', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const seen = [];
  const findEpic = (cwd, id) => { seen.push([cwd, id]); return { claudeSessionId: id, packs: ['ios', 'web'] }; };
  const composePackSpawnArgs = ({ packIds }) => {
    assert.deepEqual(packIds, ['ios', 'web']);
    return { pluginDirArgs: ['--plugin-dir', '/p/ios', '--plugin-dir', '/p/web'], laws: "# Laws\nDon't", unknown: [] };
  };
  registerPacksHandlers({ ipcMain, listPacks: () => ({ packs: [] }), findEpic, composePackSpawnArgs });
  const res = await handlers['packs:terminal-args']({}, { cwd: '/proj', claudeSessionId: 'sid-1' });
  assert.deepEqual(seen, [['/proj', 'sid-1']]);
  assert.deepEqual(res, {
    ok: true,
    args: ['--plugin-dir', '/p/ios', '--plugin-dir', '/p/web', '--append-system-prompt', "# Laws\nDon't"],
  });
});

test('packs:terminal-args omits --append-system-prompt when laws is empty', async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPacksHandlers({
    ipcMain,
    findEpic: () => ({ packs: ['web'] }),
    composePackSpawnArgs: () => ({ pluginDirArgs: ['--plugin-dir', '/p/web'], laws: '', unknown: [] }),
  });
  const res = await handlers['packs:terminal-args']({}, { cwd: '/proj', claudeSessionId: 'sid' });
  assert.deepEqual(res, { ok: true, args: ['--plugin-dir', '/p/web'] });
});

test('packs:terminal-args returns [] for an Epic without packs, a missing Epic, or a lookup error', async () => {
  const compose = () => { throw new Error('must not compose'); };
  for (const findEpic of [
    () => ({ packs: [] }),
    () => ({}),
    () => null,
    () => { throw new Error('index unreadable'); },
  ]) {
    const { handlers, ipcMain } = fakeIpc();
    registerPacksHandlers({ ipcMain, findEpic, composePackSpawnArgs: compose });
    assert.deepEqual(await handlers['packs:terminal-args']({}, { cwd: '/proj', claudeSessionId: 'sid' }), { ok: true, args: [] });
  }
  const { handlers, ipcMain } = fakeIpc();
  registerPacksHandlers({ ipcMain, findEpic: () => ({ packs: ['ios'] }), composePackSpawnArgs: compose });
  assert.deepEqual(await handlers['packs:terminal-args']({}, { cwd: '/proj', claudeSessionId: 'sid' }), { ok: true, args: [] });
  assert.deepEqual(await handlers['packs:terminal-args']({}, undefined), { ok: true, args: [] });
});

test('packs:terminal-args returns [] for an agent-CLI Epic', async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPacksHandlers({
    ipcMain,
    findEpic: () => ({ agentCli: 'opencode', packs: ['ios'] }),
    composePackSpawnArgs: () => ({ pluginDirArgs: ['--plugin-dir', '/p/ios'], laws: 'x', unknown: [] }),
  });
  const res = await handlers['packs:terminal-args']({}, { cwd: '/proj', claudeSessionId: 'sid' });
  assert.deepEqual(res, { ok: true, args: [] });
});
