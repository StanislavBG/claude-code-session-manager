'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp, mod, mint;
const AUTO = { producer: 'cross-project-feedback', autoApprove: { ground: 'x' } };

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
    d: { id: 'd', tag: 'bug', claudeSessionId: 'cs-bug', source: AUTO },
    e: { id: 'e', tag: 'feature', claudeSessionId: 'cs-feat', source: AUTO },
    f: { id: 'f', tag: 'discussion', claudeSessionId: 'cs-disc', source: AUTO },
    g: { id: 'g', tag: 'bug', claudeSessionId: 'cs-prd', source: AUTO },
    h: { id: 'h', tag: 'bug', claudeSessionId: 'cs-arch', source: AUTO },
    i: { id: 'i', tag: 'bug', claudeSessionId: 'cs-hand-bug', source: { producer: 'cross-project-feedback' } },
  });
});

function touch(rel) {
  const { opsPath } = require('../../opsOwnership.cjs');
  const file = opsPath(tmp, 'scheduler', 'epics', ...rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# prd');
}

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

test('autoStartNeedsPlan: true for bug/feature with no PRDs', () => {
  expect(mod.autoStartNeedsPlan(tmp, 'cs-bug')).toBe(true);
  expect(mod.autoStartNeedsPlan(tmp, 'cs-feat')).toBe(true);
});

test('autoStartNeedsPlan: false for discussion, unstamped, unknown, bad input', () => {
  expect(mod.autoStartNeedsPlan(tmp, 'cs-disc')).toBe(false);
  expect(mod.autoStartNeedsPlan(tmp, 'cs-hand-bug')).toBe(false);
  expect(mod.autoStartNeedsPlan(tmp, 'nope')).toBe(false);
  expect(mod.autoStartNeedsPlan(undefined, undefined)).toBe(false);
  expect(mod.autoStartNeedsPlan('/nonexistent/zzz', 'cs-bug')).toBe(false);
});

test('autoStartNeedsPlan: false once a PRD exists in prds/ or timestamped prds-archived/', () => {
  touch(['g', 'prds', '01-x.md']);
  touch(['h', 'prds-archived', '2026-10-30T00-00', '02-y.md']);
  expect(mod.autoStartNeedsPlan(tmp, 'cs-prd')).toBe(false);
  expect(mod.autoStartNeedsPlan(tmp, 'cs-arch')).toBe(false);
});

test('autoStartFollowUp sends once with scheduler origin, only when a plan is needed', () => {
  const calls = [];
  const send = (...a) => { calls.push(a); return Promise.resolve({}); };
  mod.autoStartFollowUp({ cwd: tmp, tabId: 't1', sessionId: 'cs-bug', send });
  mod.autoStartFollowUp({ cwd: tmp, tabId: 't2', sessionId: 'cs-disc', send });
  mod.autoStartFollowUp({ cwd: tmp, tabId: 't3', sessionId: 'cs-prd', send });
  expect(calls).toEqual([
    ['t1', mod.AUTO_START_FOLLOW_UP_PROMPT, { origin: 'scheduler', sessionId: 'cs-bug', cwd: tmp }],
  ]);
  expect(mod.AUTO_START_FOLLOW_UP_PROMPT).toContain('nothing queued');
  expect(mod.AUTO_START_FOLLOW_UP_PROMPT).toContain('/develop');
});

test('autoStartFollowUp never throws when send throws', () => {
  expect(() => mod.autoStartFollowUp({ cwd: tmp, tabId: 't', sessionId: 'cs-bug', send: () => { throw new Error('x'); } })).not.toThrow();
});
