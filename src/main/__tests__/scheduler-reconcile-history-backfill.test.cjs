/**
 * scheduler-reconcile-history-backfill.test.cjs — regression test for the
 * bug found 2026-08-02 while investigating why session-manager's own
 * Scheduler tab showed an empty Queue AND an empty History: a completed
 * job's PRD `.md` is archived immediately (archiveCompletedPrd, called right
 * when the job finishes) — long before HISTORY_RETENTION_MS (7 days) would
 * ever cause queueHistory.partitionJobs to append it to history.jsonl. The
 * very next reconcile() pass then found the .md gone and silently dropped
 * the job's row from jobs[] via the "terminal job whose .md is gone was
 * archived on purpose" branch, without ever writing it to history.jsonl —
 * total loss of the completed job's record.
 *
 * reconcile() must now backfill history.jsonl for exactly this case before
 * dropping the row.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reconcile-history-backfill.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDirs = [];

function makeFixtureCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-history-'));
  tmpDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  vi.resetModules();
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcile() backfills history.jsonl for a completed job whose PRD file is already gone', async () => {
  const cwd = makeFixtureCwd();
  const opsRoot = path.join(cwd, 'session-manager-operations');
  fs.mkdirSync(path.join(opsRoot, 'scheduler', 'prds'), { recursive: true });
  fs.mkdirSync(path.join(opsRoot, 'scheduler', 'state'), { recursive: true });

  const { reconcile } = require('../scheduler.cjs');

  const job = {
    slug: '999-vanished-prd',
    title: 'Vanished PRD',
    cwd,
    status: 'completed',
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    error: null,
    runId: 'run-1',
  };
  // No matching .md anywhere under prds/ or prds-archived/ for this slug —
  // simulates the file having already been archived by archiveCompletedPrd
  // in the same tick the job finished, well before this reconcile() call.
  const state = { jobs: [job] };

  await reconcile(state);

  expect(state.jobs.find((j) => j.slug === job.slug)).toBeUndefined();

  const historyPath = path.join(opsRoot, 'scheduler', 'state', 'history.jsonl');
  expect(fs.existsSync(historyPath)).toBe(true);
  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
  const recorded = lines.map((l) => JSON.parse(l)).find((e) => e.slug === job.slug);
  expect(recorded).toBeDefined();
  expect(recorded.status).toBe('completed');
  expect(recorded.runId).toBe('run-1');
});

test('reconcile() does not double-write history for a job already recorded there', async () => {
  const cwd = makeFixtureCwd();
  const opsRoot = path.join(cwd, 'session-manager-operations');
  fs.mkdirSync(path.join(opsRoot, 'scheduler', 'prds'), { recursive: true });
  const stateDir = path.join(opsRoot, 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const job = {
    slug: '998-already-recorded',
    title: 'Already recorded',
    cwd,
    status: 'completed',
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    error: null,
    runId: 'run-2',
  };
  const historyPath = path.join(stateDir, 'history.jsonl');
  fs.writeFileSync(historyPath, JSON.stringify(job) + '\n', 'utf8');

  const { reconcile } = require('../scheduler.cjs');
  const state = { jobs: [job] };
  await reconcile(state);

  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
  const matches = lines.map((l) => JSON.parse(l)).filter((e) => e.slug === job.slug);
  expect(matches.length).toBe(1);
});
