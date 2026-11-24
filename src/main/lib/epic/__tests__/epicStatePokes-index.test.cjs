/**
 * epicStatePokes-index.test.cjs — the two active-index.json write sites that
 * write no event-log kind the emitter listens for poke epicStateEmitter:
 *   - promptSessionEvents.appendResponseEventWithReason (verdicts, check-ins)
 *   - activeIndexMerge.mergeActiveIndex removedIds (a deleted open Epic)
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/epicStatePokes-index.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const emitter = require('../epicStateEmitter.cjs');
const log = require('../epicEventLog.cjs');
const { activeIndexPath } = require('../epicMint.cjs');
const { appendResponseEventWithReason } = require('../../../promptSessionEvents.cjs');
const { mergeActiveIndex } = require('../activeIndexMerge.cjs');
const { readEventsAfter, _resetEpicStateCacheForTests } = require('../../telemetry/auditEvents.cjs');

const tmpDirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  emitter._resetForTests();
  log._resetForTests();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  // Under homedir so config.cjs's read boundary (validatePath) passes.
  const cwd = await fsp.mkdtemp(path.join(os.homedir(), '.sm-test-state-pokes-'));
  tmpDirs.push(cwd);
  config.addAllowedRoot(path.resolve(cwd));
  return cwd;
}

function session(id, cwd, overrides = {}) {
  return {
    id,
    cwd,
    goalText: `goal for ${id}`,
    claudeSessionId: `claude-${id}`,
    status: 'active',
    tag: 'feature',
    agentType: 'architect',
    createdAt: '2026-11-01T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function writeIndex(cwd, index) {
  const p = activeIndexPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(index, null, 2));
}

const seedEvent = (id) => ({ id: `evt-${id}-0`, promptSessionId: id, kind: 'prompt', at: '2026-11-01T00:00:00.000Z', text: 'go' });

/** Let fire-and-forget microtasks settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

test('appendResponseEventWithReason pokes once per successful append, never on a refused append', async () => {
  const cwd = await mkCwd();
  const a = session('psess-a', cwd);
  const done = session('psess-done', cwd, { status: 'completed' });
  writeIndex(cwd, {
    sessions: { [a.id]: a, [done.id]: done },
    events: { [a.id]: [seedEvent(a.id)], [done.id]: [seedEvent(done.id)] },
  });
  const poke = vi.spyOn(emitter, 'pokeEpicState').mockImplementation(() => {});

  expect(await appendResponseEventWithReason(cwd, a.id, 'one', { prdSlug: '0001-x' })).toEqual({ ok: true });
  expect(poke).toHaveBeenCalledTimes(1);
  expect(poke).toHaveBeenLastCalledWith(cwd, a.id);

  expect(await appendResponseEventWithReason(cwd, a.id, 'two')).toEqual({ ok: true });
  expect(poke).toHaveBeenCalledTimes(2);

  expect(await appendResponseEventWithReason(cwd, 'psess-nope', 'x')).toEqual({ ok: false, reason: 'no-session' });
  expect(await appendResponseEventWithReason(cwd, done.id, 'x')).toEqual({ ok: false, reason: 'not-active' });
  expect(poke).toHaveBeenCalledTimes(2);
});

test('a throwing pokeEpicState cannot change the append result', async () => {
  const cwd = await mkCwd();
  const a = session('psess-a', cwd);
  writeIndex(cwd, { sessions: { [a.id]: a }, events: { [a.id]: [seedEvent(a.id)] } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(emitter, 'pokeEpicState').mockImplementation(() => { throw new Error('boom'); });
  expect(await appendResponseEventWithReason(cwd, a.id, 'one')).toEqual({ ok: true });
});

test('mergeActiveIndex pokes once per removed id after the write', async () => {
  const cwd = await mkCwd();
  const a = session('psess-a', cwd);
  const b = session('psess-b', cwd);
  const c = session('psess-c', cwd);
  const stopPreview = vi.fn();
  const poke = vi.spyOn(emitter, 'pokeEpicState').mockImplementation(() => {});
  await mergeActiveIndex(cwd, { sessions: { [a.id]: a, [b.id]: b, [c.id]: c } }, { stopPreview });
  await flush();
  expect(poke).not.toHaveBeenCalled();

  await mergeActiveIndex(cwd, { sessions: { [c.id]: c }, removedIds: [a.id, b.id] }, { stopPreview });
  await flush();
  expect(poke).toHaveBeenCalledTimes(2);
  expect(poke).toHaveBeenCalledWith(cwd, a.id);
  expect(poke).toHaveBeenCalledWith(cwd, b.id);
});

test('mergeActiveIndex does not poke when the write fails', async () => {
  const cwd = await mkCwd();
  fs.mkdirSync(activeIndexPath(cwd), { recursive: true });
  fs.writeFileSync(path.join(activeIndexPath(cwd), 'blocker'), 'x');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const poke = vi.spyOn(emitter, 'pokeEpicState').mockImplementation(() => {});
  await expect(
    mergeActiveIndex(cwd, { sessions: {}, removedIds: ['psess-a'] }, { stopPreview: vi.fn() }),
  ).rejects.toThrow();
  await flush();
  expect(poke).not.toHaveBeenCalled();
});

test('end to end: a verified verdict appended to the chain yields epic.state_changed to verified', async () => {
  const cwd = await mkCwd();
  const id = 'psess-e2e';
  const s = session(id, cwd, { prds: ['0001-work'] });
  writeIndex(cwd, { sessions: { [id]: s }, events: { [id]: [seedEvent(id)] } });
  const jobs = [{ epicId: id, slug: '0001-work', status: 'completed', finishedAt: '2026-11-02T00:00:00.000Z' }];
  emitter.configureEpicStateEmitter({
    debounceMs: 0,
    listJobs: () => jobs,
    isTabBusy: () => false,
    projectRoots: () => [cwd],
  });

  const res = await appendResponseEventWithReason(cwd, id, 'VERIFIED', { prdSlug: '0001-work', validation: 'verified' });
  expect(res).toEqual({ ok: true });
  await emitter._settleForTests();

  const rows = (await log.readEpicEvents(cwd, id, { kinds: ['epic.state_changed'], limit: 100 })).events;
  expect(rows.map((r) => r.to)).toEqual(['verified']);

  // …and the same row reads back through the outside-event reader.
  const appended = JSON.parse(fs.readFileSync(activeIndexPath(cwd), 'utf8')).events[id].at(-1);
  expect(appended.kind).toBe('response');
  const auditLog = path.join(cwd, 'audit-log.jsonl');
  fs.writeFileSync(auditLog, '');
  _resetEpicStateCacheForTests();
  const out = readEventsAfter({ after: 'start', kinds: ['epic_state_changed'], target: auditLog, projectRoots: () => [cwd] });
  const mine = out.events.filter((e) => e.epicId === id);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ kind: 'epic_state_changed', to: 'verified', cwd: path.resolve(cwd), epicId: id });
  expect(Math.abs(Date.parse(mine[0].at) - Date.parse(appended.at))).toBeLessThanOrEqual(60_000);
});
