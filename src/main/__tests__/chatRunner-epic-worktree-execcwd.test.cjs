/**
 * chatRunner-epic-worktree-execcwd.test.cjs — PRD 1033, LOAD-BEARING
 * acceptance criterion: an Epic-backed headless `claude -p` run must spawn
 * with its `cwd` spawn option pointed at the Epic's isolated worktree dir
 * when one is recorded, while `session-manager-operations/` for that Epic's
 * project — the ops root — is never touched under the worktree dir. Mirrors
 * scheduler-worktree-exec-cwd.test.cjs's stub-`claude`-binary pattern
 * (SM_CLAUDE_BIN), which chatRunner.cjs's resolveClaudeBin also honors.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/chatRunner-epic-worktree-execcwd.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let cr;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-execcwd-home-'));
  process.env.HOME = tmpHome;
  cr = require('../chatRunner.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  cr.__resetQueueForTests();
  cr.attachWindow(null);
});

// Writes a stub `claude` binary that records ITS OWN process.cwd() to a
// marker file (proving where it actually ran), then emits a minimal
// stream-json success result and exits 0 — same pattern as
// scheduler-worktree-exec-cwd.test.cjs's writeClaudeStub.
function writeClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-chatrunner-claude-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'ran-here.marker'), 'yes', 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
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

async function waitForFile(filePath, timeoutMs = 5000) {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('executeRun spawns the claude child in the Epic worktree dir, while the project ops-root is never touched under it', async () => {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-main-'));
  const worktreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-worktree-'));
  const sessionId = `epic-sess-${process.pid}`;
  writeActiveIndexWithWorktree(mainCwd, { epicId: 'epic-1', claudeSessionId: sessionId, worktreeDir: worktreeCwd });
  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  try {
    cr.run({ tabId: 'tab-1', sessionId, prompt: 'hello', cwd: mainCwd, resume: false });
    await waitForFile(path.join(worktreeCwd, 'ran-here.marker'));

    // 1. The child process really ran with cwd = the Epic's worktree dir.
    expect(fs.existsSync(path.join(worktreeCwd, 'ran-here.marker'))).toBe(true);
    expect(fs.existsSync(path.join(mainCwd, 'ran-here.marker'))).toBe(false);

    // 2. CRITICAL invariant: session-manager-operations/ for this Epic's
    // project must never be touched under the worktree dir — only the real
    // project cwd, which still holds exactly the active-index.json this
    // test wrote.
    expect(fs.existsSync(path.join(worktreeCwd, 'session-manager-operations'))).toBe(false);
    const index = JSON.parse(
      fs.readFileSync(path.join(mainCwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'), 'utf8'),
    );
    expect(index.sessions['epic-1'].claudeSessionId).toBe(sessionId);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(worktreeCwd, { recursive: true, force: true });
  }
});

test('executeRun falls back to cwd unchanged when the Epic has no worktree recorded (unchanged behaviour)', async () => {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-plain-'));
  const sessionId = `plain-sess-${process.pid}`;
  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  try {
    cr.run({ tabId: 'tab-2', sessionId, prompt: 'hello', cwd: mainCwd, resume: false });
    await waitForFile(path.join(mainCwd, 'ran-here.marker'));
    expect(fs.existsSync(path.join(mainCwd, 'ran-here.marker'))).toBe(true);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
  }
});
