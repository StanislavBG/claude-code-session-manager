/**
 * epicOutsideRead.test.cjs — the record an outside app reads for one Epic:
 * open Epics from the active index, completed ones from their archive file,
 * lookup by externalRef, and the open-Epic list with its state filter + paging.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicOutsideRead.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listOpenEpicRecords, getEpicRecord, findEpicProject, readEpicFixes, _setFixesCapsForTests, _fixesCacheSizeForTests } = require('../epicOutsideRead.cjs');
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
    phase: 'idle',
    blocked: null,
    prds: { total: 1, pending: 0, running: 0, completed: 1, failed: 0, needsReview: 0, quarantined: 0, skipped: 0, cancelled: 0 },
    verified: ['do-thing'],
    refuted: [],
    unvalidated: [],
    externalRef: 'ref-1',
    source: { producer: 'portfolio', fromCwd: '/elsewhere', fromEpicId: 'e-x', macroId: 'm-1', startedBy: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    completedAt: null,
    verdicts: [],
    planReviews: [],
    planReviewStats: {
      reviewed: { plans: 0, acceptedFindings: 0, rejectedFindings: 0, validatorFindings: 0, refuted: 0, escapes: 0 },
      unreviewed: { plans: 0, validatorFindings: 0, refuted: 0, escapes: 0 },
    },
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
  expect(rec.source).toEqual({ producer: null, fromCwd: null, fromEpicId: null, macroId: null, startedBy: null });
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

test('an unregistered project: an archive lookup yields null; open reads skip the registration scan', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-1', cwd)]);
  writeFile(cwd, 'e-done.json', {
    session: session('e-done', cwd, { status: 'completed' }),
    events: [],
    archivedAt: '2026-11-05T00:00:01.000Z',
  });
  const other = { projectRoots: () => ['/not/this/project'] };
  expect(await getEpicRecord(cwd, { ...other, id: 'e-done' })).toBeNull();
  expect(await getEpicRecord(cwd, { ...other, id: 'e-missing' })).toBeNull();
  expect((await getEpicRecord(cwd, { ...other, id: 'e-1' })).epicId).toBe('e-1');
  const page = await listOpenEpicRecords(cwd, other);
  expect(page.epics.map((r) => r.epicId)).toEqual(['e-1']);
});

test('projectRoots is never called for open Epics; it is for a completed one', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-open', cwd, { source: { producer: 'p', externalRef: 'ref-open' } })]);
  writeFile(cwd, 'e-done.json', {
    session: session('e-done', cwd, { status: 'completed' }),
    events: [],
    archivedAt: '2026-11-05T00:00:01.000Z',
  });
  await recordExternalRef({ cwd, externalRef: 'ref-open', epicId: 'e-open', producer: 'p' });
  let calls = 0;
  const projectRoots = () => { calls++; return [cwd]; };

  expect((await getEpicRecord(cwd, { projectRoots, id: 'e-open' })).epicId).toBe('e-open');
  expect(calls).toBe(0);
  expect((await getEpicRecord(cwd, { projectRoots, externalRef: 'ref-open' })).epicId).toBe('e-open');
  expect(calls).toBe(0);
  expect((await listOpenEpicRecords(cwd, { projectRoots })).total).toBe(1);
  expect(calls).toBe(0);

  expect((await getEpicRecord(cwd, { projectRoots, id: 'e-done' })).state).toBe('closed');
  expect(calls).toBeGreaterThanOrEqual(1);
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

// ── receipt (opt-in) ────────────────────────────────────────────────────────

const ZERO_JOBS = { runs: 0, costUsd: 0, costKnownRuns: 0, outputTokens: 0, numTurns: 0, durationMs: 0, byPrd: [] };

function writeMeta(runsRoot, runId, slug, meta) {
  fs.mkdirSync(path.join(runsRoot, runId), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, runId, `${slug}.meta.json`), JSON.stringify(meta));
}

function writeTranscript(dir, id) {
  const p = path.join(dir, `${id}.jsonl`);
  const rows = [
    { type: 'user', message: { role: 'user', content: 'hello there!' } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 } } },
  ];
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

test('receipt: absent by default and nothing is read for it', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-1', cwd)]);
  let resolverCalls = 0;
  const resolveTranscriptPath = () => { resolverCalls++; return { path: null, candidates: [], existsAnywhere: false, existingPaths: [] }; };
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', resolveTranscriptPath, runsRoot: '/nonexistent' }));
  expect(rec).not.toHaveProperty('receipt');
  expect(resolverCalls).toBe(0);
  const off = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', receipt: false, resolveTranscriptPath }));
  expect(off).not.toHaveProperty('receipt');
  expect(resolverCalls).toBe(0);
});

test('receipt: jobs from run metadata since createdAt, chat from the transcript', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const runsRoot = await mkTmp('sm-outside-read-runs-');
  const tdir = await mkTmp('sm-outside-read-tx-');
  setup(cwd, [session('e-1', cwd)]);
  const tpath = writeTranscript(tdir, 'sess-e-1');
  writeMeta(runsRoot, '2026-11-02T00-00-00-000Z', '0001-do-thing', { cwd, totalCostUsd: 1.5, outputTokens: 100, numTurns: 3, durationMs: 1000, exitCode: 0, finishedAt: 1 });
  writeMeta(runsRoot, '2026-11-03T00-00-00-000Z', '0001-do-thing', { cwd, totalCostUsd: 0.5, outputTokens: 50, numTurns: 2, durationMs: 500, exitCode: 0, finishedAt: 2 });
  // before createdAt → excluded; another Epic's slug → excluded
  writeMeta(runsRoot, '2026-10-01T00-00-00-000Z', '0001-do-thing', { cwd, totalCostUsd: 99 });
  writeMeta(runsRoot, '2026-11-02T00-00-00-000Z', '0099-other', { cwd, totalCostUsd: 99 });
  const listJobs = () => [
    { epicId: 'e-1', slug: '0001-do-thing', status: 'completed' },
    { epicId: 'e-other', slug: '0099-other', status: 'completed' },
  ];
  const seen = [];
  const resolveTranscriptPath = (a) => { seen.push(a); return { path: tpath, candidates: [tpath], existsAnywhere: true, existingPaths: [tpath] }; };

  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', receipt: true, listJobs, runsRoot, resolveTranscriptPath }));
  expect(seen).toEqual([{ cwd, claudeSessionId: 'sess-e-1' }]);
  expect(rec.receipt.jobs).toEqual({
    runs: 2, costUsd: 2, costKnownRuns: 2, outputTokens: 150, numTurns: 5, durationMs: 1500,
    byPrd: [{ slug: '0001-do-thing', runs: 2, costUsd: 2, lastExitCode: 0, lastFinishedAt: 2 }],
  });
  expect(rec.receipt.chat).toMatchObject({ calls: 1, inputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 20, outputTokens: 7, largestContext: 35, models: { 'claude-x': 1 } });
  const { receipt: _r, ...rest } = rec;
  expect(rest).toEqual(await getEpicRecord(cwd, opts(cwd, { id: 'e-1', listJobs })));
});

test('receipt: no transcript gives chat null, no jobs gives the zero result, failures null only that part', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const runsRoot = await mkTmp('sm-outside-read-runs-');
  setup(cwd, [session('e-1', cwd)]);
  const missing = { path: null, candidates: [], existsAnywhere: false, existingPaths: [] };
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', receipt: true, runsRoot, resolveTranscriptPath: () => missing }));
  expect(rec.receipt).toEqual({ jobs: ZERO_JOBS, chat: null });

  // the real resolver returns its first candidate even when no file exists
  const ghost = { path: '/no/such/file.jsonl', candidates: ['/no/such/file.jsonl'], existsAnywhere: false, existingPaths: [] };
  const rec2 = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', receipt: true, runsRoot, resolveTranscriptPath: () => ghost }));
  expect(rec2.receipt.chat).toBeNull();

  const rec3 = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', receipt: true, runsRoot, resolveTranscriptPath: () => { throw new Error('boom'); } }));
  expect(rec3.epicId).toBe('e-1');
  expect(rec3.receipt).toEqual({ jobs: ZERO_JOBS, chat: null });
});

test('receipt: a completed Epic read from the archive gets one too', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const runsRoot = await mkTmp('sm-outside-read-runs-');
  const tdir = await mkTmp('sm-outside-read-tx-');
  setup(cwd, []);
  writeFile(cwd, 'e-done.json', {
    session: session('e-done', cwd, { status: 'completed', createdAt: '2026-11-01T00:00:00.000Z' }),
    events: [],
    archivedAt: '2026-11-05T00:00:01.000Z',
  });
  const tpath = writeTranscript(tdir, 'sess-e-done');
  writeMeta(runsRoot, '2026-11-02T00-00-00-000Z', '0002-x', { cwd, totalCostUsd: 0.25, exitCode: 1, finishedAt: 5 });
  const listJobs = () => [{ sourcePromptId: 'e-done', slug: '0002-x', status: 'failed' }];
  const seen = [];
  const resolveTranscriptPath = (a) => { seen.push(a); return { path: tpath, candidates: [tpath], existsAnywhere: true, existingPaths: [tpath] }; };

  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-done', receipt: true, listJobs, runsRoot, resolveTranscriptPath }));
  expect(rec.state).toBe('closed');
  expect(seen).toEqual([{ cwd, claudeSessionId: 'sess-e-done' }]);
  expect(rec.receipt.jobs).toMatchObject({ runs: 1, costUsd: 0.25, byPrd: [{ slug: '0002-x', runs: 1, costUsd: 0.25, lastExitCode: 1, lastFinishedAt: 5 }] });
  expect(rec.receipt.chat).toMatchObject({ calls: 1, outputTokens: 7 });
});

test('receipt: listOpenEpicRecords never computes one', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-1', cwd)]);
  let resolverCalls = 0;
  const resolveTranscriptPath = () => { resolverCalls++; return { path: null, candidates: [], existsAnywhere: false, existingPaths: [] }; };
  const page = await listOpenEpicRecords(cwd, opts(cwd, { receipt: true, resolveTranscriptPath }));
  expect(page.epics).toHaveLength(1);
  expect(page.epics[0]).not.toHaveProperty('receipt');
  expect(resolverCalls).toBe(0);
});

// ── receipt: finished PRDs (no live rows) come from check-in events ─────────

const checkin = (prdSlug, at) => ({ kind: 'response', prdSlug, validation: 'unvalidated', outcome: 'completed', at });

test('receipt: an open Epic with no live rows sums the runs of its checked-in PRDs', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const runsRoot = await mkTmp('sm-outside-read-runs-');
  setup(cwd, [session('e-1', cwd)], {
    'e-1': [checkin('0001-a', '2026-11-02T01:00:00.000Z'), checkin('0002-b', '2026-11-03T01:00:00.000Z')],
  });
  writeMeta(runsRoot, '2026-11-02T00-00-00-000Z', '0001-a', { cwd, totalCostUsd: 1.25, exitCode: 0, finishedAt: 1 });
  writeMeta(runsRoot, '2026-11-03T00-00-00-000Z', '0002-b', { cwd, totalCostUsd: 0.5, exitCode: 0, finishedAt: 2 });
  writeMeta(runsRoot, '2026-11-03T00-00-00-000Z', '0099-other', { cwd, totalCostUsd: 99 });
  const missing = { path: null, candidates: [], existsAnywhere: false, existingPaths: [] };

  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-1', receipt: true, listJobs: () => [], runsRoot, resolveTranscriptPath: () => missing }));
  expect(rec.receipt.jobs.runs).toBe(2);
  expect(rec.receipt.jobs.costUsd).toBeCloseTo(1.75, 10);
  expect(rec.receipt.jobs.byPrd.map((p) => p.slug).sort()).toEqual(['0001-a', '0002-b']);
});

test('receipt: a completed Epic from the archive sums the runs of its archived check-ins', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const runsRoot = await mkTmp('sm-outside-read-runs-');
  setup(cwd, []);
  writeFile(cwd, 'e-done.json', {
    session: session('e-done', cwd, { status: 'completed' }),
    events: [checkin('0003-c', '2026-11-02T01:00:00.000Z'), checkin('0004-d', '2026-11-03T01:00:00.000Z')],
    archivedAt: '2026-11-05T00:00:01.000Z',
  });
  writeMeta(runsRoot, '2026-11-02T00-00-00-000Z', '0003-c', { cwd, totalCostUsd: 0.75, exitCode: 0, finishedAt: 1 });
  writeMeta(runsRoot, '2026-11-03T00-00-00-000Z', '0004-d', { cwd, totalCostUsd: 2, exitCode: 0, finishedAt: 2 });
  const missing = { path: null, candidates: [], existsAnywhere: false, existingPaths: [] };

  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-done', receipt: true, runsRoot, resolveTranscriptPath: () => missing }));
  expect(rec.state).toBe('closed');
  expect(rec.receipt.jobs.runs).toBe(2);
  expect(rec.receipt.jobs.costUsd).toBeCloseTo(2.75, 10);
  expect(rec.receipt.jobs.byPrd.map((p) => p.slug).sort()).toEqual(['0003-c', '0004-d']);
});

// ── findEpicProject: which registered project holds an Epic id ───────────────

test('findEpicProject: one registered project holds the open Epic → { cwd }', async () => {
  const a = await mkTmp('sm-outside-find-a-');
  const b = await mkTmp('sm-outside-find-b-');
  setup(a, [session('e-1', a)]);
  setup(b, [session('e-2', b)]);
  expect(findEpicProject('e-1', { projectRoots: () => [a, b] })).toEqual({ cwd: a });
  expect(findEpicProject('e-2', { projectRoots: () => [a, b, b] })).toEqual({ cwd: b });
});

test('findEpicProject: no registered project holds it → null (also for an unregistered holder)', async () => {
  const a = await mkTmp('sm-outside-find-a-');
  const unregistered = await mkTmp('sm-outside-find-u-');
  setup(a, [session('e-1', a)]);
  setup(unregistered, [session('e-hidden', unregistered)]);
  expect(findEpicProject('e-missing', { projectRoots: () => [a] })).toBeNull();
  expect(findEpicProject('e-hidden', { projectRoots: () => [a] })).toBeNull();
  // A completed-status row lingering in the index without an archive is not a match.
  setup(a, [session('e-old', a, { status: 'completed' })]);
  expect(findEpicProject('e-old', { projectRoots: () => [a] })).toBeNull();
});

test('findEpicProject: several projects hold the id → { ambiguous }', async () => {
  const a = await mkTmp('sm-outside-find-a-');
  const b = await mkTmp('sm-outside-find-b-');
  setup(a, [session('e-dup', a)]);
  setup(b, []);
  writeFile(b, 'e-dup.json', { session: session('e-dup', b, { status: 'completed' }), events: [], archivedAt: '2026-11-05T00:00:01.000Z' });
  const res = findEpicProject('e-dup', { projectRoots: () => [b, a] });
  expect(res).toEqual({ ambiguous: [a, b].sort() });
});

test('findEpicProject: an archived (completed) Epic is found by its archive file', async () => {
  const a = await mkTmp('sm-outside-find-a-');
  const b = await mkTmp('sm-outside-find-b-');
  setup(a, []);
  setup(b, []);
  writeFile(b, 'e-done.json', { session: session('e-done', b, { status: 'completed' }), events: [], archivedAt: '2026-11-05T00:00:01.000Z' });
  writeFile(a, 'e-mirror.json', { id: 'e-mirror', cwd: a, status: 'active', archivedAt: null });
  expect(findEpicProject('e-done', { projectRoots: () => [a, b] })).toEqual({ cwd: b });
  expect(findEpicProject('e-mirror', { projectRoots: () => [a, b] })).toBeNull();
});

test('findEpicProject: an unsafe id is refused before projectRoots is consulted; it never throws', async () => {
  let calls = 0;
  const projectRoots = () => { calls++; return []; };
  for (const bad of ['', '../escape', 'a/b', 'a\\b', '..', null, undefined, 42]) {
    expect(findEpicProject(bad, { projectRoots })).toBeNull();
  }
  expect(calls).toBe(0);
  expect(findEpicProject('e-1', { projectRoots: () => { throw new Error('boom'); } })).toBeNull();
  expect(findEpicProject('e-1', { projectRoots: () => [null, 'relative/path', 7] })).toBeNull();
});

// ── verdicts from plan-records/<epic>/*.verdicts.json ───────────────────────

function verdictDir(cwd, epicId) {
  return path.join(cwd, 'session-manager-operations', 'plan-records', epicId);
}

function writeVerdictFile(cwd, epicId, name, body) {
  fs.mkdirSync(verdictDir(cwd, epicId), { recursive: true });
  fs.writeFileSync(path.join(verdictDir(cwd, epicId), name), typeof body === 'string' ? body : JSON.stringify(body));
}

const crit = (met, missKind) => ({ id: '1', met, evidence: 'checked', ...(missKind ? { missKind } : {}) });
const entry = (prd, verdict, reason = '') => ({
  prd,
  verdict,
  reason,
  criteria: [verdict === 'REFUTED' ? crit(false, 'missing-test') : crit(true)],
  findings: [],
});
const file = (validator, at, verdicts) => ({ validator, runId: `run-${validator}`, at, schedulerVerdict: 'PASS', verdicts });

test('verdicts: two validator files, the newer wins per PRD, sorted by prd', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-v', cwd)]);
  writeVerdictFile(cwd, 'e-v', 'validate-a.verdicts.json', file('validate-a', '2026-11-02T00:00:00.000Z', [
    entry('0002-zeta', 'REFUTED', 'no test'),
    entry('0001-alpha', 'VERIFIED'),
  ]));
  writeVerdictFile(cwd, 'e-v', 'validate-b.verdicts.json', file('validate-b', '2026-11-03T00:00:00.000Z', [
    entry('0003-zeta', 'VERIFIED'),
  ]));
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-v' }));
  expect(rec.verdicts).toEqual([
    { prd: 'alpha', verdict: 'VERIFIED', reason: '', criteria: [crit(true)], findings: [], validator: 'validate-a', at: '2026-11-02T00:00:00.000Z' },
    { prd: 'zeta', verdict: 'VERIFIED', reason: '', criteria: [crit(true)], findings: [], validator: 'validate-b', at: '2026-11-03T00:00:00.000Z' },
  ]);
});

test('verdicts: an older file read later does not override the newer one', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-v', cwd)]);
  writeVerdictFile(cwd, 'e-v', 'a.verdicts.json', file('a', '2026-11-05T00:00:00.000Z', [entry('1-x', 'REFUTED', 'bad')]));
  writeVerdictFile(cwd, 'e-v', 'b.verdicts.json', file('b', '2026-11-01T00:00:00.000Z', [entry('1-x', 'VERIFIED')]));
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-v' }));
  expect(rec.verdicts.map((v) => [v.prd, v.verdict, v.reason, v.validator])).toEqual([['x', 'REFUTED', 'bad', 'a']]);
});

test('verdicts: an invalid or unreadable file is skipped', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-v', cwd)]);
  writeVerdictFile(cwd, 'e-v', 'good.verdicts.json', file('good', '2026-11-02T00:00:00.000Z', [entry('1-a', 'VERIFIED')]));
  // REFUTED with an empty reason fails parseValidatorVerdict.
  writeVerdictFile(cwd, 'e-v', 'bad.verdicts.json', file('bad', '2026-11-09T00:00:00.000Z', [entry('1-a', 'REFUTED', '')]));
  writeVerdictFile(cwd, 'e-v', 'broken.verdicts.json', '{ not json');
  writeVerdictFile(cwd, 'e-v', 'array.verdicts.json', '[]');
  writeVerdictFile(cwd, 'e-v', 'notes.md', '## 1-a REFUTED');
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-v' }));
  expect(rec.verdicts.map((v) => [v.prd, v.verdict, v.validator])).toEqual([['a', 'VERIFIED', 'good']]);
});

test('verdicts: a missing folder gives []; an Epic with no files gives []', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-none', cwd), session('e-empty', cwd)]);
  fs.mkdirSync(verdictDir(cwd, 'e-empty'), { recursive: true });
  expect((await getEpicRecord(cwd, opts(cwd, { id: 'e-none' }))).verdicts).toEqual([]);
  expect((await getEpicRecord(cwd, opts(cwd, { id: 'e-empty' }))).verdicts).toEqual([]);
});

test('verdicts: a completed Epic from the archive reads them too', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  writeFile(cwd, 'e-done.json', {
    archivedAt: '2026-11-04T00:00:00.000Z',
    session: session('e-done', cwd, { status: 'completed', completedAt: '2026-11-04T00:00:00.000Z' }),
    events: [],
  });
  writeVerdictFile(cwd, 'e-done', 'v.verdicts.json', file('v', '2026-11-03T00:00:00.000Z', [entry('7-done', 'VERIFIED')]));
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-done' }));
  expect(rec.verdicts.map((v) => v.prd)).toEqual(['done']);
});

test('source.startedBy: valid is returned, absent and malformed read as null', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const good = { kind: 'script', route: '/admin/project-home/videos/run', caller: { pipeline: 'blog', attempt: 1 }, fromEpicId: 'e-x' };
  setup(cwd, [
    session('sb-1', cwd, { source: { producer: 'new-epic-ui', startedBy: good } }),
    session('sb-2', cwd, { source: { producer: 'new-epic-ui' } }),
    session('sb-3', cwd, { source: { producer: 'new-epic-ui', startedBy: { kind: 'script', route: '' , bogus: 1 } } }),
  ]);
  const listJobs = () => ({ jobs: [] });
  const get = (id) => getEpicRecord(cwd, opts(cwd, { id, listJobs }));
  expect((await get('sb-1')).source.startedBy).toEqual(good);
  expect((await get('sb-2')).source.startedBy).toBeNull();
  expect((await get('sb-3')).source.startedBy).toBeNull();
});

test('planReviews: populated from plan-records/<epic>/*.plan-review.json, [] when none', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-pr', cwd), session('e-nopr', cwd)]);
  const rec0 = { epicId: 'e-pr', validateSlug: 'validate-x', round: 1, reviews: [{ runId: 'r1' }], release: null };
  writeVerdictFile(cwd, 'e-pr', 'validate-x.plan-review.json', rec0);
  writeVerdictFile(cwd, 'e-pr', 'broken.plan-review.json', '{ nope');
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-pr' }));
  expect(rec.planReviews).toEqual([rec0]);
  expect((await getEpicRecord(cwd, opts(cwd, { id: 'e-nopr' }))).planReviews).toEqual([]);
});

test('planReviewStats: unreviewed plans and escapes from verdict files + PRD fixes', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  setup(cwd, [session('e-st', cwd)]);
  writeVerdictFile(cwd, 'e-st', 'validate-s.verdicts.json', file('validate-s', '2026-11-02T00:00:00.000Z', [
    entry('1-alpha', 'REFUTED', 'no test'),
  ]));
  const prds = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'e-st', 'prds');
  fs.mkdirSync(prds, { recursive: true });
  const fixes = JSON.stringify([{ prd: '1-alpha', missKind: 'spec-gap', reason: 'gap' }]);
  fs.writeFileSync(path.join(prds, '2-fix.md'), `---\nfixes: ${fixes}\n---\n\n# Goal\n`);
  const rec = await getEpicRecord(cwd, opts(cwd, { id: 'e-st' }));
  expect(rec.planReviewStats.unreviewed.plans).toBe(1);
  expect(rec.planReviewStats.unreviewed.escapes).toBe(1);
  expect(rec.planReviewStats.unreviewed.refuted).toBe(1);
});

test('readEpicFixes: caches per file by stat, re-reads a touched file, drops deleted, caps at 2000', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const prds = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'e-cache', 'prds');
  fs.mkdirSync(prds, { recursive: true });
  const fx = (n) => JSON.stringify([{ prd: `${n}-a`, missKind: 'spec-gap', reason: 'gap' }]);
  const a = path.join(prds, '2-fix.md');
  const b = path.join(prds, '3-fix.md');
  fs.writeFileSync(a, `---\nfixes: ${fx(1)}\n---\n\n# Goal\n`);
  fs.writeFileSync(b, `---\nfixes: ${fx(2)}\n---\n\n# Goal\n`);
  const spy = vi.spyOn(fs, 'readFileSync');
  try {
    const prdReads = () => spy.mock.calls.filter((c) => String(c[0]).startsWith(prds)).length;
    expect(readEpicFixes(cwd, 'e-cache')).toHaveLength(2);
    expect(prdReads()).toBe(2);
    expect(readEpicFixes(cwd, 'e-cache')).toHaveLength(2);
    expect(prdReads()).toBe(2);
    fs.writeFileSync(a, `---\nfixes: ${fx(9)}\n---\n\n# Goal\n\nmore\n`);
    const r = readEpicFixes(cwd, 'e-cache');
    expect(prdReads()).toBe(3);
    expect(r.map((f) => f.prd)).toEqual(['9-a', '2-a']);
    fs.rmSync(b);
    expect(readEpicFixes(cwd, 'e-cache').map((f) => f.prd)).toEqual(['9-a']);
    for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(prds, `z${String(i).padStart(5, '0')}.md`), '# x\n');
    spy.mockClear();
    expect(() => readEpicFixes(cwd, 'e-cache')).not.toThrow();
    expect(prdReads()).toBeLessThanOrEqual(2000);
  } finally {
    spy.mockRestore();
  }
});

test('readEpicFixes: one combined NN-sorted list keeps the highest NNs; cache stays bounded across Epics', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const mk = (epic, sub, name, n) => {
    const d = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epic, sub);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, name), `---\nfixes: ${JSON.stringify([{ prd: `${n}-a`, missKind: 'spec-gap', reason: 'g' }])}\n---\n`);
  };
  try {
    _setFixesCapsForTests(3, 4);
    mk('e-cap', 'prds-archived', '1-old.md', 1);
    mk('e-cap', 'prds-archived', '2-old.md', 2);
    mk('e-cap', 'prds', '10-new.md', 10);
    mk('e-cap', 'prds', '11-new.md', 11);
    mk('e-cap', 'prds', '12-new.md', 12);
    expect(readEpicFixes(cwd, 'e-cap').map((f) => f.prd)).toEqual(['10-a', '11-a', '12-a']);
    for (const e of ['e-c1', 'e-c2', 'e-c3']) {
      for (let i = 1; i <= 3; i++) mk(e, 'prds', `${i}-x.md`, i);
      readEpicFixes(cwd, e);
      expect(_fixesCacheSizeForTests()).toBeLessThanOrEqual(4);
    }
  } finally {
    _setFixesCapsForTests();
  }
});

test('readEpicFixes: a cache hit refreshes position so eviction is least-recently-used', async () => {
  const cwd = await mkTmp('sm-outside-read-cwd-');
  const mk = (epic, n) => {
    const d = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epic, 'prds');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${n}-x.md`), `---\nfixes: ${JSON.stringify([{ prd: `${n}-a`, missKind: 'spec-gap', reason: 'g' }])}\n---\n`);
  };
  const spy = vi.spyOn(fs, 'readFileSync');
  try {
    _setFixesCapsForTests(null, 4);
    for (const e of ['e-lA', 'e-lB', 'e-lC']) { mk(e, 1); mk(e, 2); }
    readEpicFixes(cwd, 'e-lA');
    readEpicFixes(cwd, 'e-lB');
    readEpicFixes(cwd, 'e-lA'); // refresh A
    readEpicFixes(cwd, 'e-lC'); // evicts B, not A
    expect(_fixesCacheSizeForTests()).toBeLessThanOrEqual(4);
    spy.mockClear();
    readEpicFixes(cwd, 'e-lA');
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('e-lA')).length).toBe(0);
  } finally {
    spy.mockRestore();
    _setFixesCapsForTests();
  }
});
