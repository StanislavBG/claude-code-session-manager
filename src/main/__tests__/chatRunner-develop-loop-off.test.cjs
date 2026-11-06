/**
 * chatRunner-develop-loop-off.test.cjs — a chat turn of an Epic with developLoop === false
 * launches with --settings disabling the dev plugin; every other turn's argv is unchanged.
 *
 * Run: timeout 200 npx vitest run src/main/__tests__/chatRunner-develop-loop-off.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let cr;
let amr;
let origFind;
let sent;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-looprof-home-'));
  process.env.HOME = tmpHome;
  amr = require('../lib/claude/agentModelResolve.cjs');
  origFind = amr.findEpicByClaudeSessionId;
  cr = require('../chatRunner.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  amr.findEpicByClaudeSessionId = origFind;
  delete process.env.SM_CLAUDE_BIN;
  cr.__resetQueueForTests();
  cr.attachWindow(null);
});

function writeStub(logFile) {
  const stubPath = path.join(os.tmpdir(), `sm-looprof-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    process.stdin.resume();
    process.stdin.on('end', () => {
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

async function runTurn(sessionId, epic) {
  amr.findEpicByClaudeSessionId = () => epic;
  const logFile = path.join(os.tmpdir(), `sm-looprof-log-${process.pid}-${Math.floor(Math.random() * 1e9)}.log`);
  process.env.SM_CLAUDE_BIN = writeStub(logFile);
  sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-looprof-cwd-'));
  cr.run({ tabId: sessionId, sessionId, cwd, prompt: 'hello' });
  const done = await waitFor(() => sent.some((e) => e.channel === 'chat:run:complete' || e.channel === 'chat:run:error'));
  expect(done).toBe(true);
  const line = fs.readFileSync(logFile, 'utf8').split('\n').find((l) => l.startsWith('['));
  return JSON.parse(line);
}

test('developLoop false Epic: --settings present, before --output-format', async () => {
  const argv = await runTurn('sess-loopoff-1', { developLoop: false });
  const i = argv.indexOf('--settings');
  expect(i).toBeGreaterThan(-1);
  expect(JSON.parse(argv[i + 1]).enabledPlugins['session-manager-dev@session-manager']).toBe(false);
  expect(i).toBeLessThan(argv.indexOf('--output-format'));
});

test('developLoop true / absent / no Epic: no --settings', async () => {
  for (const [n, epic] of [['a', { developLoop: true }], ['b', {}], ['c', null]]) {
    const argv = await runTurn(`sess-loopon-${n}`, epic);
    expect(argv).not.toContain('--settings');
  }
});
