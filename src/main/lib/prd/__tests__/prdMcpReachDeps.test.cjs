/**
 * prdMcpReachDeps.test.cjs — prdCreate's real mcpReachDeps against a temp HOME,
 * and updatePrd appending mcpReachWarnings when agentType changes.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdMcpReachDeps.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let config;
let prdCreate;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mcp-reach-deps-home-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  scheduler = require('../../../scheduler.cjs');
  queueStore = require('../../scheduler/queueStore.cjs');
  config = require('../../../config.cjs');
  prdCreate = require('../prdCreate.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('refusing to run outside temp HOME');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writePersona(name, body) {
  fs.writeFileSync(path.join(tmpHome, '.claude', 'agents', `${name}.md`), body, 'utf8');
}

test('readPersonaServers returns declared and tool-named servers', () => {
  writePersona('reach-p', '---\nname: reach-p\ndescription: d\ntools: Read, mcp__xsrv__y\nmcpServers: zsrv\n---\nBody\n');
  const got = prdCreate.mcpReachDeps.readPersonaServers({ agentType: 'reach-p', cwd: tmpHome });
  expect([...got].sort()).toEqual(['xsrv', 'zsrv']);
});

test('readPersonaServers never throws on an unreadable persona', () => {
  writePersona('reach-bad', '\0\0 not frontmatter');
  let out;
  expect(() => { out = prdCreate.mcpReachDeps.readPersonaServers({ agentType: 'reach-bad', cwd: tmpHome }); }).not.toThrow();
  expect(out == null || (Array.isArray(out) && out.length === 0)).toBe(true);
  expect(() => prdCreate.mcpReachDeps.readPersonaServers({ agentType: 'does-not-exist', cwd: '/nonexistent' })).not.toThrow();
});

test('updatePrd changing agentType to a persona naming an undefined server warns', async () => {
  writePersona('reach-undef', '---\nname: reach-undef\ndescription: d\ntools: Read\nmcpServers: ghostsrv\n---\nBody\n');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mcp-reach-upd-'));
  try {
    const slugDir = path.join(tmpHome, '.claude', 'projects', 'fake-reach');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, 't.jsonl'), JSON.stringify({ cwd }) + '\n');
    config.addAllowedRoot(cwd);
    const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'e1', 'prds');
    const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }), 'utf8');
    queueStore.bustCwdCache();
    fs.writeFileSync(path.join(prdsDir, '4-w.md'),
      `---\ntitle: w\ncwd: ${cwd}\nestimateMinutes: 10\ncreatedVia: scheduler-api\n---\n\n# Goal\nx\n`, 'utf8');
    const r = await scheduler.remote.updatePrd({ slug: '4-w', cwd, frontmatter: { agentType: 'reach-undef' } });
    expect(r.ok).toBe(true);
    expect((r.warnings || []).join('\n')).toMatch(/ghostsrv/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
