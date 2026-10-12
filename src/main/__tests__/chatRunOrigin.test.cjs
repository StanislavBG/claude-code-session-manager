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

const PROMPT = 'please ask the other project to add the widget export feature';

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-chatrunorigin-home-'));
  process.env.HOME = tmpHome;
  cr = require('../chatRunner.cjs');
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
