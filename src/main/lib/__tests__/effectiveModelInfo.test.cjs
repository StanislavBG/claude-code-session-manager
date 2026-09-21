/**
 * effectiveModelInfo.test.cjs — the main-process half of "what will this
 * Epic actually run as": overlay-aware persona alias resolution plus
 * evidence-based concrete model id (scheduler run log, then session
 * transcript), never fabricated when there's no evidence.
 *
 * All fixtures live under a per-test mkdtemp'd $HOME (never the real
 * ~/.claude) so persona lookup (which reads os.homedir()), scheduler run
 * logs, and transcripts all resolve consistently.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/effectiveModelInfo.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { encodeCwd } = require('../encodeCwd.cjs');
const { resolveEffectiveModelInfo, isConcreteModelId, computeEffortReachable } = require('../effectiveModelInfo.cjs');
// config.cjs's `allowedRoots` is a module-level singleton seeded from
// os.homedir() at FIRST require — since this test's HOME changes every test
// (fresh mkdtemp), a persona lookup (getPersonaBody -> validatePath) would
// only pass for whichever tmpHome happened to be active the first time
// config.cjs got lazily required. addAllowedRoot mutates the live Set
// instead, so every test's own tmpHome is explicitly admitted.
const { addAllowedRoot } = require('../../config.cjs');

let tmpHome;
let originalHome;
let cwd;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-effective-model-home-'));
  process.env.HOME = tmpHome;
  addAllowedRoot(tmpHome);
  cwd = path.join(tmpHome, 'project');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writePersona(dir, name, frontmatterLines) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', ...frontmatterLines, '---', 'Body text.'];
  fs.writeFileSync(path.join(dir, `${name}.md`), lines.join('\n'));
}

function writeGlobalPersona(name, frontmatterLines) {
  writePersona(path.join(tmpHome, '.claude', 'agents'), name, frontmatterLines);
}

function writeOverlayPersona(name, frontmatterLines) {
  writePersona(path.join(cwd, '.claude', 'agents'), name, frontmatterLines);
}

function writeActiveIndex(sessions) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions, events: {} }, null, 2));
}

function writeQueueJobs(jobs) {
  const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
}

function writeHistoryEntries(entries) {
  const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeRunLog(runId, slug, text) {
  const dir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.log`), text);
}

function writeTranscript(sessionId, lines) {
  const dir = path.join(tmpHome, '.claude', 'projects', encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// ---------- persona alias resolution ----------

test('resolves a global persona alias with modelSource "persona" and no fabricated evidence', async () => {
  writeGlobalPersona('writer', ['model: sonnet']);
  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'writer' });
  expect(info.modelAlias).toBe('sonnet');
  expect(info.modelSource).toBe('persona');
  expect(info.resolvedModelId).toBeNull();
  expect(info.resolvedFrom).toBeNull();
});

test('a persona model of "inherit" reports modelAlias null and modelSource "inherit"', async () => {
  writeGlobalPersona('inheriting', ['model: inherit']);
  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'inheriting' });
  expect(info.modelAlias).toBeNull();
  expect(info.modelSource).toBe('inherit');
});

test('a persona with no model field at all is treated the same as inherit', async () => {
  writeGlobalPersona('bare', []);
  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'bare' });
  expect(info.modelAlias).toBeNull();
  expect(info.modelSource).toBe('inherit');
});

test('a persona pinned to an already-concrete model id echoes it back with resolvedFrom null, ignoring conflicting evidence', async () => {
  writeGlobalPersona('pinned', ['model: claude-opus-5-2027']);
  // Conflicting scheduler evidence exists but must never override an
  // already-concrete alias — no evidence lookup should even be attempted.
  writeQueueJobs([{ slug: 'x', runId: 'r1', agentType: 'pinned', finishedAt: new Date().toISOString() }]);
  writeRunLog('r1', 'x', '[scheduler] agentType=pinned persona=/whatever model=claude-sonnet-1\n');

  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'pinned' });
  expect(info.modelAlias).toBe('claude-opus-5-2027');
  expect(info.modelSource).toBe('persona');
  expect(info.resolvedModelId).toBe('claude-opus-5-2027');
  expect(info.resolvedFrom).toBeNull();
});

test('a project-overlay persona wins over the global definition and reports modelSource "persona-overlay"', async () => {
  writeGlobalPersona('shared-name', ['model: sonnet']);
  writeOverlayPersona('shared-name', ['model: opus']);
  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'shared-name' });
  expect(info.modelAlias).toBe('opus');
  expect(info.modelSource).toBe('persona-overlay');
});

test('a dangling agentType (no persona file anywhere) resolves modelSource "fallback" without throwing', async () => {
  await expect(resolveEffectiveModelInfo({ cwd, agentType: 'ghost-persona' })).resolves.toBeTruthy();
  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'ghost-persona' });
  expect(info.modelAlias).toBeNull();
  expect(info.modelSource).toBe('fallback');
  expect(info.resolvedModelId).toBeNull();
});

// ---------- concrete-model-id evidence ----------

test('evidence hit via the scheduler run record: reads the model logged in the most recent matching job\'s run log', async () => {
  writeGlobalPersona('runner', ['model: sonnet']);
  writeQueueJobs([
    { slug: 'older', runId: 'run-older', agentType: 'runner', finishedAt: '2026-01-01T00:00:00.000Z' },
    { slug: 'newer', runId: 'run-newer', agentType: 'runner', finishedAt: '2026-02-01T00:00:00.000Z' },
  ]);
  writeRunLog('run-older', 'older', '[scheduler] agentType=runner persona=/p/runner.md model=claude-old-1\n');
  writeRunLog('run-newer', 'newer', '[scheduler] agentType=runner persona=/p/runner.md model=claude-sonnet-5\n');

  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'runner' });
  expect(info.resolvedModelId).toBe('claude-sonnet-5');
  expect(info.resolvedFrom).toBe('scheduler-run');
});

test('scheduler-run evidence also matches jobs already archived into history.jsonl', async () => {
  writeGlobalPersona('archived-runner', ['model: opus']);
  writeHistoryEntries([
    { slug: 'old-hist', runId: 'run-hist', agentType: 'archived-runner', finishedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  writeRunLog('run-hist', 'old-hist', '[scheduler] agentType=archived-runner persona=/p/x.md model=claude-opus-5\n');

  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'archived-runner' });
  expect(info.resolvedModelId).toBe('claude-opus-5');
  expect(info.resolvedFrom).toBe('scheduler-run');
});

test('evidence hit via transcript when no scheduler run exists: takes the LAST "model" occurrence', async () => {
  writeGlobalPersona('chatty', ['model: opus']);
  writeActiveIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-1', agentType: 'chatty', createdAt: '2026-03-01T00:00:00.000Z' },
  });
  writeTranscript('sess-1', [
    { type: 'assistant', message: { model: 'claude-opus-4' } },
    { type: 'assistant', message: { model: 'claude-opus-5' } },
  ]);

  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'chatty' });
  expect(info.resolvedModelId).toBe('claude-opus-5');
  expect(info.resolvedFrom).toBe('transcript');
});

test('transcript evidence prefers the most recently created matching Epic', async () => {
  writeGlobalPersona('multi-epic', ['model: haiku']);
  writeActiveIndex({
    'epic-old': { id: 'epic-old', claudeSessionId: 'sess-old', agentType: 'multi-epic', createdAt: '2026-01-01T00:00:00.000Z' },
    'epic-new': { id: 'epic-new', claudeSessionId: 'sess-new', agentType: 'multi-epic', createdAt: '2026-05-01T00:00:00.000Z' },
  });
  writeTranscript('sess-old', [{ model: 'claude-haiku-old' }]);
  writeTranscript('sess-new', [{ model: 'claude-haiku-new' }]);

  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'multi-epic' });
  expect(info.resolvedModelId).toBe('claude-haiku-new');
  expect(info.resolvedFrom).toBe('transcript');
});

test('evidence miss (no scheduler run, no transcript) reports resolvedModelId/resolvedFrom as null — never a guessed pricing-key fallback', async () => {
  writeGlobalPersona('unseen', ['model: haiku']);
  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'unseen' });
  expect(info.resolvedModelId).toBeNull();
  expect(info.resolvedFrom).toBeNull();
});

// ---------- edge cases ----------

test('never throws for a missing cwd/agentType', async () => {
  await expect(resolveEffectiveModelInfo({})).resolves.toMatchObject({
    modelAlias: null,
    modelSource: 'fallback',
    resolvedModelId: null,
    resolvedFrom: null,
  });
});

test('isConcreteModelId treats known CLI aliases as non-concrete and everything else as concrete', () => {
  expect(isConcreteModelId('opus')).toBe(false);
  expect(isConcreteModelId('sonnet')).toBe(false);
  expect(isConcreteModelId('haiku')).toBe(false);
  expect(isConcreteModelId('opus[1m]')).toBe(false);
  expect(isConcreteModelId('best')).toBe(false);
  expect(isConcreteModelId('opusplan')).toBe(false);
  expect(isConcreteModelId('default')).toBe(false);
  expect(isConcreteModelId('claude-opus-4-7[1m]')).toBe(true);
  expect(isConcreteModelId('fable')).toBe(false);
  expect(isConcreteModelId(null)).toBe(false);
  expect(isConcreteModelId('claude-opus-5')).toBe(true);
});

test('effortReachable is always false for an app-launched session — cleanChildEnv strips CLAUDE_EFFORT and CLAUDE_CODE_* before a child ever sees them', () => {
  expect(computeEffortReachable({})).toBe(false);
});

test('resolveEffectiveModelInfo surfaces effortReachable alongside the model fields', async () => {
  writeGlobalPersona('any', ['model: sonnet']);
  const info = await resolveEffectiveModelInfo({ cwd, agentType: 'any' });
  expect(info.effortReachable).toBe(false);
});
