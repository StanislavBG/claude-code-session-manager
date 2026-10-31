/**
 * chatRunOrigin.test.cjs — chat:run `origin` gates what reaches the human
 * prompt ledger: only an explicit 'human' is auto-approve evidence.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/chatRunOrigin.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let cr;
let ledger;
let schemas;
const handlers = {};
const fakeIpc = { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => {} };

const PROMPT = 'please ask the other project to add the widget export feature';

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunorigin-home-'));
  process.env.HOME = tmpHome;
  // chatRunner destructures ipcMain from electron at load; stub it so the
  // chat:run handler can be captured and called.
  const Module = require('node:module');
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { ipcMain: fakeIpc, app: {}, BrowserWindow: {} };
    return realLoad.call(this, request, ...rest);
  };
  try { cr = require('../chatRunner.cjs'); } finally { Module._load = realLoad; }
  ledger = require('../lib/feedback-remote/humanPromptLedger.cjs');
  ({ schemas } = require('../ipcSchemas.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => ledger._resetForTests());

test("origin 'human' is recorded and findable", () => {
  cr.noteChatRunOrigin({ sessionId: 's1', prompt: PROMPT, origin: 'human' });
  expect(ledger.findHumanPromptContaining('s1', PROMPT)).not.toBeNull();
});

test.each(['external', 'inbound-proposal', undefined])('origin %s is not recorded', (origin) => {
  cr.noteChatRunOrigin({ sessionId: 's2', prompt: PROMPT, origin });
  expect(ledger.findHumanPromptContaining('s2', PROMPT)).toBeNull();
});

test('chatRun schema accepts known origins and rejects others', () => {
  const base = { tabId: 't', sessionId: 's', prompt: 'hi', cwd: '/tmp' };
  for (const origin of ['human', 'external', 'inbound-proposal']) {
    expect(schemas.chatRun.safeParse({ ...base, origin }).success).toBe(true);
  }
  expect(schemas.chatRun.safeParse(base).success).toBe(true);
  expect(schemas.chatRun.safeParse({ ...base, origin: 'admin' }).success).toBe(false);
});

test('turnInstructionFor: scheduler, auto-started inbound, hand-approved inbound, human', () => {
  expect(cr.turnInstructionFor('scheduler', tmpHome, 'x')).toBe(cr.SCHEDULER_TURN_INSTRUCTION);
  expect(cr.turnInstructionFor('inbound-proposal', tmpHome, 'unknown')).toBe(cr.STOP_SIGNAL_INSTRUCTION);
  expect(cr.turnInstructionFor('human', tmpHome, 'x')).toBe(cr.STOP_SIGNAL_INSTRUCTION);
  expect(cr.turnInstructionFor(undefined, tmpHome, 'x')).toBe(cr.STOP_SIGNAL_INSTRUCTION);
});

test('chat:run handler passes origin through to run()', async () => {
  const seen = [];
  cr.__setExecutor((job) => { seen.push(job.origin); return Promise.resolve(); });
  try {
    cr.registerChatHandlers();
    await handlers['chat:run']({}, { tabId: 'to', sessionId: 'so', prompt: 'p', cwd: '/tmp', origin: 'inbound-proposal' });
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    cr.__setExecutor(null);
  }
  expect(seen).toContain('inbound-proposal');
});
