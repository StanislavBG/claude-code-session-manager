/**
 * ptyArtifactIngest.test.cjs — an Epic's Terminal sweeps its SM_ARTIFACTS_DIR
 * every 15 s (files untouched for 10 s only), once more on exit (no age
 * floor), and stops the sweep on exit. Non-Epic terminals never sweep.
 *
 * Same monkey-patch-node-pty pattern as pty-epic-worktree-spawn-cwd.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/ptyArtifactIngest.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let wtRoot;
let originalHome;
let prevWt;
let manager;
let nodePty;
let originalSpawn;
let artifactStore;

beforeAll(() => {
  originalHome = process.env.HOME;
  prevWt = process.env.SM_WORKTREE_ROOT;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-artifacts-home-'));
  wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-artifacts-wt-'));
  process.env.HOME = tmpHome;
  process.env.SM_WORKTREE_ROOT = wtRoot;
  ({ manager } = require('../pty.cjs'));
  nodePty = require('node-pty');
  originalSpawn = nodePty.spawn;
  artifactStore = require('../lib/epic/artifactStore.cjs');
});

afterAll(() => {
  nodePty.spawn = originalSpawn;
  process.env.HOME = originalHome;
  if (prevWt === undefined) delete process.env.SM_WORKTREE_ROOT; else process.env.SM_WORKTREE_ROOT = prevWt;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(wtRoot, { recursive: true, force: true });
});

afterEach(() => {
  nodePty.spawn = originalSpawn;
  manager.sessions.clear();
  manager.buffers.clear();
  manager.killed.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeProc(holder) {
  return {
    pid: 4242,
    exitCode: null,
    onData: () => {},
    onExit: (cb) => { holder.exit = cb; },
    resize: () => {},
    kill: () => {},
    write: () => {},
  };
}

function writeEpic(cwd, { epicId, claudeSessionId }) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    id: epicId, cwd, goalText: 'x', claudeSessionId, status: 'active',
    createdAt: new Date(0).toISOString(), completedAt: null,
  };
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions: { [epicId]: session }, events: {} }));
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

test('an Epic terminal ingests every 15 s with minAgeMs 10000, once on exit with minAgeMs 0, then stops', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-epic-'));
  const tabId = 'epic-terminal-session-1';
  writeEpic(cwd, { epicId: 'epic-t1', claudeSessionId: tabId });
  const ingest = vi.spyOn(artifactStore, 'ingestDir').mockResolvedValue({ published: [], skipped: [] });
  const holder = {};
  nodePty.spawn = () => fakeProc(holder);

  manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  const staging = path.join(wtRoot, 'artifact-staging', tabId);
  expect(fs.existsSync(staging)).toBe(true);
  expect(ingest).not.toHaveBeenCalled();

  // The folder is re-created when missing before each sweep.
  fs.rmSync(staging, { recursive: true, force: true });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fs.existsSync(staging)).toBe(true);
  expect(ingest).toHaveBeenCalledTimes(1);
  expect(ingest).toHaveBeenLastCalledWith(expect.objectContaining({
    projectRoot: cwd, epicId: 'epic-t1', srcDir: staging, minAgeMs: 10_000,
    producer: { epicId: 'epic-t1', sessionId: tabId },
  }));

  await vi.advanceTimersByTimeAsync(15_000);
  expect(ingest).toHaveBeenCalledTimes(2);

  holder.exit({ exitCode: 0, signal: undefined });
  await flush();
  expect(ingest).toHaveBeenCalledTimes(3);
  expect(ingest).toHaveBeenLastCalledWith(expect.objectContaining({ srcDir: staging, minAgeMs: 0 }));

  // Interval cleared: no more sweeps after exit.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ingest).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

test('a killed Epic terminal still runs the exit ingest and clears its interval', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-epic-kill-'));
  const tabId = 'epic-terminal-session-2';
  writeEpic(cwd, { epicId: 'epic-t2', claudeSessionId: tabId });
  const ingest = vi.spyOn(artifactStore, 'ingestDir').mockResolvedValue({ published: [], skipped: [] });
  const holder = {};
  nodePty.spawn = () => fakeProc(holder);

  manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  manager.kill(tabId);
  holder.exit({ exitCode: 0, signal: 'SIGHUP' });
  await flush();
  expect(ingest).toHaveBeenCalledTimes(1);
  expect(ingest).toHaveBeenLastCalledWith(expect.objectContaining({ minAgeMs: 0 }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ingest).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('ingest errors are logged, never thrown', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-epic-err-'));
  const tabId = 'epic-terminal-session-3';
  writeEpic(cwd, { epicId: 'epic-t3', claudeSessionId: tabId });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(artifactStore, 'ingestDir').mockImplementation(() => { throw new Error('boom'); });
  const holder = {};
  nodePty.spawn = () => fakeProc(holder);

  manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(() => holder.exit({ exitCode: 0, signal: undefined })).not.toThrow();
  await flush();
  expect(err.mock.calls.some((c) => String(c[0]).includes('[pty] artifact ingest failed'))).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a non-Epic terminal never starts a sweep', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-plain-'));
  const ingest = vi.spyOn(artifactStore, 'ingestDir').mockResolvedValue({ published: [], skipped: [] });
  const holder = {};
  nodePty.spawn = () => fakeProc(holder);

  manager.spawn({ tabId: 'plain-tab-1', cwd, cols: 80, rows: 24 });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  holder.exit({ exitCode: 0, signal: undefined });
  await flush();
  expect(ingest).not.toHaveBeenCalled();
});
