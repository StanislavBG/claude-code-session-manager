/**
 * epicWorktreeMint.test.cjs — unit tests for the
 * 'promptSessions:create-worktree' IPC handler (lib/epic/epicWorktreeMint.cjs),
 * PRD 1033: the main-process entry point the renderer's approveProposed
 * fires (fire-and-forget) at the Epic proposed->active transition to create
 * its isolated git worktree.
 *
 * Exercises the handler the same way index.cjs wires it — schema validation
 * (ipcSchemas.cjs's `validated` wrapper) in front of the business logic,
 * mirroring promptSessionsCreateEpicHandler.test.cjs's pattern.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicWorktreeMint.test.cjs
 */

'use strict';

import { test, expect, afterEach, describe, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { schemas, validated } = require('../../../ipcSchemas.cjs');
const { createEpicWorktreeViaIpc } = require('../epicWorktreeMint.cjs');
const gitWorktree = require('../../git/gitWorktree.cjs');
const config = require('../../../config.cjs');

const handler = validated(schemas.promptSessionsCreateWorktree, ({ cwd, epicId }) => createEpicWorktreeViaIpc(cwd, epicId));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

const tmpDirs = [];
afterEach(async () => {
  gitWorktree._resetActiveWorktreeCountForTests('epic', 0);
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { await gitWorktree.reconcileWorktreesOnBoot([d], { kind: 'epic' }); } catch { /* ignore */ }
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkRepoCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemint-'));
  initRepo(cwd);
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  return cwd;
}

test('a valid request creates the Epic worktree and returns the field shape ready to persist', async () => {
  const cwd = await mkRepoCwd();
  const result = await handler(null, { cwd, epicId: 'epic-mint-1' });

  expect(result).not.toBeNull();
  expect(result.branch).toBe('sm-epic/epic-mint-1');
  expect(result.baseCwd).toBe(cwd);
  expect(result.status).toBe('active');
  expect(fs.existsSync(result.dir)).toBe(true);
  expect(fs.existsSync(path.join(result.dir, 'README.md'))).toBe(true);
});

test('a non-git cwd resolves to null rather than throwing (Epic proceeds unisolated)', async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemint-nongit-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);

  const result = await handler(null, { cwd, epicId: 'epic-mint-2' });
  expect(result).toBeNull();
});

