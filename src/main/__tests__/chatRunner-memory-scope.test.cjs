/**
 * chatRunner-memory-scope.test.cjs — chat turn attempts run in a memory-capped
 * systemd scope when supported; stopScope is never called for chat turns (background processes outlive the turn).
 *
 * Run: timeout 200 npx vitest run src/main/__tests__/chatRunner-memory-scope.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let cr;
let ms;
let orig;
let sent;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-memscope-home-'));
  process.env.HOME = tmpHome;
  ms = require('../lib/process/memoryScope.cjs');
  orig = { ...ms };
  cr = require('../chatRunner.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  Object.assign(ms, orig);
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

function writeStub(logFile) {
  const stubPath = path.join(os.tmpdir(), `sm-memscope-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    let d = ''; process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      fs.appendFileSync(${JSON.stringify(logFile)}, 'STDIN:' + d.length + '\\n');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
      process.exit(0);
    });
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

async function waitFor(pred, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function runTurn(sessionId) {
  const logFile = path.join(os.tmpdir(), `sm-memscope-log-${process.pid}-${Math.floor(Math.random() * 1e9)}.log`);
  process.env.SM_CLAUDE_BIN = writeStub(logFile);
  attachRecorder();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-memscope-cwd-'));
  cr.run({ tabId: sessionId, sessionId, cwd, prompt: 'hello world' });
  const done = await waitFor(() => sent.some((e) => e.channel === 'chat:run:complete' || e.channel === 'chat:run:error'));
  expect(done).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  return { logFile, cwd };
}

test('wrapped: systemd-run argv, sm-chat unit, stdin still delivered, stopScope never called', async () => {
  const stops = [];
  const wraps = [];
  ms.scopeSupported = () => true;
  ms.memoryLimitsFor = () => ({ memoryMaxMb: 1000, memoryHighMb: 850, swapMaxMb: 100 });
  // Fake systemd-run: run the real command after `--` without systemd.
  ms.wrapInMemoryScope = (o) => {
    wraps.push(o);
    return { command: o.command, args: o.args };
  };
  ms.stopScope = (u) => { stops.push(u); return true; };
  const sid = 'sess-wrapped-1';
  const { logFile } = await runTurn(sid);
  expect(wraps).toHaveLength(1);
  expect(wraps[0].unit).toMatch(/^sm-chat-sess-wrapped-1-1-\d+$/);
  expect(wraps[0].limits.memoryMaxMb).toBe(1000);
  expect(stops).toEqual([]);
  const log = fs.readFileSync(logFile, 'utf8');
  expect(log).toContain('STDIN:');
  expect(log).not.toContain('STDIN:0');
  expect(sent.some((e) => e.channel === 'chat:run:complete')).toBe(true);
});

test('fallback: unsupported scopes spawn unwrapped and never stop a scope', async () => {
  let wrapped = 0;
  const stops = [];
  ms.scopeSupported = () => false;
  ms.wrapInMemoryScope = () => { wrapped++; return { command: 'x', args: [] }; };
  ms.stopScope = (u) => { stops.push(u); return true; };
  await runTurn('sess-fallback-1');
  expect(wrapped).toBe(0);
  expect(stops).toEqual([]);
  expect(sent.some((e) => e.channel === 'chat:run:complete')).toBe(true);
});

test('fallback: limits disabled (null) spawns unwrapped', async () => {
  let wrapped = 0;
  ms.scopeSupported = () => true;
  ms.memoryLimitsFor = () => null;
  ms.wrapInMemoryScope = () => { wrapped++; return { command: 'x', args: [] }; };
  await runTurn('sess-fallback-2');
  expect(wrapped).toBe(0);
  expect(sent.some((e) => e.channel === 'chat:run:complete')).toBe(true);
});

test('null limits: scopeSupported is never probed and the spawn is unwrapped', async () => {
  let probed = 0;
  let wrapped = 0;
  ms.memoryLimitsFor = () => null;
  ms.scopeSupported = () => { probed++; return true; };
  ms.wrapInMemoryScope = () => { wrapped++; return { command: 'x', args: [] }; };
  await runTurn('sess-nolimits-1');
  expect(probed).toBe(0);
  expect(wrapped).toBe(0);
  expect(sent.some((e) => e.channel === 'chat:run:complete')).toBe(true);
});
