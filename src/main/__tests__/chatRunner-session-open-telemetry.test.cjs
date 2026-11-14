/**
 * chatRunner-session-open-telemetry.test.cjs — proves Chat fires the
 * `session.open` counter (surface 'chat') exactly once when a turn spawns the
 * CLI with --session-id (a brand-new session), and never on a --resume turn.
 * Same stub-claude harness as chatRunner-session-flag-retry.test.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/chatRunner-session-open-telemetry.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let cr;
let telemetryCounters;
let sent;
let curTab;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-sessionopen-home-'));
  process.env.HOME = tmpHome;
  cr = require('../chatRunner.cjs');
  telemetryCounters = require('../lib/telemetry/telemetryCounters.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  cr.__resetQueueForTests();
  cr.attachWindow(null);
  vi.restoreAllMocks();
});

function attachRecorder() {
  sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
}

function writeStub(logFile) {
  const stubPath = path.join(os.tmpdir(), `sm-sessionopen-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  fs.writeFileSync(stubPath, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');\n`, { mode: 0o755 });
  return stubPath;
}

async function waitFor(pred, timeoutMs = 8000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const TERMINAL = ['chat:run:complete', 'chat:run:needs-input', 'chat:run:error'];
const terminals = () => sent.filter((e) => TERMINAL.includes(e.channel) && e.payload.tabId === curTab);
const spawns = (logFile) => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Main decides --resume from the transcript on disk (epicSpawnPlan.cjs), so a
// resume turn needs a transcript where the CLI would look for it.
function writeTranscript(cwd, sessionId) {
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(tmpHome, '.claude', 'projects', encoded);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', sessionId }) + '\n');
}

test('a new-session turn (--session-id) fires trackSessionOpen({surface:"chat"}) exactly once', async () => {
  const spy = vi.spyOn(telemetryCounters, 'trackSessionOpen').mockImplementation(() => {});
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sessionopen-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `open-new-${process.pid}`;
  process.env.SM_CLAUDE_BIN = writeStub(logFile);
  try {
    curTab = 'tab-new';
    cr.run({ tabId: 'tab-new', sessionId, prompt: 'hello', cwd, resume: false });
    await waitFor(() => terminals().length > 0);
    expect(spawns(logFile)[0]).toContain('--session-id');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ surface: 'chat' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a --resume turn never fires trackSessionOpen', async () => {
  const spy = vi.spyOn(telemetryCounters, 'trackSessionOpen').mockImplementation(() => {});
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sessionopen-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `open-resume-${process.pid}`;
  writeTranscript(cwd, sessionId);
  process.env.SM_CLAUDE_BIN = writeStub(logFile);
  try {
    curTab = 'tab-resume';
    cr.run({ tabId: 'tab-resume', sessionId, prompt: 'again', cwd, resume: true });
    await waitFor(() => terminals().length > 0);
    expect(spawns(logFile)[0]).toContain('--resume');
    expect(spawns(logFile)[0]).not.toContain('--session-id');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
