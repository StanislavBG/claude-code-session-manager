/**
 * chatRunner-agent-cli.test.cjs — a Chat turn of an Epic with agentCli 'opencode'
 * spawns the OpenCode adapter's command (stub via SM_AGENT_CLI_BIN_OPENCODE),
 * feeds the prompt on stdin, streams translated events through processLine,
 * records the native session id, and resumes it on the next turn.
 *
 * Run: timeout 200 npx vitest run src/main/__tests__/chatRunner-agent-cli.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', 'lib', 'agent-cli', '__tests__', 'fixtures', 'opencode-run.jsonl');
const NATIVE = 'ses_e2c3efb91ffeZqm9hUYGt0mu07';
const SID = '0b7e2f4c-9a1d-4c3e-8f2a-6d5b4c3a2f10';

let tmpHome;
let tmpState;
let tmpDir;
let originalHome;
let originalState;
let cr;
let amr;
let origFind;
let sent;

beforeAll(() => {
  originalHome = process.env.HOME;
  originalState = process.env.SM_AGENT_CLI_STATE_DIR;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-agentcli-home-'));
  tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-agentcli-state-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-agentcli-work-'));
  process.env.HOME = tmpHome;
  process.env.SM_AGENT_CLI_STATE_DIR = tmpState;
  amr = require('../lib/claude/agentModelResolve.cjs');
  origFind = amr.findEpicByClaudeSessionId;
  cr = require('../chatRunner.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalState === undefined) delete process.env.SM_AGENT_CLI_STATE_DIR;
  else process.env.SM_AGENT_CLI_STATE_DIR = originalState;
  for (const d of [tmpHome, tmpState, tmpDir]) fs.rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  amr.findEpicByClaudeSessionId = origFind;
  delete process.env.SM_AGENT_CLI_BIN_OPENCODE;
  cr.__resetQueueForTests();
  cr.attachWindow(null);
});

function writeStub(logFile) {
  const stubPath = path.join(tmpDir, `stub-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { stdin += c; });
    process.stdin.on('end', () => {
      fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
      process.stdout.write(fs.readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));
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

async function runTurn(prompt) {
  amr.findEpicByClaudeSessionId = () => ({ claudeSessionId: SID, agentCli: 'opencode', developLoop: false });
  const logFile = path.join(tmpDir, `log-${Math.floor(Math.random() * 1e9)}.jsonl`);
  process.env.SM_AGENT_CLI_BIN_OPENCODE = writeStub(logFile);
  sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
  const cwd = fs.mkdtempSync(path.join(tmpDir, 'cwd-'));
  cr.run({ tabId: SID, sessionId: SID, cwd, prompt });
  const done = await waitFor(() => sent.some((e) => e.channel === 'chat:run:complete' || e.channel === 'chat:run:error'));
  expect(done).toBe(true);
  return JSON.parse(fs.readFileSync(logFile, 'utf8').split('\n')[0]);
}

test('opencode Epic: adapter argv, prompt on stdin, events broadcast, native id persisted and resumed', async () => {
  const first = await runTurn('hello opencode');
  expect(first.argv.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto']);
  expect(first.argv).not.toContain('--session');
  expect(first.argv).not.toContain('--model');
  expect(first.stdin).toContain('hello opencode');

  const channels = sent.map((e) => e.channel);
  expect(sent.find((e) => e.channel === 'chat:run:error')).toBeUndefined();
  expect(channels).toContain('chat:run:output');
  expect(channels).toContain('chat:run:tool-use');
  const complete = sent.find((e) => e.channel === 'chat:run:complete');
  expect(complete.payload.finalMessage).toBe('OK');

  const sidecar = JSON.parse(fs.readFileSync(path.join(tmpState, 'sessions', `${SID}.json`), 'utf8'));
  expect(sidecar).toMatchObject({ cli: 'opencode', nativeSessionId: NATIVE });
  const transcript = fs.readFileSync(path.join(tmpState, 'transcripts', `${SID}.jsonl`), 'utf8');
  expect(transcript).toContain('hello opencode');

  const second = await runTurn('again');
  const i = second.argv.indexOf('--session');
  expect(i).toBeGreaterThan(-1);
  expect(second.argv[i + 1]).toBe(NATIVE);
});
