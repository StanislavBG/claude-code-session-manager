'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp, mod, mint;

function writeIndex(sessions) {
  const { opsPath } = require('../../opsOwnership.cjs');
  const file = opsPath(tmp, 'prompt-sessions', 'active-index.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessions }));
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-autostart-'));
  mod = require('../autoStartedSession.cjs');
  mint = require('../../epic/epicMint.cjs');
  writeIndex({
    a: { id: 'a', claudeSessionId: 'cs-auto', source: { producer: 'cross-project-feedback', autoApprove: { ground: 'x' } } },
    b: { id: 'b', claudeSessionId: 'cs-hand', source: { producer: 'cross-project-feedback' } },
    c: { id: 'c', claudeSessionId: 'cs-ui', source: { producer: 'new-epic-ui', autoApprove: true } },
  });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('stamped epic is auto-started', () => {
  expect(mint.readActiveIndex(tmp).sessions.a).toBeTruthy();
  expect(mod.isAutoStartedEpic(tmp, 'cs-auto')).toBe(true);
});

test('unstamped or other-producer epic is not', () => {
  expect(mod.isAutoStartedEpic(tmp, 'cs-hand')).toBe(false);
  expect(mod.isAutoStartedEpic(tmp, 'cs-ui')).toBe(false);
});

test('unknown session, bad input and missing dir never throw', () => {
  expect(mod.isAutoStartedEpic(tmp, 'nope')).toBe(false);
  expect(mod.isAutoStartedEpic(undefined, undefined)).toBe(false);
  expect(mod.isAutoStartedEpic('/nonexistent/zzz', 'cs-auto')).toBe(false);
});

test('instruction forbids the sentinel and questions', () => {
  const t = mod.autoStartTurnInstruction('<<S>>');
  expect(t).toContain('Never ask questions and never print <<S>>');
  expect(t).toContain('/develop');
});
