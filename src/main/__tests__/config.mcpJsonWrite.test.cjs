'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');

const dirs = [];
afterEach(async () => {
  while (dirs.length) await fsp.rm(dirs.pop(), { recursive: true, force: true });
});

async function mk(tag) {
  const d = await fsp.mkdtemp(path.join(os.homedir(), `.sm-mcpjson-${tag}-`));
  dirs.push(d);
  return d;
}

test('<root>/.mcp.json is writable for a registered root', async () => {
  const root = await mk('ok');
  config.addAllowedRoot(root);
  const r = await config.writeJson(path.join(root, '.mcp.json'), { mcpServers: {} });
  expect(r.ok).toBe(true);
  expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(true);
});

test('other root-level files stay refused', async () => {
  const root = await mk('sib');
  config.addAllowedRoot(root);
  await expect(config.writeJson(path.join(root, 'package.json'), {}))
    .rejects.toThrow(/Write outside allowed write boundaries/);
});

test('a .mcp.json symlink escaping the root is refused', async () => {
  const root = await mk('link');
  const outside = await mk('outside');
  config.addAllowedRoot(root);
  const target = path.join(outside, 'victim.json');
  await fsp.writeFile(target, '{}');
  await fsp.symlink(target, path.join(root, '.mcp.json'));
  await expect(config.writeJson(path.join(root, '.mcp.json'), { x: 1 })).rejects.toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('{}');
});
