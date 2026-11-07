'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const cc = require('../lib/claudeConfig.cjs');

const dirs = [];
afterEach(async () => {
  while (dirs.length) await fsp.rm(dirs.pop(), { recursive: true, force: true });
});
async function mkRoot() {
  const d = await fsp.mkdtemp(path.join(os.homedir(), '.sm-claudecfg-'));
  dirs.push(d);
  config.addAllowedRoot(d);
  return d;
}
const rj = async (f) => JSON.parse(await fsp.readFile(f, 'utf8'));

test('registry resolves paths and rejects unknown file / unsupported scope', async () => {
  expect(cc.REGISTRY.settings.resolve('user', '/h', null)).toBe('/h/.claude/settings.json');
  expect(cc.REGISTRY.settings.resolve('local', '/h', '/p')).toBe('/p/.claude/settings.local.json');
  expect(cc.REGISTRY.claudeJson.resolve('user', '/h')).toBe('/h/.claude.json');
  expect(cc.REGISTRY.mcpJson.resolve('project', '/h', '/p')).toBe('/p/.mcp.json');
  await expect(cc.read({ fileId: 'nope', scope: 'user' })).rejects.toThrow(/unknown fileId/);
  await expect(cc.patch({ fileId: 'claudeJson', scope: 'project', cwd: '/x', keyPath: 'a', value: 1 }))
    .rejects.toThrow(/does not support scope/);
});

test('patch keeps other keys, including external writes between patches', async () => {
  const root = await mkRoot();
  const f = path.join(root, '.claude', 'settings.json');
  const a = { fileId: 'settings', scope: 'project', cwd: root };
  await cc.patch({ ...a, keyPath: 'model', value: 'opus' });
  const d = await rj(f);
  await fsp.writeFile(f, JSON.stringify({ ...d, external: true }));
  await cc.patch({ ...a, keyPath: 'permissions.allow', value: ['Bash'] });
  expect(await rj(f)).toEqual({ model: 'opus', external: true, permissions: { allow: ['Bash'] } });
  await cc.patch({ ...a, keyPath: 'permissions.allow', value: undefined });
  expect(await rj(f)).toEqual({ model: 'opus', external: true, permissions: {} });
  expect((await cc.read(a)).data.model).toBe('opus');
});

test('concurrent patches to one file both land', async () => {
  const root = await mkRoot();
  const a = { fileId: 'mcpJson', scope: 'project', cwd: root };
  await Promise.all(Array.from({ length: 10 }, (_, i) => cc.patch({ ...a, keyPath: ['mcpServers', `s${i}`], value: { i } })));
  const d = await rj(path.join(root, '.mcp.json'));
  expect(Object.keys(d.mcpServers).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`).sort());
});

test('invalid JSON refuses, names the path, leaves file untouched', async () => {
  const root = await mkRoot();
  const f = path.join(root, '.mcp.json');
  await fsp.writeFile(f, '{ broken');
  await expect(cc.patch({ fileId: 'mcpJson', scope: 'project', cwd: root, keyPath: 'a', value: 1 }))
    .rejects.toThrow(f);
  expect(await fsp.readFile(f, 'utf8')).toBe('{ broken');
});
