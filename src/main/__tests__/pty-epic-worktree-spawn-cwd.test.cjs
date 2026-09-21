/**
 * pty-epic-worktree-spawn-cwd.test.cjs — PRD 1033, LOAD-BEARING acceptance
 * criterion: an Epic-attached Terminal tab's PTY must actually launch its
 * shell in the Epic's isolated worktree dir when one is recorded, while
 * `cwd` itself (home-boundary validation, opsErrorLog attribution, the
 * returned/tracked cwd) stays the real project cwd — see epicSpawnCwd.cjs's
 * "ops-root hazard" header comment.
 *
 * Monkey-patches node-pty's own `spawn` export (a plain mutable property on
 * its shared, cached module object) to capture the real spawn options
 * without launching an actual shell — no existing test in this repo mocks a
 * module import, so this stays a direct property override rather than
 * introducing a new vi.mock pattern.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/pty-epic-worktree-spawn-cwd.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let manager;
let nodePty;
let originalSpawn;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-execcwd-home-'));
  process.env.HOME = tmpHome;
  ({ manager } = require('../pty.cjs'));
  nodePty = require('node-pty');
  originalSpawn = nodePty.spawn;
});

afterAll(() => {
  nodePty.spawn = originalSpawn;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  nodePty.spawn = originalSpawn;
  manager.sessions.clear();
  manager.buffers.clear();
  manager.killed.clear();
});

function fakeProc() {
  return {
    pid: 4242,
    exitCode: null,
    onData: () => {},
    onExit: () => {},
    resize: () => {},
    kill: () => {},
    write: () => {},
  };
}

function writeActiveIndexWithWorktree(cwd, { epicId, claudeSessionId, worktreeDir }) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    id: epicId,
    cwd,
    goalText: 'test epic',
    claudeSessionId,
    status: 'active',
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    worktree: { dir: worktreeDir, branch: `sm-epic/${epicId}`, baseCwd: cwd, status: 'active' },
  };
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions: { [epicId]: session }, events: {} }));
}

test('spawn() launches the shell at the Epic worktree dir when one is recorded, while cwd itself stays the project cwd', () => {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-main-'));
  const worktreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-worktree-'));
  const sessionId = 'epic-session-1';
  writeActiveIndexWithWorktree(mainCwd, { epicId: 'epic-1', claudeSessionId: sessionId, worktreeDir: worktreeCwd });

  let capturedOpts = null;
  nodePty.spawn = (shell, args, opts) => {
    capturedOpts = opts;
    return fakeProc();
  };

  const result = manager.spawn({ tabId: sessionId, cwd: mainCwd, cols: 80, rows: 24 });

  expect(capturedOpts).not.toBeNull();
  // The ACTUAL spawn cwd is the worktree dir.
  expect(capturedOpts.cwd).toBe(worktreeCwd);
  // CRITICAL invariant: cwd used for the home-boundary check, tracked
  // session bookkeeping, and the value handed back to the renderer is the
  // real project cwd, never the worktree dir.
  expect(result.cwd).toBe(mainCwd);
  expect(manager.sessions.get(sessionId).cwd).toBe(mainCwd);

  manager.kill(sessionId);
});

test('spawn() falls back to cwd unchanged when the tab has no matching Epic worktree', () => {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-plain-'));
  const tabId = 'plain-tab-1';

  let capturedOpts = null;
  nodePty.spawn = (shell, args, opts) => {
    capturedOpts = opts;
    return fakeProc();
  };

  manager.spawn({ tabId, cwd: mainCwd, cols: 80, rows: 24 });

  expect(capturedOpts.cwd).toBe(mainCwd);
  manager.kill(tabId);
});

test("spawn() falls back to cwd unchanged when the Epic's worktree field is absent from the index", () => {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-noworktree-'));
  const sessionId = 'epic-session-2';
  const dir = path.join(mainCwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'active-index.json'),
    JSON.stringify({
      sessions: {
        'epic-2': {
          id: 'epic-2',
          cwd: mainCwd,
          goalText: 'x',
          claudeSessionId: sessionId,
          status: 'active',
          createdAt: new Date(0).toISOString(),
          completedAt: null,
        },
      },
      events: {},
    }),
  );

  let capturedOpts = null;
  nodePty.spawn = (shell, args, opts) => {
    capturedOpts = opts;
    return fakeProc();
  };

  manager.spawn({ tabId: sessionId, cwd: mainCwd, cols: 80, rows: 24 });

  expect(capturedOpts.cwd).toBe(mainCwd);
  manager.kill(sessionId);
});

test('spawn() opens a merged-worktree Epic in the project cwd (dead worktree dir is never used)', () => {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-merged-'));
  const sessionId = 'epic-session-merged';
  const deadDir = path.join(os.tmpdir(), 'sm-pty-dead-worktree-does-not-exist');
  writeActiveIndexWithWorktree(mainCwd, { epicId: 'epic-m', claudeSessionId: sessionId, worktreeDir: deadDir });
  const idxPath = path.join(mainCwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx.sessions['epic-m'].worktree.status = 'merged';
  fs.writeFileSync(idxPath, JSON.stringify(idx));

  let capturedOpts = null;
  nodePty.spawn = (shell, args, opts) => {
    capturedOpts = opts;
    return fakeProc();
  };
  manager.spawn({ tabId: sessionId, cwd: mainCwd, cols: 80, rows: 24 });
  expect(capturedOpts.cwd).toBe(mainCwd);
  manager.kill(sessionId);
});

function setEpic(mainCwd, epicId, patch) {
  const idxPath = path.join(mainCwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const rec = idx.sessions[epicId];
  if (patch.status) rec.status = patch.status;
  if (patch.worktreeStatus) rec.worktree.status = patch.worktreeStatus;
  fs.writeFileSync(idxPath, JSON.stringify(idx));
}

function captureSpawn() {
  const out = { opts: null, count: 0 };
  nodePty.spawn = (shell, args, opts) => {
    out.opts = opts;
    out.count += 1;
    return fakeProc();
  };
  return out;
}

function fakeWindow(sent) {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isCrashed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

test('spawn() opens a completed Epic (merged worktree) as a shell in the project cwd with an informational line', () => {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-closed-'));
  const sessionId = 'epic-session-closed';
  const deadDir = path.join(os.tmpdir(), 'sm-pty-closed-dead-worktree');
  writeActiveIndexWithWorktree(mainCwd, { epicId: 'epic-c', claudeSessionId: sessionId, worktreeDir: deadDir });
  setEpic(mainCwd, 'epic-c', { status: 'completed', worktreeStatus: 'merged' });

  const cap = captureSpawn();
  const sent = [];
  manager.window = fakeWindow(sent);
  try {
    const result = manager.spawn({ tabId: sessionId, cwd: mainCwd, cols: 80, rows: 24 });
    expect(cap.count).toBe(1);
    expect(cap.opts.cwd).toBe(mainCwd);
    expect(result.pid).toBe(4242);
    expect(result.error).toBeUndefined();
    const info = sent.find((m) => m.channel === `pty:data:${sessionId}`);
    expect(info.payload).toMatch(/Epic is completed/);
    expect(info.payload).toContain(mainCwd);
  } finally {
    manager.window = null;
    manager.kill(sessionId);
  }
});

test('spawn() opens a completed Epic whose worktree dir still exists in that worktree dir', () => {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-closed-live-'));
  const worktreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-closed-live-wt-'));
  const sessionId = 'epic-session-closed-live';
  writeActiveIndexWithWorktree(mainCwd, { epicId: 'epic-cl', claudeSessionId: sessionId, worktreeDir: worktreeCwd });
  setEpic(mainCwd, 'epic-cl', { status: 'completed' });

  const cap = captureSpawn();
  manager.spawn({ tabId: sessionId, cwd: mainCwd, cols: 80, rows: 24 });
  expect(cap.count).toBe(1);
  expect(cap.opts.cwd).toBe(worktreeCwd);
  manager.kill(sessionId);
  fs.rmSync(worktreeCwd, { recursive: true, force: true });
});

test('spawn() still refuses session_unreachable without any node-pty spawn', () => {
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-unreachable-'));
  const sessionId = 'epic-session-unreachable';
  const deadDir = path.join(os.tmpdir(), 'sm-pty-unreachable-dead-worktree');
  writeActiveIndexWithWorktree(mainCwd, { epicId: 'epic-u', claudeSessionId: sessionId, worktreeDir: deadDir });
  setEpic(mainCwd, 'epic-u', { worktreeStatus: 'merged' });
  // Transcript exists only under the dead worktree's encoded project dir.
  const enc = deadDir.replace(/[^a-zA-Z0-9]/g, '-');
  const tdir = path.join(tmpHome, '.claude', 'projects', enc);
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${sessionId}.jsonl`), '{"type":"user"}\n');

  const cap = captureSpawn();
  const result = manager.spawn({ tabId: sessionId, cwd: mainCwd, cols: 80, rows: 24 });
  expect(cap.count).toBe(0);
  expect(result.pid).toBeNull();
  expect(result.error).toMatch(/cannot be resumed/);
});

test('planEpicSpawn resumes from the project root when the caller cwd is the vanished worktree path (transcript under project-root encoding)', () => {
  const { planEpicSpawn, __resetForTests } = require('../lib/epicSpawnPlan.cjs');
  __resetForTests();
  const projectRoot = fs.mkdtempSync(path.join(tmpHome, 'sm-plan-root-'));
  const deadWt = path.join(os.tmpdir(), 'sm-plan-dead-worktree-xyz');
  const sessionId = 'epic-session-root-probe';
  const tdir = path.join(tmpHome, '.claude', 'projects', projectRoot.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${sessionId}.jsonl`), '{"type":"user"}\n');
  const epic = {
    id: 'epic-rp', cwd: projectRoot, claudeSessionId: sessionId, status: 'active',
    worktree: { dir: deadWt, branch: 'sm-epic/epic-rp', baseCwd: projectRoot, status: 'active' },
  };
  const deps = { homeDir: tmpHome, readActiveIndex: () => ({ sessions: { 'epic-rp': epic } }), restoreWorktree: () => null };
  const plan = planEpicSpawn({ cwd: deadWt, claudeSessionId: sessionId, deps });
  expect(plan).toMatchObject({ ok: true, execCwd: projectRoot, useResume: true });
  // A successful plan leaves no stale circuit-breaker entry: a second call still succeeds.
  expect(planEpicSpawn({ cwd: deadWt, claudeSessionId: sessionId, deps }).ok).toBe(true);
});
