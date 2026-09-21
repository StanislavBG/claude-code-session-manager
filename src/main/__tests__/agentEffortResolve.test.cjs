/**
 * agentEffortResolve.test.cjs — the effort twin of agentModelResolve.test.cjs:
 * persona `effort:` wins (overlay beats global), inherit/absent/dangling → no flag.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/agentEffortResolve.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveEpicEffort, effortArgs } = require('../lib/agentEffortResolve.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTmpDir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeIndex(cwd, sessions) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions, events: {} }));
}

function writePersona(dir, name, frontmatter) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), ['---', `name: ${name}`, ...frontmatter, '---', 'body'].join('\n'));
}

const noopValidatePath = (p) => p;

test('persona effort wins (global) for a matching Epic', async () => {
  const cwd = await mkTmpDir('sm-effort-cwd-');
  const globalDir = await mkTmpDir('sm-effort-agents-');
  writeIndex(cwd, { e1: { id: 'e1', claudeSessionId: 's1', agentType: 'p' } });
  writePersona(globalDir, 'p', ['effort: high']);
  expect(resolveEpicEffort({ cwd, claudeSessionId: 's1', deps: { globalDir, validatePath: noopValidatePath } }))
    .toEqual({ effort: 'high', source: 'persona' });
});

test('project overlay beats global', async () => {
  const cwd = await mkTmpDir('sm-effort-cwd-');
  const globalDir = await mkTmpDir('sm-effort-agents-');
  const projectDir = await mkTmpDir('sm-effort-proj-');
  writePersona(globalDir, 'p', ['effort: low']);
  writePersona(projectDir, 'p', ['effort: max']);
  expect(resolveEpicEffort({ cwd, agentType: 'p', deps: { globalDir, projectDir, validatePath: noopValidatePath } }))
    .toEqual({ effort: 'max', source: 'persona-overlay' });
});

test('inherit and absent resolve to null effort', async () => {
  const cwd = await mkTmpDir('sm-effort-cwd-');
  const globalDir = await mkTmpDir('sm-effort-agents-');
  writePersona(globalDir, 'inh', ['effort: inherit']);
  writePersona(globalDir, 'none', []);
  const deps = { globalDir, validatePath: noopValidatePath };
  expect(resolveEpicEffort({ cwd, agentType: 'inh', deps })).toEqual({ effort: null, source: 'inherit' });
  expect(resolveEpicEffort({ cwd, agentType: 'none', deps })).toEqual({ effort: null, source: 'inherit' });
});

test('dangling agentType / unknown Epic / empty opts resolve to null without throwing', async () => {
  const cwd = await mkTmpDir('sm-effort-cwd-');
  const globalDir = await mkTmpDir('sm-effort-agents-');
  writeIndex(cwd, {});
  const deps = { globalDir, validatePath: noopValidatePath };
  expect(resolveEpicEffort({ cwd, agentType: 'gone', deps })).toEqual({ effort: null, source: null });
  expect(resolveEpicEffort({ cwd, claudeSessionId: 'nope', deps })).toEqual({ effort: null, source: null });
  expect(resolveEpicEffort({})).toEqual({ effort: null, source: null });
  expect(resolveEpicEffort({ cwd, agentType: '../../etc/passwd', deps })).toEqual({ effort: null, source: null });
});

test('an unknown level is passed through unchanged (CLI warns and degrades)', async () => {
  const cwd = await mkTmpDir('sm-effort-cwd-');
  const globalDir = await mkTmpDir('sm-effort-agents-');
  writePersona(globalDir, 'odd', ['effort: turbo']);
  expect(resolveEpicEffort({ cwd, agentType: 'odd', deps: { globalDir, validatePath: noopValidatePath } }).effort).toBe('turbo');
});

test('effortArgs emits the pair only for a real level', () => {
  expect(effortArgs('high')).toEqual(['--effort', 'high']);
  for (const v of [null, undefined, '', 'inherit']) expect(effortArgs(v)).toEqual([]);
});
