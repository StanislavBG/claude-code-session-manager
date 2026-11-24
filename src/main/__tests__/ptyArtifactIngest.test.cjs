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

test('an interval sweep that publishes posts one artifact-ready notice; an empty sweep posts none', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const artifactNotice = require('../lib/epic/artifactNotice.cjs');
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-epic-notice-'));
  const tabId = 'epic-terminal-session-4';
  writeEpic(cwd, { epicId: 'epic-t4', claudeSessionId: tabId });
  const published = [{ storedPath: path.join(cwd, 'a.png'), entry: { title: 'a.png', kind: 'image', size: 3 } }];
  const ingest = vi.spyOn(artifactStore, 'ingestDir')
    .mockResolvedValueOnce({ published, skipped: [] })
    .mockResolvedValue({ published: [], skipped: [] });
  const notice = vi.spyOn(artifactNotice, 'postArtifactReadyNotice').mockResolvedValue({ ok: true });
  const holder = {};
  nodePty.spawn = () => fakeProc(holder);

  manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  await vi.advanceTimersByTimeAsync(15_000);
  await flush();
  expect(ingest).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenLastCalledWith({ cwd, epicId: 'epic-t4', entries: published });

  // Empty sweep: no notice.
  await vi.advanceTimersByTimeAsync(15_000);
  await flush();
  expect(ingest).toHaveBeenCalledTimes(2);
  expect(notice).toHaveBeenCalledTimes(1);

  // Empty exit sweep: no notice.
  holder.exit({ exitCode: 0, signal: undefined });
  await flush();
  expect(ingest).toHaveBeenCalledTimes(3);
  expect(notice).toHaveBeenCalledTimes(1);
});

test('the exit sweep posts one notice when it publishes; a notice failure is logged, never thrown', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const artifactNotice = require('../lib/epic/artifactNotice.cjs');
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-epic-notice-exit-'));
  const tabId = 'epic-terminal-session-5';
  writeEpic(cwd, { epicId: 'epic-t5', claudeSessionId: tabId });
  const published = [
    { storedPath: path.join(cwd, 'b.txt'), entry: { title: 'b.txt', kind: 'text', size: 1 } },
    { storedPath: path.join(cwd, 'c.txt'), entry: { title: 'c.txt', kind: 'text', size: 2 } },
  ];
  vi.spyOn(artifactStore, 'ingestDir').mockResolvedValue({ published, skipped: [] });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const notice = vi.spyOn(artifactNotice, 'postArtifactReadyNotice').mockRejectedValue(new Error('notice boom'));
  const holder = {};
  nodePty.spawn = () => fakeProc(holder);

  manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  expect(() => holder.exit({ exitCode: 0, signal: undefined })).not.toThrow();
  await flush();
  await flush();
  expect(notice).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenLastCalledWith({ cwd, epicId: 'epic-t5', entries: published });
  expect(err.mock.calls.some((c) => String(c[0]).includes('[pty] artifact-ready notice failed'))).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

// Real git: the stored file is ignored and nothing under artifacts/ is visible.
function assertGitInvisible(root, storedPath) {
  const { execFileSync } = require('node:child_process');
  expect(fs.existsSync(storedPath)).toBe(true);
  expect(() => execFileSync('git', ['check-ignore', '-q', storedPath], { cwd: root })).not.toThrow();
  expect(execFileSync('git', ['status', '--porcelain', '-uall', '--', 'session-manager-operations/artifacts'], { cwd: root, encoding: 'utf8' })).toBe('');
}
function gitProject(parent, name) {
  const { execFileSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, name)));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('real store + real git: an Epic-terminal exit ingest leaves nothing visible to git', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const artifactNotice = require('../lib/epic/artifactNotice.cjs');
  vi.spyOn(artifactNotice, 'postArtifactReadyNotice').mockResolvedValue({ ok: true });
  const cwd = gitProject(fs.realpathSync(tmpHome), 'sm-pty-epic-git-');
  const tabId = 'epic-terminal-session-git';
  writeEpic(cwd, { epicId: 'epic-tgit', claudeSessionId: tabId });
  const ingest = vi.spyOn(artifactStore, 'ingestDir'); // real implementation, observed only
  const holder = {};
  nodePty.spawn = () => fakeProc(holder);

  manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  const staging = artifactStore.stagingDirFor({ runId: tabId });
  fs.writeFileSync(path.join(staging, 'clip.mp4'), 'video-bytes');
  holder.exit({ exitCode: 0, signal: undefined });
  await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
  const res = await ingest.mock.results[0].value;

  expect(res.skipped).toEqual([]);
  expect(res.published).toHaveLength(1);
  const stored = res.published[0].storedPath;
  expect(stored).toBe(path.join(cwd, 'session-manager-operations', 'artifacts', 'epic-tgit', 'clip.mp4'));
  assertGitInvisible(cwd, stored);
});
