/**
 * chatRunner-packs.test.cjs — a chat turn of a Claude Code Epic with selected context packs
 * launches with --plugin-dir per known pack and the packs' laws via --append-system-prompt,
 * after the develop-loop-off args and before --output-format. Agent-CLI Epics and Epics
 * without packs keep today's argv.
 *
 * Run: timeout 200 npx vitest run src/main/__tests__/chatRunner-packs.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let tmpState;
let tmpDir;
let originalHome;
let originalState;
let cr;
let amr;
let psa;
let origFind;
let origCompose;
let composeCalls;
let sent;

const CATALOG = [
  { id: 'alpha', label: 'Alpha', dir: '/packs/alpha', laws: 'Always alpha.', requires: {} },
  { id: 'beta', label: 'Beta', dir: '/packs/beta', laws: '', requires: {} },
];

beforeAll(() => {
  originalHome = process.env.HOME;
  originalState = process.env.SM_AGENT_CLI_STATE_DIR;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-packs-home-'));
  tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-packs-state-'));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunner-packs-work-'));
  process.env.HOME = tmpHome;
  process.env.SM_AGENT_CLI_STATE_DIR = tmpState;
  amr = require('../lib/claude/agentModelResolve.cjs');
  psa = require('../lib/packs/packSpawnArgs.cjs');
  origFind = amr.findEpicByClaudeSessionId;
  origCompose = psa.composePackSpawnArgs;
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
  psa.composePackSpawnArgs = origCompose;
  delete process.env.SM_CLAUDE_BIN;
  delete process.env.SM_AGENT_CLI_BIN_OPENCODE;
  cr.__resetQueueForTests();
  cr.attachWindow(null);
});

function writeStub(logFile) {
  const stubPath = path.join(tmpDir, `stub-${Math.floor(Math.random() * 1e9)}.cjs`);
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

/** @param {{ compose?: Function }} [opts] */
async function runTurn(sessionId, epic, { compose } = {}) {
  amr.findEpicByClaudeSessionId = () => epic;
  composeCalls = [];
  psa.composePackSpawnArgs = (opts) => {
    composeCalls.push(opts);
    return compose ? compose(opts) : origCompose({ ...opts, catalog: CATALOG });
  };
  const logFile = path.join(tmpDir, `log-${Math.floor(Math.random() * 1e9)}.log`);
  const stub = writeStub(logFile);
  if (epic && epic.agentCli === 'opencode') process.env.SM_AGENT_CLI_BIN_OPENCODE = stub;
  else process.env.SM_CLAUDE_BIN = stub;
  sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
  const cwd = fs.mkdtempSync(path.join(tmpDir, 'cwd-'));
  cr.run({ tabId: sessionId, sessionId, cwd, prompt: 'hello' });
  const done = await waitFor(() => sent.some((e) => e.channel === 'chat:run:complete' || e.channel === 'chat:run:error'));
  expect(done).toBe(true);
  const line = fs.readFileSync(logFile, 'utf8').split('\n').find((l) => l.startsWith('['));
  return JSON.parse(line);
}

function pluginDirs(argv) {
  const out = [];
  argv.forEach((a, i) => { if (a === '--plugin-dir') out.push(argv[i + 1]); });
  return out;
}

test('packs with the loop on: --plugin-dir per pack + laws, before --output-format', async () => {
  const argv = await runTurn('sess-packs-on', { developLoop: true, packs: ['alpha', 'beta'] });
  expect(composeCalls).toHaveLength(1);
  expect(composeCalls[0].packIds).toEqual(['alpha', 'beta']);
  expect(pluginDirs(argv)).toEqual(['/packs/alpha', '/packs/beta']);
  expect(argv).not.toContain('--settings');
  const ap = argv.indexOf('--append-system-prompt');
  expect(ap).toBeGreaterThan(-1);
  expect(argv[ap + 1]).toContain('Always alpha.');
  const out = argv.indexOf('--output-format');
  expect(argv.lastIndexOf('--plugin-dir')).toBeLessThan(ap);
  expect(ap).toBeLessThan(out);
});

test('packs with the loop off: --settings then --plugin-dir, both before --output-format', async () => {
  const argv = await runTurn('sess-packs-off', { developLoop: false, packs: ['alpha'] });
  const s = argv.indexOf('--settings');
  const p = argv.indexOf('--plugin-dir');
  expect(s).toBeGreaterThan(-1);
  expect(p).toBeGreaterThan(s);
  expect(argv[p + 1]).toBe('/packs/alpha');
  expect(p).toBeLessThan(argv.indexOf('--output-format'));
});

test('no packs / empty packs / no Epic: argv unchanged (no pack args)', async () => {
  for (const [n, epic] of [['a', { developLoop: true }], ['b', { packs: [] }], ['c', null]]) {
    const argv = await runTurn(`sess-nopacks-${n}`, epic);
    expect(argv).not.toContain('--plugin-dir');
    expect(argv).not.toContain('--append-system-prompt');
    expect(argv.indexOf('--output-format')).toBe(argv.indexOf('--dangerously-skip-permissions') + 1);
  }
});

test('beta-only pack (no laws): --plugin-dir but no --append-system-prompt', async () => {
  const argv = await runTurn('sess-packs-nolaws', { packs: ['beta'] });
  expect(pluginDirs(argv)).toEqual(['/packs/beta']);
  expect(argv).not.toContain('--append-system-prompt');
});

test('agent-CLI Epic: packs never composed, no pack args', async () => {
  const argv = await runTurn('0b7e2f4c-9a1d-4c3e-8f2a-6d5b4c3a2f11', {
    claudeSessionId: '0b7e2f4c-9a1d-4c3e-8f2a-6d5b4c3a2f11', agentCli: 'opencode', developLoop: false, packs: ['alpha'],
  });
  expect(composeCalls).toHaveLength(0);
  expect(argv).not.toContain('--plugin-dir');
  expect(argv).not.toContain('--append-system-prompt');
});

test('unknown pack id is skipped; known ones still load', async () => {
  const argv = await runTurn('sess-packs-unknown', { packs: ['nope', 'alpha'] });
  expect(pluginDirs(argv)).toEqual(['/packs/alpha']);
  const only = await runTurn('sess-packs-unknown-only', { packs: ['nope'] });
  expect(only).not.toContain('--plugin-dir');
  expect(only).not.toContain('--append-system-prompt');
});

test('compose error: turn still launches, without packs', async () => {
  const argv = await runTurn('sess-packs-throw', { packs: ['alpha'] }, { compose: () => { throw new Error('boom'); } });
  expect(argv).not.toContain('--plugin-dir');
  expect(argv).not.toContain('--append-system-prompt');
  expect(argv).toContain('--output-format');
});
