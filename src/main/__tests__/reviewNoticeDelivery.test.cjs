'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let cwd;
let appendResponseEventWithReason;

function writeIndex(status) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({
    sessions: { e1: { id: 'e1', status } },
    events: { e1: [{ id: 'ev0', promptSessionId: 'e1', kind: 'prompt', at: new Date().toISOString(), text: 'x' }] },
  }));
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'review-notice-delivery-'));
  process.env.HOME = tmpHome;
  cwd = path.join(tmpHome, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  require('../config.cjs').addAllowedRoot(cwd);
  ({ appendResponseEventWithReason } = require('../promptSessionEvents.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('completed Epic accepted with allowInactive', async () => {
  writeIndex('completed');
  const r = await appendResponseEventWithReason(cwd, 'e1', 'hi', { allowInactive: true, prdSlug: 'p' });
  expect(r).toEqual({ ok: true });
});

test('proposed Epic refused without the flag', async () => {
  writeIndex('proposed');
  const r = await appendResponseEventWithReason(cwd, 'e1', 'hi', {});
  expect(r).toEqual({ ok: false, reason: 'not-active' });
});

test('no-session still refused with the flag', async () => {
  writeIndex('completed');
  const r = await appendResponseEventWithReason(cwd, 'missing', 'hi', { allowInactive: true });
  expect(r).toEqual({ ok: false, reason: 'no-session' });
});

test('allowInactive is not written onto the event', async () => {
  writeIndex('completed');
  await appendResponseEventWithReason(cwd, 'e1', 'hi', { allowInactive: true });
  const data = JSON.parse(fs.readFileSync(path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'), 'utf8'));
  expect(data.events.e1.at(-1)).not.toHaveProperty('allowInactive');
});
