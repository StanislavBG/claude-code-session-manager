/**
 * epicTransitions.test.cjs — transitionEpic is the one chokepoint for an
 * Epic's status after mint: legal edges mutate + audit + emit
 * epic.status_changed; illegal edges throw under test; markCompleted's
 * archive write (config.cjs) and reopen (epicReopen.cjs) route through it.
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicTransitions.test.cjs
 */
'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const epicEventLog = require('../epicEventLog.cjs');
const auditLog = require('../../telemetry/auditLog.cjs');
const {
  EPIC_LEGAL_TRANSITIONS,
  transitionEpic,
  getRefusedEpicTransitionCount,
  _resetRefusedEpicTransitionCountForTests,
} = require('../epicTransitions.cjs');
const { epicMirrorPath, parseEpicMirrorPath, readEpicMirrorStatus } = require('../epicStatusMirror.cjs');

let tmp;
let audits;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-transitions-'));
  epicEventLog._resetForTests();
  _resetRefusedEpicTransitionCountForTests();
  audits = [];
  vi.spyOn(auditLog, 'appendAuditEvent').mockImplementation((kind, fields) => { audits.push({ kind, ...fields }); });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setTimeout(r, 30));
// Polls until the fire-and-forget append lands (fixed sleeps flake under a loaded suite).
async function waitForEvents(cwd, id, n) {
  for (let i = 0; i < 200; i++) {
    const { events } = await epicEventLog.readEpicEvents(cwd, id);
    if (events.length >= n) return events;
    await new Promise((r) => setTimeout(r, 10));
  }
  return (await epicEventLog.readEpicEvents(cwd, id)).events;
}
const newId = () => `epic-${crypto.randomUUID().slice(0, 8)}`;

test('legality table holds the lifecycle edges', () => {
  expect(EPIC_LEGAL_TRANSITIONS.proposed).toContain('active');
  expect(EPIC_LEGAL_TRANSITIONS.active).toContain('completed');
  expect(EPIC_LEGAL_TRANSITIONS.completed).toContain('active');
  expect(EPIC_LEGAL_TRANSITIONS.active).not.toContain('proposed');
  expect(EPIC_LEGAL_TRANSITIONS.completed).not.toContain('proposed');
});

for (const [from, to] of [['proposed', 'active'], ['active', 'completed'], ['completed', 'active'], ['proposed', 'completed']]) {
  test(`legal edge ${from} -> ${to} mutates, audits and emits epic.status_changed`, async () => {
    const id = newId();
    const epic = { id, cwd: tmp, status: from };
    expect(transitionEpic(epic, to, { reason: 'r', source: 'test' })).toBe(true);
    expect(epic.status).toBe(to);
    expect(audits).toEqual([expect.objectContaining({ kind: 'epic_transition', epicId: id, from, to, reason: 'r', source: 'test' })]);
    const events = await waitForEvents(tmp, id, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, epicId: id, kind: 'epic.status_changed', from, to, reason: 'r', source: 'test' });
  });
}

test('illegal edge throws under test, leaves the Epic untouched, audits the refusal, emits nothing', async () => {
  const id = newId();
  const epic = { id, cwd: tmp, status: 'active' };
  expect(() => transitionEpic(epic, 'proposed', { reason: 'bad', source: 'test' })).toThrow(/illegal transition refused/);
  expect(epic.status).toBe('active');
  expect(getRefusedEpicTransitionCount()).toBe(1);
  expect(audits).toEqual([expect.objectContaining({ kind: 'epic_transition_refused', epicId: id, from: 'active', to: 'proposed' })]);
  await flush();
  const { events } = await epicEventLog.readEpicEvents(tmp, id);
  expect(events).toHaveLength(0);
});

test('illegal edge returns false outside test env (refuse, never throw)', () => {
  const prevNode = process.env.NODE_ENV;
  const prevVitest = process.env.VITEST;
  process.env.NODE_ENV = 'production';
  delete process.env.VITEST;
  try {
    const epic = { id: newId(), cwd: tmp, status: 'completed' };
    expect(transitionEpic(epic, 'proposed', { source: 'test' })).toBe(false);
    expect(epic.status).toBe('completed');
  } finally {
    process.env.NODE_ENV = prevNode;
    if (prevVitest !== undefined) process.env.VITEST = prevVitest;
  }
});

test('identity transition is a silent no-op', async () => {
  const id = newId();
  const epic = { id, cwd: tmp, status: 'completed' };
  expect(transitionEpic(epic, 'completed', { source: 'test' })).toBe(true);
  expect(audits).toHaveLength(0);
  await flush();
  expect((await epicEventLog.readEpicEvents(tmp, id)).events).toHaveLength(0);
});

test('unknown target status is refused', () => {
  expect(() => transitionEpic({ id: newId(), cwd: tmp, status: 'proposed' }, 'draft', {})).toThrow();
});

test('parseEpicMirrorPath / readEpicMirrorStatus', () => {
  const id = newId();
  const file = epicMirrorPath(tmp, id);
  expect(parseEpicMirrorPath(file)).toEqual({ cwd: tmp, epicId: id });
  expect(parseEpicMirrorPath(path.join(path.dirname(file), 'active-index.json'))).toBeNull();
  expect(parseEpicMirrorPath(path.join(tmp, 'other', 'x.json'))).toBeNull();
  expect(readEpicMirrorStatus(tmp, id)).toBeNull();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ status: 'active' }));
  expect(readEpicMirrorStatus(tmp, id)).toBe('active');
});

test('markCompleted archive write (config.cjs) goes through transitionEpic', async () => {
  const { transitionEpicArchiveWrite } = require('../../../config.cjs');
  const id = newId();
  const file = epicMirrorPath(tmp, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, cwd: tmp, status: 'active' }));
  transitionEpicArchiveWrite(file, { session: { id, status: 'completed' }, events: [] });
  const events = await waitForEvents(tmp, id, 1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'epic.status_changed', from: 'active', to: 'completed', reason: 'markCompleted' });

  // Rewriting an already-completed archive is an identity no-op.
  fs.writeFileSync(file, JSON.stringify({ session: { id, status: 'completed' }, status: 'completed' }));
  transitionEpicArchiveWrite(file, { session: { id, status: 'completed' } });
  await flush();
  expect((await epicEventLog.readEpicEvents(tmp, id)).events).toHaveLength(1);

  // A non-archive write passes through untouched.
  expect(() => transitionEpicArchiveWrite(file, { status: 'active' })).not.toThrow();
});
