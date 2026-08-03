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
