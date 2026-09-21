/**
 * chatRunner-session-flag-retry.test.cjs — main is authoritative about
 * --session-id vs --resume, and a CLI flag rejection is retried exactly once
 * with the other flag without losing the turn.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/chatRunner-session-flag-retry.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let cr;
let sent;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-flagretry-home-'));
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

function attachRecorder() {
  sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
}

// Stub claude: logs its argv (one JSON line per spawn) to logFile. Invocation 1
// fails with `firstStderr` (optionally after emitting assistant text); later
// invocations succeed.
function writeStub(logFile, { firstStderr, textFirst, alwaysFail }) {
  const stubPath = path.join(os.tmpdir(), `sm-flagretry-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const log = ${JSON.stringify(logFile)};
    fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
    const n = fs.readFileSync(log, 'utf8').trim().split('\\n').length;
    if (n === 1 || ${alwaysFail ? 'true' : 'false'}) {
      ${textFirst ? "process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }) + '\\n');" : ''}
      process.stderr.write(${JSON.stringify(firstStderr)});
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
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
let curTab;
const terminals = () => sent.filter((e) => TERMINAL.includes(e.channel) && e.payload.tabId === curTab);
const spawns = (logFile) => fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('in-use error on --session-id retries once with --resume; one terminal event; lane freed', async () => {
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-flagretry-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `flag-sess-${process.pid}`;
  process.env.SM_CLAUDE_BIN = writeStub(logFile, { firstStderr: `Error: Session ID ${sessionId} is already in use.\n` });
  try {
    curTab = 'tab-a';
    cr.run({ tabId: 'tab-a', sessionId, prompt: 'hello', cwd, resume: false });
    await waitFor(() => terminals().length > 0);
    await new Promise((r) => setTimeout(r, 100));

    const argvs = spawns(logFile);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toContain('--session-id');
    expect(argvs[1]).toContain('--resume');
    expect(argvs[1]).not.toContain('--session-id');
    expect(argvs[1][argvs[1].indexOf('--model') + 1]).toBe(argvs[0][argvs[0].indexOf('--model') + 1]);
    expect(argvs[1][1]).toBe(argvs[0][1]);

    expect(terminals()).toHaveLength(1);
    expect(terminals()[0].channel).toBe('chat:run:complete');
    expect(sent.some((e) => e.channel === 'chat:run:notice')).toBe(true);

    // Lane freed: the same tab accepts a new run immediately (not queued).
    const again = cr.run({ tabId: 'tab-a', sessionId, prompt: 'again', cwd, resume: true });
    expect(again.queued).toBe(false);
    await cr.cancel('tab-a');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('no retry when the failed attempt already streamed assistant text', async () => {
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-flagretry-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `flag-sess2-${process.pid}`;
  process.env.SM_CLAUDE_BIN = writeStub(logFile, {
    firstStderr: `Error: Session ID ${sessionId} is already in use.\n`,
    textFirst: true,
  });
  try {
    curTab = 'tab-b';
    cr.run({ tabId: 'tab-b', sessionId, prompt: 'hello', cwd, resume: false });
    await waitFor(() => terminals().length > 0);
    await new Promise((r) => setTimeout(r, 100));

    expect(spawns(logFile)).toHaveLength(1);
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0].channel).toBe('chat:run:error');
    expect(terminals()[0].payload.code).toBe('session_flag_exhausted');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('"No conversation found" on --resume retries once with --session-id (main overrides a wrong renderer flag only via transcript)', async () => {
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-flagretry-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `flag-sess3-${process.pid}`;
  process.env.SM_CLAUDE_BIN = writeStub(logFile, { firstStderr: `No conversation found with session ID: ${sessionId}\n` });
  try {
    // No transcript exists anywhere → main computes resume=false even though
    // the renderer said true, so the first attempt is --session-id and the
    // stub's failure is the wrong-direction message: no retry, error surfaces.
    curTab = 'tab-c';
    cr.run({ tabId: 'tab-c', sessionId, prompt: 'hello', cwd, resume: true });
    await waitFor(() => terminals().length > 0);
    const argvs = spawns(logFile);
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).toContain('--session-id');
    expect(terminals()[0].channel).toBe('chat:run:error');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('spent swap retry (both flags rejected) emits actionable session_flag_exhausted error', async () => {
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-flagretry-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `flag-sess4-${process.pid}`;
  process.env.SM_CLAUDE_BIN = writeStub(logFile, {
    firstStderr: `Error: Session ID ${sessionId} is already in use.\n`,
    alwaysFail: true,
  });
  try {
    curTab = 'tab-d';
    cr.run({ tabId: 'tab-d', sessionId, prompt: 'hello', cwd, resume: false });
    await waitFor(() => terminals().length > 0);
    await new Promise((r) => setTimeout(r, 100));

    expect(spawns(logFile)).toHaveLength(2);
    expect(terminals()).toHaveLength(1);
    const { channel, payload } = terminals()[0];
    expect(channel).toBe('chat:run:error');
    expect(payload.code).toBe('session_flag_exhausted');
    expect(payload.message).toContain(cwd);
    expect(payload.message).toContain(`${sessionId}.jsonl`);
    expect(payload.message).toContain('--resume');
    expect(payload.message).toMatch(/App version: /);
    expect(payload.message).toMatch(/update the app first/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('non-zero exit with unrelated stderr keeps the generic fallback message', async () => {
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-flagretry-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `flag-sess5-${process.pid}`;
  process.env.SM_CLAUDE_BIN = writeStub(logFile, { firstStderr: 'boom: something else broke\n' });
  try {
    curTab = 'tab-e';
    cr.run({ tabId: 'tab-e', sessionId, prompt: 'hello', cwd, resume: false });
    await waitFor(() => terminals().length > 0);
    const { channel, payload } = terminals()[0];
    expect(channel).toBe('chat:run:error');
    expect(payload.code).toBeUndefined();
    expect(payload.message).toMatch(/^process exited without a result event/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- persona effort → --effort (agentEffortResolve.cjs) ----------

async function chatArgvForPersona(effortLine) {
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chat-effort-cwd-'));
  const logFile = path.join(cwd, 'argv.log');
  const sessionId = `effort-sess-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.claude', 'agents', 'effort-persona.md'),
    ['---', 'name: effort-persona', 'model: opus', ...(effortLine ? [effortLine] : []), '---', 'body'].join('\n'),
  );
  const opsDir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(opsDir, { recursive: true });
  fs.writeFileSync(path.join(opsDir, 'active-index.json'), JSON.stringify({
    sessions: { e1: { id: 'e1', claudeSessionId: sessionId, agentType: 'effort-persona' } }, events: {},
  }));
  // First call succeeds outright: firstStderr unused because alwaysFail/n===1 → use a passing stub.
  const stubPath = path.join(os.tmpdir(), `sm-effort-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  fs.writeFileSync(stubPath, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');\n`, { mode: 0o755 });
  process.env.SM_CLAUDE_BIN = stubPath;
  try {
    curTab = 'tab-effort';
    cr.run({ tabId: 'tab-effort', sessionId, prompt: 'hello', cwd, resume: false });
    await waitFor(() => terminals().length >= 1 && fs.existsSync(logFile));
    return spawns(logFile)[0];
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stubPath, { force: true });
  }
}

test('chat spawn: persona effort adds --effort <level> beside --model and --session-id', async () => {
  const argv = await chatArgvForPersona('effort: xhigh');
  expect(argv[argv.indexOf('--effort') + 1]).toBe('xhigh');
  expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
  expect(argv).toContain('--session-id');
});

test('chat spawn: effort inherit / absent adds no --effort token', async () => {
  expect(await chatArgvForPersona('effort: inherit')).not.toContain('--effort');
  expect(await chatArgvForPersona(null)).not.toContain('--effort');
});
