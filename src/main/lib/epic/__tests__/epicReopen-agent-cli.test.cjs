/**
 * epicReopen-agent-cli.test.cjs — reopening a non-Claude agent-CLI Epic skips the
 * Claude-transcript reachability check and keeps agentCli/agentCliModel.
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicReopen-agent-cli.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const transcriptRestore = require('../epicTranscriptRestore.cjs');
const { activeIndexPath } = require('../epicMint.cjs');
const { epicMirrorPath } = require('../epicStatusMirror.cjs');
const { __resetCacheForTests } = require('../epicTranscriptPath.cjs');

const SID = '11111111-2222-4333-8444-555555555555';
const EPIC = 'epic-1';
const saved = {};
const tmpDirs = [];

beforeEach(async () => {
  __resetCacheForTests();
  for (const k of ['HOME', 'SM_AGENT_CLI_STATE_DIR']) saved[k] = process.env[k];
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ro-home-'));
  const state = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ro-state-'));
  tmpDirs.push(home, state);
  process.env.HOME = home;
  process.env.SM_AGENT_CLI_STATE_DIR = state;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function setup(extra) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ro-cwd-'));
  tmpDirs.push(cwd);
  const session = { id: EPIC, cwd, claudeSessionId: SID, status: 'completed', completedAt: 'x', ...extra };
  fs.mkdirSync(path.dirname(activeIndexPath(cwd)), { recursive: true });
  fs.writeFileSync(activeIndexPath(cwd), JSON.stringify({ sessions: {}, events: {}, tombstones: { [EPIC]: 'iso' } }));
  fs.writeFileSync(epicMirrorPath(cwd, EPIC), JSON.stringify({ session, events: [{ id: 'e1' }], status: 'completed' }));
  return cwd;
}

// Load epicReopen fresh so its destructured import binds to the spy.
function loadReopen() {
  const id = require.resolve('../epicReopen.cjs');
  delete require.cache[id];
  return require('../epicReopen.cjs').reopenEpic;
}

test('non-Claude Epic reopens without ensureEpicTranscriptReachable and keeps agentCli + agentCliModel', async () => {
  const spy = vi.spyOn(transcriptRestore, 'ensureEpicTranscriptReachable');
  const reopenEpic = loadReopen();
  const cwd = await setup({ agentCli: 'codex', agentCliModel: 'gpt-5-codex' });
  const r = await reopenEpic({ cwd, epicId: EPIC, deps: { homeDir: process.env.HOME, createWorktree: async () => null } });
  expect(r.ok).toBe(true);
  expect(spy).not.toHaveBeenCalled();
  expect(r.session).toMatchObject({ status: 'active', agentCli: 'codex', agentCliModel: 'gpt-5-codex', claudeSessionId: SID });
  const idx = JSON.parse(fs.readFileSync(activeIndexPath(cwd), 'utf8'));
  expect(idx.sessions[EPIC]).toMatchObject({ agentCli: 'codex', agentCliModel: 'gpt-5-codex', status: 'active' });
  const mirror = JSON.parse(fs.readFileSync(epicMirrorPath(cwd, EPIC), 'utf8'));
  expect(mirror).toMatchObject({ agentCli: 'codex', agentCliModel: 'gpt-5-codex', status: 'active' });
});

test('Claude Epic with no transcript still fails transcript_missing via ensureEpicTranscriptReachable', async () => {
  const spy = vi.spyOn(transcriptRestore, 'ensureEpicTranscriptReachable');
  const reopenEpic = loadReopen();
  const cwd = await setup({});
  const r = await reopenEpic({ cwd, epicId: EPIC, deps: { homeDir: process.env.HOME, createWorktree: async () => null } });
  expect(r.ok).toBe(false);
  expect(spy).toHaveBeenCalled();
});
