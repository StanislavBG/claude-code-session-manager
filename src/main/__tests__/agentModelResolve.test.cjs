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
  readOverlayAwarePersonaModel,
  resolvePrdPersonaForSpawn,
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

test('readOverlayAwarePersonaModel returns null for a persona with no model field', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  writePersona(globalDir, 'no-model-persona', []);
  expect(readOverlayAwarePersonaModel('no-model-persona', { cwd, globalDir, validatePath: noopValidatePath })).toBeNull();
});

test('readOverlayAwarePersonaModel returns null (never throws) for a path-traversal agentType rejected by validatePath', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  const realValidatePath = (p) => {
    const real = path.resolve(p);
    if (!real.startsWith(path.resolve(globalDir) + path.sep)) throw new Error('outside allowed boundaries');
    return real;
  };
  expect(readOverlayAwarePersonaModel('../../../etc/passwd', { cwd, globalDir, validatePath: realValidatePath })).toBeNull();
});

// READ side of the agentType FK: a persona that was valid when the Epic was
// created but got deleted afterward (rename/deletion in Agent Library) must
// still resolve to null, not throw — the WRITE side (epicMint.cjs's
// ensureEpic) is what refuses a bad reference at creation time.
test('readOverlayAwarePersonaModel returns null (does not throw) for a persona deleted after the Epic was created, and logs it once via opsErrorLog', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-'); // never written to — simulates a deleted persona

  expect(() => readOverlayAwarePersonaModel('deleted-persona', { globalDir, validatePath: noopValidatePath, cwd })).not.toThrow();
  expect(readOverlayAwarePersonaModel('deleted-persona', { globalDir, validatePath: noopValidatePath, cwd })).toBeNull();

  const { todayFile } = require('../lib/opsErrorLog.cjs');
  const lines = fs.readFileSync(todayFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const matches = lines.filter((l) => l.message.includes('deleted-persona'));
  // Logged once despite two readOverlayAwarePersonaModel calls above — dedup key is (cwd, agentType).
  expect(matches).toHaveLength(1);
  expect(matches[0].level).toBe('warn');
});

// resolvePrdPersonaForSpawn — the PRD-path resolver scheduler.cjs's executeJob
// calls to turn a job's agentType into a --append-system-prompt body and a
// --model value (PRD 1115).

test('resolvePrdPersonaForSpawn returns the persona body and its own model, overriding the fallback', async () => {
  const result = await resolvePrdPersonaForSpawn({
    cwd: '/irrelevant',
    agentType: 'dev-lead',
    deps: {
      getPersonaBody: async ({ name }) => {
        expect(name).toBe('dev-lead');
        return { path: '/home/user/.claude/agents/dev-lead.md', text: '---\nmodel: opus\n---\nOperate methodically.' };
      },
    },
  });
  expect(result.model).toBe('opus');
  expect(result.systemPrompt).toBe('Operate methodically.');
  expect(result.personaPath).toBe('/home/user/.claude/agents/dev-lead.md');
});

test("resolvePrdPersonaForSpawn falls back to the fallback model when the persona's model is 'inherit'", async () => {
  const result = await resolvePrdPersonaForSpawn({
    cwd: '/irrelevant',
    agentType: 'dev-lead',
    deps: { getPersonaBody: async () => ({ path: '/x/dev-lead.md', text: '---\nmodel: inherit\n---\nBody text.' }) },
  });
  expect(result.model).toBe(FALLBACK_MODEL);
});

test('resolvePrdPersonaForSpawn falls back without throwing when agentType no longer resolves to a persona file, and logs it once', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const call = () => resolvePrdPersonaForSpawn({
    cwd,
    agentType: 'ghost-persona',
    deps: { getPersonaBody: async () => null },
  });
  await expect(call()).resolves.toEqual({ model: FALLBACK_MODEL, systemPrompt: null, personaPath: null });
  await call(); // second call must not log a second line (dedup)

  const { todayFile } = require('../lib/opsErrorLog.cjs');
  const lines = fs.readFileSync(todayFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const matches = lines.filter((l) => l.message.includes('ghost-persona'));
  expect(matches).toHaveLength(1);
  expect(matches[0].level).toBe('warn');
});

test('resolvePrdPersonaForSpawn returns the fallback (no persona applied) when agentType is absent, without touching getPersonaBody', async () => {
  const getPersonaBody = async () => { throw new Error('must not be called'); };
  const result = await resolvePrdPersonaForSpawn({ cwd: '/irrelevant', agentType: null, deps: { getPersonaBody } });
  expect(result).toEqual({ model: FALLBACK_MODEL, systemPrompt: null, personaPath: null });
});

