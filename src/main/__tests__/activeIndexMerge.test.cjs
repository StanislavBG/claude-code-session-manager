/**
 * activeIndexMerge.test.cjs — unit tests for the main-process read-merge-write
 * of a cwd's prompt-sessions/active-index.json (lib/activeIndexMerge.cjs),
 * moved here from the renderer (state/promptSessions.ts's old
 * persistActiveIndex, commit 3d12e19) so the merge runs inside the same
 * withPathLock instance epicMint.cjs's ensureEpic already serializes through.
 *
 * Covers the two holes a purely-renderer merge left open:
 *  - resurrection: a tombstoned id must never be written back by a later
 *    merge call whose memory contribution still thinks it's open.
 *  - TOCTOU: a mint (ensureEpic) interleaved with a merge call must survive,
 *    since both now go through the same lock.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/activeIndexMerge.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mergeActiveIndex } = require('../lib/activeIndexMerge.cjs');
const { ensureEpic, readActiveIndex, MINT_AUTHORITY_NEW_EPIC_UI } = require('../lib/epicMint.cjs');
const { appendResponseEventIfKnown } = require('../promptSessionEvents.cjs');
const config = require('../config.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-activeindexmerge-cwd-'));
  // config.cjs's readJson/writeJson restrict to registered roots (home dir by
  // default) — register this tmp dir so the merge's config.readJson/writeJson
  // calls don't reject it as outside the allowed boundary.
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  return cwd;
}

function session(id, overrides = {}) {
  return {
    id,
    cwd: overrides.cwd || '/proj',
    goalText: overrides.goalText || `goal for ${id}`,
    claudeSessionId: overrides.claudeSessionId || `claude-${id}`,
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || '2026-08-02T13:48:00.000Z',
    completedAt: overrides.completedAt ?? null,
  };
}

function promptEvent(id, promptSessionId, at) {
  return { id, promptSessionId, kind: 'prompt', causedByEventId: null, at, text: 'x' };
}

// Incident 2026-08-02: two Epics created by another (already-running) window
// sat on disk. A second window booted empty and, on its first mutation,
// persisted its own (empty-of-those-two) contribution straight over the file.
// The main-side merge must still preserve every pre-existing on-disk Epic.
test('a fresh caller contributing one Epic preserves pre-existing on-disk Epics untouched', async () => {
  const cwd = await mkCwd();
  const other = session('psess-other');
  await mergeActiveIndex(cwd, {
    sessions: { [other.id]: other },
    events: { [other.id]: [promptEvent('evt-1', other.id, other.createdAt)] },
  });

  const fresh = session('psess-fresh', { createdAt: '2026-08-02T13:50:00.000Z' });
  await mergeActiveIndex(cwd, {
    sessions: { [fresh.id]: fresh },
    events: { [fresh.id]: [promptEvent('evt-2', fresh.id, fresh.createdAt)] },
  });

  const index = readActiveIndex(cwd);
  expect(index.sessions[other.id]).toEqual(other);
  expect(index.sessions[fresh.id]).toEqual(fresh);
  expect(index.events[other.id]).toHaveLength(1);
});

test('memory wins over disk on id collision', async () => {
  const cwd = await mkCwd();
  const original = session('psess-1', { goalText: 'Fresh title' });
  await mergeActiveIndex(cwd, { sessions: { [original.id]: original }, events: {} });

  const updated = { ...original, goalText: 'Updated title' };
  await mergeActiveIndex(cwd, { sessions: { [updated.id]: updated }, events: {} });

  const index = readActiveIndex(cwd);
  expect(index.sessions[original.id].goalText).toBe('Updated title');
});

test('removedIds drops the row from the merged write and records a removal tombstone', async () => {
  const cwd = await mkCwd();
  const s = session('psess-1');
  await mergeActiveIndex(cwd, { sessions: { [s.id]: s }, events: {} });

  await mergeActiveIndex(cwd, { sessions: {}, events: {}, removedIds: [s.id] });

  const index = readActiveIndex(cwd);
  expect(index.sessions[s.id]).toBeUndefined();
  expect(index.tombstones[s.id]).toBeTruthy();
});

// The resurrection hole this PRD closes: two simulated windows. Window A
// completes (markCompleted) and persists the removal. Window B never
// hydrated that removal — its in-memory snapshot still holds the Epic as
// 'active' — and persists afterward. The tombstone must win: the Epic stays
// gone, not resurrected.
test('regression: a later merge whose memory still holds a removed Epic as active does not resurrect it', async () => {
  const cwd = await mkCwd();
  const s = session('psess-1', { status: 'active' });
  await mergeActiveIndex(cwd, { sessions: { [s.id]: s }, events: { [s.id]: [promptEvent('e1', s.id, s.createdAt)] } });

  // Window A: markCompleted removes it.
  await mergeActiveIndex(cwd, { sessions: {}, events: {}, removedIds: [s.id] });
  expect(readActiveIndex(cwd).sessions[s.id]).toBeUndefined();

  // Window B: stale in-memory snapshot still has it as 'active', persists
  // its own (unrelated) mutation — a resurrection-prone merge.
  const windowBOther = session('psess-2', { status: 'proposed' });
  await mergeActiveIndex(cwd, {
    sessions: { [s.id]: s, [windowBOther.id]: windowBOther },
    events: { [s.id]: [promptEvent('e1', s.id, s.createdAt)] },
  });

  const index = readActiveIndex(cwd);
  expect(index.sessions[s.id]).toBeUndefined();
  expect(index.events[s.id]).toBeUndefined();
  expect(index.sessions[windowBOther.id]).toEqual(windowBOther);
});

test('event union: disk-only events are appended and re-sorted chain-aware; memory-only events kept', async () => {
  const cwd = await mkCwd();
  const s = session('psess-1');
  const e1 = promptEvent('e1', s.id, '2026-08-02T13:00:00.000Z');
  await mergeActiveIndex(cwd, { sessions: { [s.id]: s }, events: { [s.id]: [e1] } });

  // A scheduler job appended a response event directly to disk between our
  // two merge calls (simulated by mutating the file out of band).
  const midIndex = readActiveIndex(cwd);
  const schedulerEvent = { id: 'e2', promptSessionId: s.id, kind: 'response', causedByEventId: 'e1', at: '2026-08-02T13:05:00.000Z', text: 'done' };
  midIndex.events[s.id] = [e1, schedulerEvent];
  await config.writeJson(path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'), midIndex, { writer: 'epics' });

  // This caller's memory still only knows about e1 plus its own optimistic
  // append e3 (not yet on disk).
  const e3 = { id: 'e3', promptSessionId: s.id, kind: 'prd_created', causedByEventId: 'e2', at: '2026-08-02T13:10:00.000Z', prdSlug: 'x' };
  await mergeActiveIndex(cwd, { sessions: { [s.id]: s }, events: { [s.id]: [e1, e3] } });

  const finalEvents = readActiveIndex(cwd).events[s.id];
  expect(finalEvents.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
});

// Electron's structured-clone IPC transport (unlike JSON.parse) can produce
// an own-enumerable "__proto__" key on a cloned object. A plain-object merge
// target's bracket assignment with that key would re-link its own prototype
// instead of storing a normal entry, silently dropping/corrupting the Epic
// and potentially breaking every later Object.keys/JSON.stringify over it.
test('a "__proto__"-keyed session id merges as an ordinary entry, not a prototype pollution', async () => {
  const cwd = await mkCwd();
  const polluted = session('__proto__', { goalText: 'polluted' });
  // Computed key, not `{ __proto__: polluted }` — the latter is special-cased
  // by object-literal syntax to set the prototype rather than create an own
  // enumerable "__proto__" property, which wouldn't exercise this hazard.
  await mergeActiveIndex(cwd, { sessions: { ['__proto__']: polluted }, events: {} });

  const index = readActiveIndex(cwd);
  expect(Object.prototype.hasOwnProperty.call(index.sessions, '__proto__')).toBe(true);
  expect(index.sessions.__proto__).toEqual(polluted);
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
});

test('falls back to writing memory state alone when the disk index is corrupt JSON', async () => {
  const cwd = await mkCwd();
  const filePath = path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, '{ not valid json', 'utf8');

  const s = session('psess-1');
  await mergeActiveIndex(cwd, { sessions: { [s.id]: s }, events: {} });

  const index = readActiveIndex(cwd);
  expect(index.sessions[s.id]).toEqual(s);
});

// TOCTOU: a mint interleaved with a merge call must survive, since both now
// serialize through the same withPathLock (epicMint.cjs exports it; this
// module requires it via the same module — Node's require cache means one
// lock instance, not two independent maps that could still interleave).
test('mint-during-persist: an ensureEpic mint interleaved with a merge call survives', async () => {
  const cwd = await mkCwd();
  const existing = session('psess-existing');
  await mergeActiveIndex(cwd, { sessions: { [existing.id]: existing }, events: {} });

  const [mintResult] = await Promise.all([
    ensureEpic(cwd, { goalText: 'minted during a concurrent merge', mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI }),
    mergeActiveIndex(cwd, { sessions: { [existing.id]: existing }, events: {} }),
  ]);

  const index = readActiveIndex(cwd);
  expect(index.sessions[mintResult.epicId]).toBeDefined();
  expect(index.sessions[existing.id]).toBeDefined();
});

// The third writer: promptSessionEvents.cjs's appendResponseEventIfKnown
// (the scheduler's narrow 'scheduler'-delegation append) used to hold its
// OWN independent lock map — a merge call and a response-event append could
// still race past each other's stale read. It now imports activeIndexPath/
// withPathLock from epicMint.cjs (same module, same require-cache instance),
// so a response-event append interleaved with a merge call must survive too.
test('a scheduler response-event append interleaved with a merge call survives (third writer shares the same lock)', async () => {
  const cwd = await mkCwd();
  const s = session('psess-1', { status: 'active' });
  await mergeActiveIndex(cwd, {
    sessions: { [s.id]: s },
    events: { [s.id]: [promptEvent('e1', s.id, s.createdAt)] },
  });

  const [, appended] = await Promise.all([
    mergeActiveIndex(cwd, { sessions: { [s.id]: s }, events: { [s.id]: [promptEvent('e1', s.id, s.createdAt)] } }),
    appendResponseEventIfKnown(cwd, s.id, 'PRD finished'),
  ]);

  expect(appended).toBe(true);
  const index = readActiveIndex(cwd);
  expect(index.sessions[s.id]).toBeDefined();
  expect(index.events[s.id]).toHaveLength(2);
  expect(index.events[s.id][1].kind).toBe('response');
});
