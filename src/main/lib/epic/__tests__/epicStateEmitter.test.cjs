/**
 * epicStateEmitter.test.cjs — the per-Epic debounced recompute that appends
 * one `epic.state_changed` event to the Epic's own log whenever its outside
 * state (state, blockedKind) changes.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicStateEmitter.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../epicEventLog.cjs');
const emitter = require('../epicStateEmitter.cjs');
const { EPIC_OUTSIDE_STATES } = require('../epicOutsideState.cjs');

const EPIC = 'e-1';
let cwd;
let home;
let jobs;
let busy;
let index;

function psDir() {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions');
}

function writeIndex() {
  fs.mkdirSync(psDir(), { recursive: true });
  fs.writeFileSync(path.join(psDir(), 'active-index.json'), JSON.stringify(index, null, 2));
}

function session(id, overrides = {}) {
  return {
    id,
    cwd,
    goalText: `Title ${id}`,
    claudeSessionId: `sess-${id}`,
    status: 'active',
    tag: 'feature',
    agentType: 'architect',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function setSession(s) {
  index.sessions[s.id] = s;
  writeIndex();
}

function addChainEvent(id, e) {
  (index.events[id] = index.events[id] || []).push(e);
  writeIndex();
}

async function rows(id = EPIC) {
  return (await log.readEpicEvents(cwd, id, { kinds: ['epic.state_changed'], limit: 1000 })).events;
}

async function settle() {
  await emitter._settleForTests();
}

async function poke(o, id = EPIC) {
  emitter.pokeEpicState(cwd, id, o);
  await settle();
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-state-emit-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-state-emit-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  log._resetForTests();
  emitter._resetForTests();
  jobs = [];
  busy = new Set();
  index = { sessions: {}, events: {} };
  writeIndex();
  emitter.configureEpicStateEmitter({
    debounceMs: 0,
    listJobs: () => jobs,
    isTabBusy: (id) => busy.has(id),
    projectRoots: () => [cwd],
  });
});

afterEach(() => {
  emitter._resetForTests();
  log._resetForTests();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('EPIC_STATE_CHANGED_TO is frozen: the 8 outside states plus gone', () => {
  expect(Object.isFrozen(emitter.EPIC_STATE_CHANGED_TO)).toBe(true);
  expect([...emitter.EPIC_STATE_CHANGED_TO].sort()).toEqual([...EPIC_OUTSIDE_STATES, 'gone'].sort());
  expect(log.EVENT_KINDS).toContain('epic.state_changed');
});

test('open → working → in_review → verified → blocked(refuted) → closed, one row each, none when unchanged', async () => {
  setSession(session(EPIC, { source: { externalRef: 'ref-1' } }));

  await poke();
  await poke(); // nothing changed → no second row
  busy.add(EPIC);
  await poke();
  busy.delete(EPIC);
  jobs = [{ epicId: EPIC, slug: '0001-x', status: 'completed', finishedAt: '2026-11-02T00:00:00.000Z' }];
  await poke();
  await poke(); // still in_review → no row
  addChainEvent(EPIC, { kind: 'response', prdSlug: '0001-x', validation: 'verified', at: '2026-11-03T00:00:00.000Z' });
  await poke();
  addChainEvent(EPIC, { kind: 'response', prdSlug: '0001-x', validation: 'refuted', reason: 'nope', at: '2026-11-04T00:00:00.000Z' });
  await poke();
  await poke({ lifecycleTo: 'completed' });

  const got = (await rows()).map(({ from, to, blockedKind, externalRef }) => ({ from, to, blockedKind, externalRef }));
  expect(got).toEqual([
    { from: null, to: 'open', blockedKind: undefined, externalRef: 'ref-1' },
    { from: 'open', to: 'working', blockedKind: undefined, externalRef: 'ref-1' },
    { from: 'working', to: 'in_review', blockedKind: undefined, externalRef: 'ref-1' },
    { from: 'in_review', to: 'verified', blockedKind: undefined, externalRef: 'ref-1' },
    { from: 'verified', to: 'blocked', blockedKind: 'refuted', externalRef: 'ref-1' },
    { from: 'blocked', to: 'closed', blockedKind: undefined, externalRef: 'ref-1' },
  ]);
  const raw = await rows();
  expect(raw[0]).not.toHaveProperty('blockedKind');
  expect(raw[5]).not.toHaveProperty('blockedKind');
});

test('proposed lifecycle records awaiting_approval without a recompute; no externalRef key when absent', async () => {
  // No session in the index at all: a recompute would return null.
  await poke({ lifecycleTo: 'proposed' });
  const r = await rows();
  expect(r.map((e) => e.to)).toEqual(['awaiting_approval']);
  expect(r[0].from).toBeNull();
  expect(r[0]).not.toHaveProperty('externalRef');
});

test('a to outside EPIC_STATE_CHANGED_TO is dropped and logged', async () => {
  const outsideRead = require('../epicOutsideRead.cjs');
  vi.spyOn(outsideRead, 'getEpicRecord').mockResolvedValue({ state: 'weird', status: 'active', blocked: null });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await poke();
  expect(await rows()).toEqual([]);
  expect(err).toHaveBeenCalledWith(expect.stringContaining('[epicStateEmitter]'), expect.anything(), expect.anything(), 'weird');
});

test('the last state is recovered from the log, so a restart does not repeat a row', async () => {
  setSession(session(EPIC));
  await poke();
  expect((await rows()).map((e) => e.to)).toEqual(['open']);

  // Simulated restart: in-memory state gone, log on disk stays.
  emitter._resetForTests();
  log._resetForTests();
  emitter.configureEpicStateEmitter({ debounceMs: 0, listJobs: () => jobs, isTabBusy: (id) => busy.has(id), projectRoots: () => [cwd] });
  await poke();
  expect((await rows()).map((e) => e.to)).toEqual(['open']);
  busy.add(EPIC);
  await poke();
  const r = await rows();
  expect(r.map((e) => [e.from, e.to])).toEqual([[null, 'open'], ['open', 'working']]);
});

test('gone: a vanished Epic records gone once; never after closed, never with no prior state', async () => {
  // No prior state + null record → nothing.
  await poke({}, 'e-none');
  expect(await rows('e-none')).toEqual([]);

  setSession(session(EPIC));
  await poke();
  delete index.sessions[EPIC];
  writeIndex();
  await poke();
  await poke();
  expect((await rows()).map((e) => [e.from, e.to])).toEqual([[null, 'open'], ['open', 'gone']]);

  setSession(session('e-2'));
  await poke({}, 'e-2');
  await poke({ lifecycleTo: 'completed' }, 'e-2');
  delete index.sessions['e-2'];
  writeIndex();
  await poke({}, 'e-2');
  expect((await rows('e-2')).map((e) => e.to)).toEqual(['open', 'closed']);
});

test('active lifecycle retries while the record still reads another status, at most 5 times', async () => {
  const outsideRead = require('../epicOutsideRead.cjs');
  const spy = vi.spyOn(outsideRead, 'getEpicRecord')
    .mockResolvedValueOnce({ state: 'awaiting_approval', status: 'proposed', blocked: null })
    .mockResolvedValueOnce({ state: 'awaiting_approval', status: 'proposed', blocked: null })
    .mockResolvedValue({ state: 'open', status: 'active', blocked: null });
  await poke({ lifecycleTo: 'active' });
  expect(spy).toHaveBeenCalledTimes(3);
  expect((await rows()).map((e) => e.to)).toEqual(['open']);

  spy.mockReset();
  spy.mockResolvedValue({ state: 'awaiting_approval', status: 'proposed', blocked: null });
  await poke({ lifecycleTo: 'active' }, 'e-stuck');
  expect(spy).toHaveBeenCalledTimes(6); // first read + 5 retries
  expect((await rows('e-stuck')).map((e) => e.to)).toEqual(['awaiting_approval']);
});

test('a poke during a recompute schedules exactly one more; pokes debounce per Epic', async () => {
  const outsideRead = require('../epicOutsideRead.cjs');
  let release;
  const gate = new Promise((r) => { release = r; });
  const spy = vi.spyOn(outsideRead, 'getEpicRecord').mockImplementation(async () => {
    if (spy.mock.calls.length === 1) await gate;
    return { state: 'open', status: 'active', blocked: null };
  });
  emitter.pokeEpicState(cwd, EPIC);
  // First recompute reads the Epic log from disk (real I/O) before getEpicRecord: wait for it, not a fixed sleep.
  await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  emitter.pokeEpicState(cwd, EPIC);
  emitter.pokeEpicState(cwd, EPIC);
  await new Promise((r) => setTimeout(r, 10));
  emitter.pokeEpicState(cwd, EPIC);
  await new Promise((r) => setTimeout(r, 10));
  expect(spy).toHaveBeenCalledTimes(1);
  release();
  await settle();
  expect(spy).toHaveBeenCalledTimes(2);
  expect((await rows()).map((e) => e.to)).toEqual(['open']);
});

test('debounce: many pokes inside the window run one recompute', async () => {
  vi.useFakeTimers();
  try {
    const outsideRead = require('../epicOutsideRead.cjs');
    const spy = vi.spyOn(outsideRead, 'getEpicRecord').mockResolvedValue({ state: 'open', status: 'active', blocked: null });
    emitter.configureEpicStateEmitter({ debounceMs: 1000 });
    for (let i = 0; i < 5; i++) {
      emitter.pokeEpicState(cwd, EPIC);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    // The recompute's first step reads the Epic log from disk (real I/O, not a
    // timer), so finish it on real timers before counting recomputes.
    vi.useRealTimers();
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
  await settle();
});

test('startEpicStateEmitter pokes on the listed kinds, passes lifecycleTo, never on its own kind', async () => {
  setSession(session(EPIC, { status: 'proposed' }));
  const stop = emitter.startEpicStateEmitter();
  try {
    await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted' });
    await settle();
    expect((await rows()).map((e) => e.to)).toEqual(['awaiting_approval']);

    setSession(session(EPIC, { status: 'active' }));
    await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.status_changed', from: 'proposed', to: 'active' });
    await settle();
    expect((await rows()).map((e) => e.to)).toEqual(['awaiting_approval', 'open']);

    // A kind outside the list does not poke.
    busy.add(EPIC);
    await log.appendEpicEvent(cwd, EPIC, { kind: 'job.tool_use' });
    await settle();
    expect((await rows()).map((e) => e.to)).toEqual(['awaiting_approval', 'open']);

    await log.appendEpicEvent(cwd, EPIC, { kind: 'human.message' });
    await settle();
    expect((await rows()).map((e) => e.to)).toEqual(['awaiting_approval', 'open', 'working']);

    // Lifecycle completed → closed without a recompute.
    await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.status_changed', from: 'active', to: 'completed' });
    await settle();
    expect((await rows()).map((e) => e.to)).toEqual(['awaiting_approval', 'open', 'working', 'closed']);
  } finally {
    stop();
  }
});
