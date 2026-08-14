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
