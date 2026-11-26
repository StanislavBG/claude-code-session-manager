import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, driftOf } = require('../lint-persona-gear.cjs');

const persona = (tools, servers) => `---\nname: x\ntools: ${tools}${servers ? `\nmcpServers: ${servers}` : ''}\n---\nbody\n`;
const mk = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lpg-'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(d, n), t);
  return d;
};

test('consistent seeds pass', () => {
  const seedDir = mk({ 'a.md': persona('Read, mcp__blender__x', 'blender') });
  const r = run({ seedDir, homeDir: path.join(seedDir, 'none') });
  expect(r.failures).toEqual([]);
});

test('drift in seeds fails', () => {
  const seedDir = mk({ 'a.md': persona('Read, mcp__blender__x') });
  const r = run({ seedDir, homeDir: path.join(seedDir, 'none') });
  expect(r.failures).toHaveLength(1);
  expect(driftOf(persona('mcp__a__b, mcp__c__d', 'a'))).toEqual(['c']);
});

test('home-dir drift is a warning only', () => {
  const seedDir = mk({});
  const homeDir = mk({ 'a.md': persona('mcp__blender__x') });
  const r = run({ seedDir, homeDir });
  expect(r.failures).toEqual([]);
  expect(r.warnings).toHaveLength(1);
});
