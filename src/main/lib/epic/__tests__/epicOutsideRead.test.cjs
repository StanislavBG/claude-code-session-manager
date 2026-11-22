/**
 * epicOutsideRead.test.cjs — the record an outside app reads for one Epic:
 * open Epics from the active index, completed ones from their archive file,
 * lookup by externalRef, and the open-Epic list with its state filter + paging.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicOutsideRead.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listOpenEpicRecords, getEpicRecord } = require('../epicOutsideRead.cjs');
const { recordExternalRef } = require('../externalRefIndex.cjs');

const tmpDirs = [];
let prevHome;

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-outside-read-home-');
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function psDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions');
}

function writeFile(cwd, name, data) {
  fs.mkdirSync(psDir(cwd), { recursive: true });
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(path.join(psDir(cwd), name), body);
}

function session(id, cwd, overrides = {}) {
  return {
    id,
    cwd,
    goalText: `Title ${id}\n\nGoal body for ${id}.`,
    claudeSessionId: `sess-${id}`,
    status: 'active',
    tag: 'feature',
    agentType: 'architect',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(cwd, sessions, events = {}) {
  writeFile(cwd, 'active-index.json', {
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    events,
  });
}

function opts(cwd, extra = {}) {
  return { projectRoots: () => [cwd], ...extra };
}

test('an open Epic record joins session, events, jobs, needs-input and busy', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-1', cwd, {
    source: { producer: 'portfolio', fromCwd: '/elsewhere', fromEpicId: 'e-x', macroId: 'm-1', externalRef: 'ref-1' },
  })], {
    'e-1': [{ kind: 'response', prdSlug: '0001-do-thing', validation: 'verified', at: '2026-11-02T00:00:00.000Z', text: 'ok' }],
  });
  let jobCalls = 0;
  const listJobs = () => {
    jobCalls++;
    return { jobs: [{ epicId: 'e-1', slug: '0001-do-thing', status: 'completed', finishedAt: '2026-11-01T12:00:00.000Z' }] };
  };

  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', listJobs }));
  expect(jobCalls).toBe(1);
  expect(rec).toEqual({
    epicId: 'e-1',
    cwd,
    title: 'Title e-1',
    goal: 'Goal body for e-1.',
    tag: 'feature',
    agentType: 'architect',
    status: 'active',
    state: 'verified',
    blocked: null,
    prds: { total: 1, pending: 0, running: 0, completed: 1, failed: 0, needsReview: 0, quarantined: 0, skipped: 0 },
    verified: ['do-thing'],
    refuted: [],
    unvalidated: [],
    externalRef: 'ref-1',
    source: { producer: 'portfolio', fromCwd: '/elsewhere', fromEpicId: 'e-x', macroId: 'm-1' },
    createdAt: '2026-11-01T00:00:00.000Z',
    completedAt: null,
  });

  // chatBusy flips to working; needsInput from the exchanges log.
  const busy = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', isTabBusy: (id) => id === 'e-1' }));
  expect(busy.state).toBe('working');
  writeFile(cwd, 'exchanges.jsonl', `${JSON.stringify({ ts: '2026-11-03T00:00:00.000Z', sessionId: 'sess-e-1', result: 'hi\n\n[asked: which one?]' })}\n`);
  const asking = await getEpicRecord(cwd, opts(cwd, { id: 'e-1' }));
  expect(asking.state).toBe('needs_input');
  expect(asking.prds.total).toBe(0); // default listJobs = no jobs
});

test('a completed Epic is read from its archive file', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, []);
  writeFile(cwd, 'e-done.json', {
    session: session('e-done', cwd, { status: 'completed', goalText: 'Only a title', completedAt: '2026-11-05T00:00:00.000Z' }),
    events: [{ kind: 'response', prdSlug: '0002-x', validation: 'refuted', at: '2026-11-04T00:00:00.000Z', text: 'VALIDATION — broke it' }],
    archivedAt: '2026-11-05T00:00:01.000Z',
  });
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-done' }));
  expect(rec.epicId).toBe('e-done');
  expect(rec.status).toBe('completed');
  expect(rec.state).toBe('closed');
  expect(rec.title).toBe('Only a title');
  expect(rec.goal).toBeNull();
  expect(rec.refuted).toEqual([{ slug: 'x', reason: 'broke it' }]);
  expect(rec.completedAt).toBe('2026-11-05T00:00:00.000Z');
  expect(rec.externalRef).toBeNull();
  expect(rec.source).toEqual({ producer: null, fromCwd: null, fromEpicId: null, macroId: null });
});

test('a sparse mirror file without archivedAt is ignored', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, []);
  writeFile(cwd, 'e-mirror.json', { id: 'e-mirror', cwd, status: 'active', archivedAt: null, indexedAt: '2026-11-01T00:00:00.000Z' });
  expect(await getEpicRecord(cwd, opts(cwd, { id: 'e-mirror' }))).toBeNull();
  writeFile(cwd, 'e-broken.json', '{not json');
  expect(await getEpicRecord(cwd, opts(cwd, { id: 'e-broken' }))).toBeNull();
  expect(await getEpicRecord(cwd, opts(cwd, { id: 'missing' }))).toBeNull();
  expect(await getEpicRecord(cwd, opts(cwd, { id: '../escape' }))).toBeNull();
  expect(await getEpicRecord(cwd, opts(cwd, {}))).toBeNull();
});

test('an unregistered project yields null and an empty list', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-1', cwd)]);
  const other = { projectRoots: () => ['/not/this/project'] };
  expect(await getEpicRecord(cwd, { ...other, id: 'e-1' })).toBeNull();
  const page = await listOpenEpicRecords(cwd, other);
  expect(page).toEqual({ epics: [], total: 0, limit: 50, offset: 0, hasMore: false });
});

test('lookup by externalRef finds open and completed Epics', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-open', cwd, { source: { producer: 'p', externalRef: 'ref-open' } })]);
  writeFile(cwd, 'e-done.json', {
    session: session('e-done', cwd, { status: 'completed', source: { producer: 'p', externalRef: 'ref-done' } }),
    events: [],
    archivedAt: '2026-11-05T00:00:01.000Z',
  });
  await recordExternalRef({ cwd, externalRef: 'ref-done', epicId: 'e-done', producer: 'p' });

  const open = await getEpicRecord(cwd, opts(cwd, { externalRef: 'ref-open' }));
  expect(open.epicId).toBe('e-open');
  expect(open.externalRef).toBe('ref-open');
  const done = await getEpicRecord(cwd, opts(cwd, { externalRef: 'ref-done' }));
  expect(done.epicId).toBe('e-done');
  expect(done.state).toBe('closed');
  expect(await getEpicRecord(cwd, opts(cwd, { externalRef: 'nope' }))).toBeNull();
});

test('list: open Epics only, newest first, state filter, paging, one read per call', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    sessions.push(session(`e-${i}`, cwd, {
      status: i % 2 === 0 ? 'active' : 'proposed',
      createdAt: `2026-11-0${i + 1}T00:00:00.000Z`,
    }));
  }
  sessions.push(session('e-closed', cwd, { status: 'completed', createdAt: '2026-11-09T00:00:00.000Z' }));
  setup(cwd, sessions);
  let jobCalls = 0;
  const listJobs = () => { jobCalls++; return [{ epicId: 'e-4', slug: '0009-run', status: 'running' }]; };

  const all = await listOpenEpicRecords(cwd, opts(cwd, { listJobs }));
  expect(jobCalls).toBe(1);
  expect(all.total).toBe(5);
  expect(all.hasMore).toBe(false);
  expect(all.epics.map((e) => e.epicId)).toEqual(['e-4', 'e-3', 'e-2', 'e-1', 'e-0']);
  expect(all.epics[0].state).toBe('working');

  const waiting = await listOpenEpicRecords(cwd, opts(cwd, { listJobs, state: 'awaiting_approval' }));
  expect(waiting.epics.map((e) => e.epicId)).toEqual(['e-3', 'e-1']);
  expect(waiting.total).toBe(2);

  const page = await listOpenEpicRecords(cwd, opts(cwd, { limit: 2, offset: 1 }));
  expect(page.epics.map((e) => e.epicId)).toEqual(['e-3', 'e-2']);
  expect(page).toMatchObject({ total: 5, limit: 2, offset: 1, hasMore: true });

  const capped = await listOpenEpicRecords(cwd, opts(cwd, { limit: 10000 }));
  expect(capped.limit).toBe(200);
});