test('a dirty base tree still creates the worktree, carrying the uncommitted edit in rather than falling back unisolated', async () => {
  const cwd = await mkRepoCwd();
  fs.writeFileSync(path.join(cwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');

  const result = await handler(null, { cwd, epicId: 'epic-mint-3' });
  expect(result).not.toBeNull();
  expect(fs.readFileSync(path.join(result.dir, 'README.md'), 'utf8')).toBe('uncommitted tracked edit\n');
  expect(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8')).toBe('uncommitted tracked edit\n');
});

test('SM_EPIC_WORKTREE_DISABLE=1 resolves to null rather than throwing', async () => {
  const cwd = await mkRepoCwd();
  const original = process.env.SM_EPIC_WORKTREE_DISABLE;
  process.env.SM_EPIC_WORKTREE_DISABLE = '1';
  try {
    const result = await handler(null, { cwd, epicId: 'epic-mint-4' });
    expect(result).toBeNull();
  } finally {
    if (original === undefined) delete process.env.SM_EPIC_WORKTREE_DISABLE;
    else process.env.SM_EPIC_WORKTREE_DISABLE = original;
  }
});

test('a cwd outside every allowed root is rejected before anything is created', async () => {
  const unregistered = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemint-unregistered-'));
  initRepo(unregistered);
  tmpDirs.push(unregistered);

  await expect(handler(null, { cwd: unregistered, epicId: 'epic-mint-5' })).rejects.toThrow(/outside allowed boundaries/);
});

test('a request missing epicId is rejected by ipcSchemas validation', async () => {
  const cwd = await mkRepoCwd();
  expect(() => handler(null, { cwd })).toThrow();
});

describe('pending mint registry', () => {
  const { awaitPendingEpicWorktree, hasPendingEpicWorktree, __resetPendingForTests } = require('../epicWorktreeMint.cjs');
  afterEach(() => { vi.restoreAllMocks(); __resetPendingForTests(); });

  test('registers synchronously, resolves the mint result, and clears once settled', async () => {
    const cwd = await mkRepoCwd();
    const p = createEpicWorktreeViaIpc(cwd, 'epic-pend-1');
    const awaited = awaitPendingEpicWorktree(cwd, 'epic-pend-1');
    const [result, viaAwait] = await Promise.all([p, awaited]);
    expect(result).not.toBeNull();
    expect(viaAwait).toEqual(result);
    expect(await awaitPendingEpicWorktree(cwd, 'epic-pend-1')).toBeNull();
  });

  test('hasPendingEpicWorktree is true only while a mint is in flight', async () => {
    const cwd = await mkRepoCwd();
    expect(hasPendingEpicWorktree(cwd, 'epic-has-1')).toBe(false);
    const p = createEpicWorktreeViaIpc(cwd, 'epic-has-1');
    expect(hasPendingEpicWorktree(cwd, 'epic-has-1')).toBe(true);
    expect(hasPendingEpicWorktree(cwd, 'epic-other')).toBe(false);
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(hasPendingEpicWorktree(cwd, 'epic-has-1')).toBe(false);
    expect(hasPendingEpicWorktree(undefined, undefined)).toBe(false);
  });

  test('nothing pending resolves null at once', async () => {
    expect(await awaitPendingEpicWorktree('/nowhere', 'epic-none')).toBeNull();
  });

  test('a mint slower than timeoutMs resolves null and logs once', async () => {
    const cwd = await mkRepoCwd();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(gitWorktree, 'createEpicWorktree');
    const p = createEpicWorktreeViaIpc(cwd, 'epic-pend-2');
    expect(await awaitPendingEpicWorktree(cwd, 'epic-pend-2', { timeoutMs: 0 })).toBeNull();
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('pending mint timed out')).length).toBe(1);
    await p;
  });
});

describe('restored-session Epics stay in the project checkout', () => {
  const { hasPendingEpicWorktree, __resetPendingForTests } = require('../epicWorktreeMint.cjs');
  const { activeIndexPath } = require('../epicMint.cjs');
  const { epicMirrorPath } = require('../epicStatusMirror.cjs');
  afterEach(() => { vi.restoreAllMocks(); __resetPendingForTests(); });

  function seedIndex(cwd, { sessions = {}, tombstones = {} } = {}) {
    fs.mkdirSync(path.dirname(activeIndexPath(cwd)), { recursive: true });
    fs.writeFileSync(activeIndexPath(cwd), JSON.stringify({ sessions, events: {}, tombstones }));
  }

  test('createEpicWorktree is not called for a restored Epic and is called for a normal one', async () => {
    const cwd = await mkRepoCwd();
    seedIndex(cwd, {
      sessions: {
        'epic-restored-1': { id: 'epic-restored-1', cwd, status: 'proposed', restoredSession: true },
        'epic-normal-1': { id: 'epic-normal-1', cwd, status: 'proposed' },
      },
    });
    const create = vi.spyOn(gitWorktree, 'createEpicWorktree');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const pending = handler(null, { cwd, epicId: 'epic-restored-1' });
    expect(hasPendingEpicWorktree(cwd, 'epic-restored-1')).toBe(true);
    expect(await pending).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[epicWorktreeMint] epic-restored-1: not isolated (restored-session)');
    expect(git(['branch', '--list', 'sm-epic/epic-restored-1'], cwd).trim()).toBe('');
    await new Promise((r) => setTimeout(r, 0));
    expect(hasPendingEpicWorktree(cwd, 'epic-restored-1')).toBe(false);

    const normal = await handler(null, { cwd, epicId: 'epic-normal-1' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ cwd, epicId: 'epic-normal-1' });
    expect(normal).not.toBeNull();
    expect(normal.branch).toBe('sm-epic/epic-normal-1');
    expect(fs.existsSync(normal.dir)).toBe(true);
  });

  test('reopening a completed restored Epic leaves worktree unset: archived out of the index, its own record carries the flag', async () => {
    const { reopenEpic } = require('../epicReopen.cjs');
    const { encodeCwd } = require('../../util/encodeCwd.cjs');
    const { __resetCacheForTests } = require('../epicTranscriptPath.cjs');
    __resetCacheForTests();
    const cwd = await mkRepoCwd();
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemint-home-'));
    tmpDirs.push(homeDir);
    const epicId = 'epic-restored-reopen';
    const sid = 'sid-restored-reopen';
    const transcript = path.join(homeDir, '.claude', 'projects', encodeCwd(cwd), `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"a":1}\n');
    // Completion tombstones the Epic out of active-index.json; the full record
    // lives only in its prompt-sessions/<id>.json archive when reopen mints.
    seedIndex(cwd, { tombstones: { [epicId]: 'iso' } });
    const session = { id: epicId, cwd, claudeSessionId: sid, status: 'completed', completedAt: 'x', restoredSession: true };
    fs.writeFileSync(epicMirrorPath(cwd, epicId), JSON.stringify({ session, events: [], status: 'completed', archivedAt: 'z', transcriptRef: 'r' }));
    const create = vi.spyOn(gitWorktree, 'createEpicWorktree');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // No deps.createWorktree: provisionWorktree goes through the real createEpicWorktreeViaIpc.
    const r = await reopenEpic({ cwd, epicId, deps: { homeDir } });
    expect(r.session && r.session.worktree).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(r.session.restoredSession).toBe(true);
    expect(JSON.parse(fs.readFileSync(activeIndexPath(cwd), 'utf8')).sessions[epicId]).not.toHaveProperty('worktree');
    expect(git(['branch', '--list', `sm-epic/${epicId}`], cwd).trim()).toBe('');
  });
});
