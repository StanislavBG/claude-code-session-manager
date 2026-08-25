/**
 * agentModelResolve.test.cjs — unit tests for resolveEpicModel: the shared
 * persona-model resolver both EpicTerminalPane.tsx's Terminal-view launch
 * and chatRunner.cjs's headless Chat-view launch should agree with.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/agentModelResolve.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  FALLBACK_MODEL,
  resolveEpicModel,
  findAgentTypeByClaudeSessionId,
  readPersonaModel,
} = require('../lib/agentModelResolve.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmpDir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeIndex(cwd, sessions) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions, events: {} }, null, 2));
}

function writePersona(globalDir, name, frontmatter) {
  fs.mkdirSync(globalDir, { recursive: true });
  const lines = ['---', `name: ${name}`, ...frontmatter, '---', 'body'];
  fs.writeFileSync(path.join(globalDir, `${name}.md`), lines.join('\n'));
}

const noopValidatePath = (p) => p;

test('resolves the agentType persona model for a matching Epic', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  writeIndex(cwd, { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-opus', agentType: 'opus-persona' } });
  writePersona(globalDir, 'opus-persona', ['model: opus']);

  const model = resolveEpicModel({
    cwd,
    claudeSessionId: 'sess-opus',
    deps: { globalDir, validatePath: noopValidatePath },
  });

  expect(model).toBe('opus');
});

test('falls back to the fallback model when the Epic has no agentType', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  writeIndex(cwd, { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-none' } });

  const model = resolveEpicModel({ cwd, claudeSessionId: 'sess-none' });

  expect(model).toBe(FALLBACK_MODEL);
});

test("falls back when the persona's model is 'inherit'", async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  writeIndex(cwd, { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-inherit', agentType: 'inherit-persona' } });
  writePersona(globalDir, 'inherit-persona', ['model: inherit']);

  const model = resolveEpicModel({
    cwd,
    claudeSessionId: 'sess-inherit',
    deps: { globalDir, validatePath: noopValidatePath },
  });

  expect(model).toBe(FALLBACK_MODEL);
});

test('falls back when no Epic matches the claudeSessionId', () => {
  const model = resolveEpicModel({ cwd: '/nonexistent-cwd-xyz', claudeSessionId: 'no-such-session' });
  expect(model).toBe(FALLBACK_MODEL);
});

test('never throws when cwd/claudeSessionId are missing', () => {
  expect(resolveEpicModel({})).toBe(FALLBACK_MODEL);
});

test('findAgentTypeByClaudeSessionId returns null for no match', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  writeIndex(cwd, {});
  expect(findAgentTypeByClaudeSessionId(cwd, 'missing')).toBeNull();
});

test('readPersonaModel returns null for a persona with no model field', async () => {
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  writePersona(globalDir, 'no-model-persona', []);
  expect(readPersonaModel('no-model-persona', { globalDir, validatePath: noopValidatePath })).toBeNull();
});

test('readPersonaModel returns null (never throws) for a path-traversal agentType rejected by validatePath', async () => {
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  const realValidatePath = (p) => {
    const real = path.resolve(p);
    if (!real.startsWith(path.resolve(globalDir) + path.sep)) throw new Error('outside allowed boundaries');
    return real;
  };
  expect(readPersonaModel('../../../etc/passwd', { globalDir, validatePath: realValidatePath })).toBeNull();
});

// READ side of the agentType FK: a persona that was valid when the Epic was
// created but got deleted afterward (rename/deletion in Agent Library) must
// still resolve to null, not throw — the WRITE side (epicMint.cjs's
// ensureEpic) is what refuses a bad reference at creation time.
test('readPersonaModel returns null (does not throw) for a persona deleted after the Epic was created, and logs it once via opsErrorLog', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-'); // never written to — simulates a deleted persona

  expect(() => readPersonaModel('deleted-persona', { globalDir, validatePath: noopValidatePath, cwd })).not.toThrow();
  expect(readPersonaModel('deleted-persona', { globalDir, validatePath: noopValidatePath, cwd })).toBeNull();

  const { todayFile } = require('../lib/opsErrorLog.cjs');
  const lines = fs.readFileSync(todayFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const matches = lines.filter((l) => l.message.includes('deleted-persona'));
  // Logged once despite two readPersonaModel calls above — dedup key is (cwd, agentType).
  expect(matches).toHaveLength(1);
  expect(matches[0].level).toBe('warn');
});
