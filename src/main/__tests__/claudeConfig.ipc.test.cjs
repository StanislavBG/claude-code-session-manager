'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const cc = require('../lib/claudeConfig.cjs');
const { schemas, validated } = require('../ipcSchemas.cjs');

const dirs = [];
afterEach(async () => {
  while (dirs.length) await fsp.rm(dirs.pop(), { recursive: true, force: true });
});

// Same wrapper shape index.cjs registers for claudeConfig:patch.
const patchHandler = validated(schemas.claudeConfigPatch, (p) => cc.patch(p));

test('malformed payloads are rejected', async () => {
  const ok = { fileId: 'settings', scope: 'user', keyPath: ['a'], value: 1 };
  expect(schemas.claudeConfigPatch.safeParse(ok).success).toBe(true);
  expect(schemas.claudeConfigPatch.safeParse({ ...ok, value: undefined }).success).toBe(true);
  for (const bad of [
    { ...ok, fileId: 'nope' },
    { ...ok, scope: 'global' },
    { ...ok, keyPath: [] },
    { ...ok, keyPath: [''] },
    { ...ok, keyPath: Array(9).fill('k') },
    { ...ok, keyPath: 'a.b' },
    { ...ok, extra: 1 },
  ]) {
    expect(schemas.claudeConfigPatch.safeParse(bad).success).toBe(false);
  }
  expect(() => patchHandler({}, { fileId: 'settings' })).toThrow();
  expect(schemas.claudeConfigRead.safeParse({ fileId: 'settings', scope: 'user', x: 1 }).success).toBe(false);
});

test('a valid patch writes the key and delete removes it', async () => {
  const root = await fsp.mkdtemp(path.join(os.homedir(), '.sm-claudecfg-ipc-'));
  dirs.push(root);
  config.addAllowedRoot(root);
  const base = { fileId: 'settings', scope: 'project', cwd: root };
  const res = await patchHandler({}, { ...base, keyPath: ['permissions', 'defaultMode'], value: 'plan' });
  expect(res.ok).toBe(true);
  const f = path.join(root, '.claude', 'settings.json');
  expect(JSON.parse(await fsp.readFile(f, 'utf8'))).toEqual({ permissions: { defaultMode: 'plan' } });
  await patchHandler({}, { ...base, keyPath: ['permissions', 'defaultMode'] });
  expect(JSON.parse(await fsp.readFile(f, 'utf8'))).toEqual({ permissions: {} });
});
