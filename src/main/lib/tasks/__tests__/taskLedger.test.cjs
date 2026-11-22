/**
 * taskLedger.test.cjs — the Task ledger (lib/tasks/taskLedger.cjs) over a tmp project cwd.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskLedger.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ledger = require('../taskLedger.cjs');
const { opsPath, assertOpsWrite } = require('../../opsOwnership.cjs');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let cwd;
let home;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tasks-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tasks-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  ledger._resetForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startRow(taskId, over = {}) {
  return {
    taskId,
    cwd,
    agent: 'dev-lead',
    model: 'claude-sonnet-4-5',
    effort: 'medium',
    missionId: null,
    priority: 'batch',
    caller: { pipeline: 'burrow', runId: 'r1', step: 'draft', attempt: 1 },
    startedAt: new Date().toISOString(),
    timeoutSec: 600,
    slotWaitSec: 0,
    runtimeCwd: cwd,
    prompt: `prompt for ${taskId}`,
    ...over,
  };
}

function endRow(taskId, startedAt, over = {}) {
  return {
    taskId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: 1000,
    slotWaitMs: 5,
    status: 'ok',
    exitCode: 0,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    modelUsage: {},
    costUsd: 0.5,
    cliCostUsd: 0.5,
    numTurns: 1,
    quota: { rateLimited: false, resetsAt: null },
    error: null,
    output: `output for ${taskId}`,
    stderrTail: '',
    envelope: { type: 'result' },
    ...over,
  };
}

test('round trip: start + end fold into one ok Task; summary carries hashes, never text', async () => {
  const s = startRow('t1');
  await ledger.appendTaskStart(cwd, s);
  await ledger.appendTaskEnd(cwd, endRow('t1', s.startedAt));

  const day = opsPath(cwd, 'tasks', `${localDate(s.startedAt)}.jsonl`);
  const raw = fs.readFileSync(day, 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => l.kind)).toEqual(['start', 'end']);
  expect(lines[0]).toMatchObject({ v: 1, source: 'sm', promptSha256: sha(s.prompt), promptBytes: s.prompt.length });
  expect(lines[1]).toMatchObject({ v: 1, outputSha256: sha('output for t1'), outputBytes: 'output for t1'.length });
  expect(raw).not.toContain('prompt for t1');
  expect(raw).not.toContain('output for t1');

  const { tasks, total, hasMore, skippedLines } = await ledger.listTasks(cwd);
  expect(total).toBe(1);
  expect(hasMore).toBe(false);
  expect(skippedLines).toBe(0);
  expect(tasks[0]).toMatchObject({ taskId: 't1', status: 'ok', agent: 'dev-lead', costUsd: 0.5 });

  const one = await ledger.getTask(cwd, 't1');
  expect(one.status).toBe('ok');
  expect(one.body).toMatchObject({ prompt: s.prompt, output: 'output for t1', promptTruncated: false, outputTruncated: false });
  expect(await ledger.getTask(cwd, 'nope')).toBeNull();
});

test('filters by pipeline, runId, step, agent, status, source and time', async () => {
  const a = startRow('a', { startedAt: '2026-11-20T10:00:00.000Z' });
  const b = startRow('b', { agent: 'architect', caller: { pipeline: 'kiln', runId: 'r2', step: 'review', attempt: 1 }, startedAt: '2026-11-21T10:00:00.000Z' });
  await ledger.appendTaskStart(cwd, a);
  await ledger.appendTaskEnd(cwd, endRow('a', a.startedAt));
  await ledger.appendTaskStart(cwd, b);
  await ledger.appendTaskEnd(cwd, endRow('b', b.startedAt, { status: 'error' }));
  await ledger.appendImported(cwd, { ...startRow('c'), ...endRow('c', '2026-11-21T12:00:00.000Z'), startedAt: '2026-11-21T12:00:00.000Z', importId: 'imp-1' });

  const ids = async (f) => (await ledger.listTasks(cwd, f)).tasks.map((t) => t.taskId);
  expect(await ids({})).toEqual(['c', 'b', 'a']);
  expect(await ids({ pipeline: 'kiln' })).toEqual(['b']);
  expect(await ids({ runId: 'r1' })).toEqual(['c', 'a']);
  expect(await ids({ step: 'review' })).toEqual(['b']);
  expect(await ids({ agent: 'architect' })).toEqual(['b']);
  expect(await ids({ status: 'error' })).toEqual(['b']);
  expect(await ids({ source: 'direct' })).toEqual(['c']);
  expect(await ids({ source: 'sm' })).toEqual(['b', 'a']);
  expect(await ids({ since: '2026-11-21T00:00:00.000Z' })).toEqual(['c', 'b']);
  expect(await ids({ until: '2026-11-21T00:00:00.000Z' })).toEqual(['a']);
});

test('pagination: limit/offset/hasMore, limit capped at 200', async () => {
  for (let i = 0; i < 5; i += 1) {
    await ledger.appendTaskStart(cwd, startRow(`p${i}`, { startedAt: new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString() }));
  }
  const p1 = await ledger.listTasks(cwd, { limit: 2 });
  expect(p1.tasks.map((t) => t.taskId)).toEqual(['p4', 'p3']);
  expect(p1).toMatchObject({ total: 5, hasMore: true });
  const p3 = await ledger.listTasks(cwd, { limit: 2, offset: 4 });
  expect(p3.tasks.map((t) => t.taskId)).toEqual(['p0']);
  expect(p3.hasMore).toBe(false);

  for (let i = 0; i < 205; i += 1) {
    await ledger.appendTaskStart(cwd, startRow(`q${i}`, { startedAt: new Date(Date.UTC(2026, 10, 21, 0, 0, i)).toISOString() }));
  }
  expect((await ledger.listTasks(cwd, { limit: 1000 })).tasks).toHaveLength(200);
  expect((await ledger.listTasks(cwd)).tasks).toHaveLength(50);
});

test('a start with no end reads running until timeout + 120s, then interrupted', async () => {
  const now = Date.now();
  await ledger.appendTaskStart(cwd, startRow('live', { startedAt: new Date(now - 1000).toISOString(), timeoutSec: 600 }));
  await ledger.appendTaskStart(cwd, startRow('dead', { startedAt: new Date(now - (60 + 121) * 1000).toISOString(), timeoutSec: 60 }));
  const { tasks } = await ledger.listTasks(cwd);
  const by = Object.fromEntries(tasks.map((t) => [t.taskId, t.status]));
  expect(by).toEqual({ live: 'running', dead: 'interrupted' });
  expect((await ledger.listTasks(cwd, { status: 'interrupted' })).tasks.map((t) => t.taskId)).toEqual(['dead']);
});

test('malformed lines are skipped and counted, never thrown', async () => {
  const s = startRow('ok1');
  await ledger.appendTaskStart(cwd, s);
  const day = opsPath(cwd, 'tasks', `${localDate(s.startedAt)}.jsonl`);
  fs.appendFileSync(day, '{not json\n[1,2]\n{"kind":"end"}\n');
  const res = await ledger.listTasks(cwd);
  expect(res.tasks.map((t) => t.taskId)).toEqual(['ok1']);
  expect(res.skippedLines).toBe(3);
});

test('prompt and output over 1 MiB are truncated in the body; hashes/bytes cover the full text', async () => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const s = startRow('big', { prompt: big });
  await ledger.appendTaskStart(cwd, s);
  await ledger.appendTaskEnd(cwd, endRow('big', s.startedAt, { output: big }));
  const t = await ledger.getTask(cwd, 'big');
  expect(t.promptSha256).toBe(sha(big));
  expect(t.promptBytes).toBe(big.length);
  expect(t.outputSha256).toBe(sha(big));
  expect(t.outputBytes).toBe(big.length);
  expect(t.body.promptTruncated).toBe(true);
  expect(t.body.outputTruncated).toBe(true);
  expect(Buffer.byteLength(t.body.prompt)).toBe(1024 * 1024);
  expect(Buffer.byteLength(t.body.output)).toBe(1024 * 1024);
});

test('retention: pruneOld drops day files and bodies older than the window; default is 30 days', async () => {
  const old = startRow('old', { startedAt: '2026-01-01T12:00:00.000Z' });
  const fresh = startRow('fresh', { startedAt: '2026-11-20T12:00:00.000Z' });
  await ledger.appendTaskStart(cwd, old);
  await ledger.appendTaskStart(cwd, fresh);
  const oldBody = opsPath(cwd, 'tasks', 'bodies', 'old.json');
  const past = new Date('2026-01-01T12:00:00.000Z');
  fs.utimesSync(oldBody, past, past);

  const res = await ledger.pruneOld(cwd, { now: new Date('2026-11-22T12:00:00.000Z').getTime() });
  expect(res.maxAgeDays).toBe(30);
  expect(res.removedDays).toEqual([localDate(old.startedAt)]);
  expect(res.removedBodies).toBe(1);
  expect(fs.existsSync(oldBody)).toBe(false);
  expect(fs.existsSync(opsPath(cwd, 'tasks', 'bodies', 'fresh.json'))).toBe(true);
  expect((await ledger.listTasks(cwd)).tasks.map((t) => t.taskId)).toEqual(['fresh']);
});

test('retention honors tasksDays from ops-retention.json', async () => {
  const settings = require('../../opsRetentionSettings.cjs');
  settings.write({ tasksDays: 1 });
  await ledger.appendTaskStart(cwd, startRow('y', { startedAt: '2026-11-19T12:00:00.000Z' }));
  const res = await ledger.pruneOld(cwd, { now: new Date('2026-11-22T12:00:00.000Z').getTime() });
  expect(res.maxAgeDays).toBe(1);
  expect(res.removedDays).toHaveLength(1);
});

test('hasImport finds an imported row by importId', async () => {
  expect(await ledger.hasImport(cwd, 'imp-9')).toBe(false);
  await ledger.appendImported(cwd, { ...startRow('i1'), ...endRow('i1', new Date().toISOString()), importId: 'imp-9' });
  expect(await ledger.hasImport(cwd, 'imp-9')).toBe(true);
  expect(await ledger.hasImport(cwd, 'imp-10')).toBe(false);
  const t = await ledger.getTask(cwd, 'i1');
  expect(t).toMatchObject({ source: 'direct', importId: 'imp-9', status: 'ok' });
  expect(t.body.prompt).toBe('prompt for i1');
});

test('concurrent appends to one day file are serialized (no torn lines)', async () => {
  const at = new Date().toISOString();
  await Promise.all(Array.from({ length: 40 }, (_, i) => ledger.appendTaskStart(cwd, startRow(`c${i}`, { startedAt: at }))));
  const res = await ledger.listTasks(cwd, { limit: 200 });
  expect(res.total).toBe(40);
  expect(res.skippedLines).toBe(0);
});

test('readTaskUsageDays sums usage per local day', async () => {
  const a = startRow('u1', { startedAt: '2026-11-20T12:00:00.000Z' });
  await ledger.appendTaskStart(cwd, a);
  await ledger.appendTaskEnd(cwd, endRow('u1', a.startedAt));
  await ledger.appendImported(cwd, { ...startRow('u2'), ...endRow('u2', '2026-11-20T13:00:00.000Z'), startedAt: '2026-11-20T13:00:00.000Z', importId: 'x' });
  const d = localDate(a.startedAt);
  const days = await ledger.readTaskUsageDays(cwd, { sinceDate: d, untilDate: d });
  expect(days).toEqual([{
    date: d, tasks: 2, input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 6, cache_creation_input_tokens: 8, costUsd: 1,
    byModel: { 'claude-sonnet-4-5': { tasks: 2, input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 6, cache_creation_input_tokens: 8 } },
  }]);
  expect(await ledger.readTaskUsageDays(cwd, { sinceDate: '2026-11-21', untilDate: '2026-11-22' })).toEqual([]);
});

test("the single-writer law refuses any writer but 'tasks' in tasks/", () => {
  const file = opsPath(cwd, 'tasks', '2026-11-22.jsonl');
  expect(() => assertOpsWrite(file, 'scheduler')).toThrow(/owned by 'tasks'/);
  expect(() => assertOpsWrite(file, undefined)).toThrow(/did not declare a writer/);
  expect(() => assertOpsWrite(file, 'tasks')).not.toThrow();
});

test('a taskId that could escape bodies/ is rejected', async () => {
  await expect(ledger.appendTaskStart(cwd, startRow('../evil'))).rejects.toThrow(/taskId/);
});
