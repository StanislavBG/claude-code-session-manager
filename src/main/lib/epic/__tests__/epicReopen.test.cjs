/**
 * epicReopen.test.cjs — reopenEpic flips a completed Epic back to active in place.
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicReopen.test.cjs
 */
'use strict';

import { test, expect, afterEach, beforeEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reopenEpic } = require('../epicReopen.cjs');
const { activeIndexPath } = require('../epicMint.cjs');
const { epicMirrorPath } = require('../epicStatusMirror.cjs');
const { __resetCacheForTests } = require('../epicTranscriptPath.cjs');
const { encodeCwd } = require('../../util/encodeCwd.cjs');

const tmpDirs = [];
beforeEach(() => __resetCacheForTests());
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

const EPIC = 'epic-1';
const SID = 'sid-abc';

async function setup({ worktree, withTranscript = true, indexStatus } = {}) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-reopen-cwd-'));
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-reopen-home-'));
  tmpDirs.push(cwd, homeDir);
  const session = { id: EPIC, cwd, claudeSessionId: SID, status: 'completed', completedAt: 'x', tag: 't', agentType: 'a', ...(worktree ? { worktree } : {}) };
  const events = [{ id: 'e1' }, { id: 'e2' }];
  fs.mkdirSync(path.dirname(activeIndexPath(cwd)), { recursive: true });
  const index = {
    sessions: { other: { id: 'other', status: 'active' }, ...(indexStatus ? { [EPIC]: { id: EPIC, status: indexStatus } } : {}) },
    events: { other: [{ id: 'o1' }] },
    tombstones: { [EPIC]: 'iso', keep: 'iso2' },
  };
  fs.writeFileSync(activeIndexPath(cwd), JSON.stringify(index));
  fs.writeFileSync(epicMirrorPath(cwd, EPIC), JSON.stringify({ session, events, status: 'completed', archivedAt: 'z', transcriptRef: 'r' }));
  if (withTranscript) {
    const f = path.join(homeDir, '.claude', 'projects', encodeCwd(cwd), `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"a":1}\n');
  }
  return { cwd, homeDir };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('happy path reopens in place', async () => {
  const { cwd, homeDir } = await setup();
  const r = await reopenEpic({ cwd, epicId: EPIC, deps: { homeDir, createWorktree: async () => null } });
  expect(r.ok).toBe(true);
  expect(r.alreadyOpen).toBe(false);
  const idx = readJson(activeIndexPath(cwd));
  expect(idx.sessions[EPIC]).toMatchObject({ id: EPIC, claudeSessionId: SID, status: 'active', completedAt: null });
  expect(idx.events[EPIC]).toEqual([{ id: 'e1' }, { id: 'e2' }]);
  expect(idx.tombstones[EPIC]).toBeUndefined();
  expect(idx.tombstones.keep).toBe('iso2');
  expect(idx.sessions.other.status).toBe('active');
  expect(idx.events.other).toEqual([{ id: 'o1' }]);
  const m = readJson(epicMirrorPath(cwd, EPIC));
  expect(m).toMatchObject({ id: EPIC, status: 'active', archivedAt: null, claudeSessionId: SID });
  for (const k of ['session', 'events', 'transcriptRef']) expect(m).not.toHaveProperty(k);
});

test('merged worktree mints a new one', async () => {
  const { cwd, homeDir } = await setup({ worktree: { dir: '/gone', branch: 'sm-epic/epic-1', baseCwd: '/b', status: 'merged' } });
  const fresh = { dir: cwd, branch: 'sm-epic/epic-1', baseCwd: cwd, status: 'active' };
  let calls = 0;
  const r = await reopenEpic({ cwd, epicId: EPIC, deps: { homeDir, createWorktree: async () => { calls++; return fresh; } } });
  expect(r.ok).toBe(true);
  expect(calls).toBe(1);
  expect(readJson(activeIndexPath(cwd)).sessions[EPIC].worktree).toEqual(fresh);
});

test('needs_merge_resolution with existing dir is reused', async () => {
  const { cwd, homeDir } = await setup();
  const wtDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-reopen-wt-'));
  tmpDirs.push(wtDir);
  const wt = { dir: wtDir, branch: 'sm-epic/epic-1', baseCwd: cwd, status: 'needs_merge_resolution' };
  const m = readJson(epicMirrorPath(cwd, EPIC));
  m.session.worktree = wt;
  fs.writeFileSync(epicMirrorPath(cwd, EPIC), JSON.stringify(m));
  let calls = 0;
  const r = await reopenEpic({ cwd, epicId: EPIC, deps: { homeDir, createWorktree: async () => { calls++; return null; }, restoreWorktree: () => { calls++; return false; } } });
  expect(r.ok).toBe(true);
  expect(calls).toBe(0);
  expect(readJson(activeIndexPath(cwd)).sessions[EPIC].worktree).toEqual({ ...wt, status: 'active' });
});

test('missing transcript leaves files byte-identical', async () => {
  const { cwd, homeDir } = await setup({ withTranscript: false });
  const a = fs.readFileSync(activeIndexPath(cwd), 'utf8');
  const b = fs.readFileSync(epicMirrorPath(cwd, EPIC), 'utf8');
  const r = await reopenEpic({ cwd, epicId: EPIC, deps: { homeDir, createWorktree: async () => null } });
  expect(r).toMatchObject({ ok: false, code: 'transcript_missing' });
  expect(fs.readFileSync(activeIndexPath(cwd), 'utf8')).toBe(a);
  expect(fs.readFileSync(epicMirrorPath(cwd, EPIC), 'utf8')).toBe(b);
});

test('already active returns alreadyOpen without writes', async () => {
  const { cwd, homeDir } = await setup({ indexStatus: 'active' });
  const a = fs.readFileSync(activeIndexPath(cwd), 'utf8');
  const b = fs.readFileSync(epicMirrorPath(cwd, EPIC), 'utf8');
  const r = await reopenEpic({ cwd, epicId: EPIC, deps: { homeDir } });
  expect(r).toMatchObject({ ok: true, alreadyOpen: true });
  expect(fs.readFileSync(activeIndexPath(cwd), 'utf8')).toBe(a);
  expect(fs.readFileSync(epicMirrorPath(cwd, EPIC), 'utf8')).toBe(b);
});

test('concurrent calls share one in-flight promise', async () => {
  const { cwd, homeDir } = await setup();
  let calls = 0;
  const deps = { homeDir, createWorktree: async () => { calls++; return null; } };
  const [x, y] = await Promise.all([reopenEpic({ cwd, epicId: EPIC, deps }), reopenEpic({ cwd, epicId: EPIC, deps })]);
  expect(x.ok && y.ok).toBe(true);
  expect(calls).toBe(1);
});