// Overlay-aware resolution (unify-epic-model-resolution): resolveEpicModel
// must use the SAME project-overlay-then-global precedence
// resolvePrdPersonaForSpawn already uses — so a project's
// `.claude/agents/<name>.md` wins for a launched Chat/Terminal session
// exactly like it already does for a scheduled PRD.

test('resolveEpicModel prefers a project-overlay persona over the global one with the same name', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  writeIndex(cwd, { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-overlay', agentType: 'shared-persona' } });
  writePersona(globalDir, 'shared-persona', ['model: opus']);
  const projectAgentsDir = path.join(cwd, '.claude', 'agents');
  writePersona(projectAgentsDir, 'shared-persona', ['model: haiku']);

  const model = resolveEpicModel({
    cwd,
    claudeSessionId: 'sess-overlay',
    deps: { globalDir, validatePath: noopValidatePath },
  });

  expect(model).toBe('haiku');
});

test('resolveEpicModel falls through to the global persona when no project overlay exists', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  writeIndex(cwd, { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-global-only', agentType: 'global-only-persona' } });
  writePersona(globalDir, 'global-only-persona', ['model: opus']);

  const model = resolveEpicModel({
    cwd,
    claudeSessionId: 'sess-global-only',
    deps: { globalDir, validatePath: noopValidatePath },
  });

  expect(model).toBe('opus');
});

test('resolveEpicModel falls back to FALLBACK_MODEL (never throws) for a dangling agentType with no persona file anywhere, and logs it once', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-'); // never written to
  writeIndex(cwd, { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-dangling', agentType: 'ghost-persona' } });

  const call = () => resolveEpicModel({
    cwd,
    claudeSessionId: 'sess-dangling',
    deps: { globalDir, validatePath: noopValidatePath },
  });

  expect(call).not.toThrow();
  expect(call()).toBe(FALLBACK_MODEL);
  call(); // second call must not log a second line (dedup per (cwd, agentType))

  const { todayFile } = require('../lib/opsErrorLog.cjs');
  const lines = fs.readFileSync(todayFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const matches = lines.filter((l) => l.message.includes('ghost-persona'));
  expect(matches).toHaveLength(1);
});

// Chat (chatRunner.cjs, in-process) and Terminal (EpicTerminalPane.tsx, via
// the agents:resolve-epic-model IPC added in this change) both call this
// exact function with the same { cwd, claudeSessionId } shape — so "the same
// Epic resolves identically in both views" is structural (one function, one
// call signature), not a coincidence of two implementations agreeing. This
// asserts the function is a pure, deterministic read of that Epic's overlay-
// resolved persona model, which is what makes that guarantee hold.
test('resolveEpicModel resolves identically for the same Epic across repeated calls (the guarantee Chat and Terminal both rely on)', async () => {
  const cwd = await mkTmpDir('sm-agentmodel-cwd-');
  const globalDir = await mkTmpDir('sm-agentmodel-agents-');
  writeIndex(cwd, { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-shared', agentType: 'shared-epic-persona' } });
  writePersona(globalDir, 'shared-epic-persona', ['model: haiku']);

  const callArgs = { cwd, claudeSessionId: 'sess-shared', deps: { globalDir, validatePath: noopValidatePath } };
  const chatResult = resolveEpicModel(callArgs);
  const terminalResult = resolveEpicModel(callArgs); // simulates the IPC-forwarded call Terminal makes

  expect(chatResult).toBe('haiku');
  expect(terminalResult).toBe(chatResult);
});

// --model must never be left unpinned (CLAUDE.md model-pinning rule) on any
// of the three launch paths. resolvePrdPersonaForSpawn's own miss-path tests
// above already cover the scheduler call site; this covers the shared
// Chat/Terminal resolver.
test('resolveEpicModel never returns an empty/falsy --model value, even on every miss path', async () => {
  expect(resolveEpicModel({})).toBeTruthy();
  expect(resolveEpicModel({ cwd: '/nonexistent-cwd-xyz', claudeSessionId: 'no-such-session' })).toBeTruthy();
});

test('resolvePrdPersonaForSpawn caps the persona body at 6000 characters with a truncation notice naming the persona path', async () => {
  const longBody = 'x'.repeat(6500);
  const result = await resolvePrdPersonaForSpawn({
    cwd: '/irrelevant',
    agentType: 'dev-lead',
    deps: { getPersonaBody: async () => ({ path: '/home/user/.claude/agents/dev-lead.md', text: longBody }) },
  });
  expect(result.systemPrompt.startsWith('x'.repeat(6000))).toBe(true);
  expect(result.systemPrompt.length).toBeLessThan(longBody.length);
  expect(result.systemPrompt.toLowerCase()).toContain('truncat');
  expect(result.systemPrompt).toContain('/home/user/.claude/agents/dev-lead.md');
});
