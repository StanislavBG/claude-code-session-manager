/**
 * terminalRunOutcome.test.cjs — unit tests for the history-independent
 * terminal-run-outcome probe (PRD 812-689-fix-fix-distribute-adminserver-routes).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/terminalRunOutcome.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  latestTerminalOutcomeForSlug,
  MAX_DIRS_SCANNED,
} = require('../terminalRunOutcome.cjs');

function mkTmpRunsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-run-outcome-'));
}

function writeRun(runsDir, runId, slug, meta, verdicts) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  if (meta !== undefined) {
    fs.writeFileSync(path.join(dir, `${slug}.meta.json`), typeof meta === 'string' ? meta : JSON.stringify(meta));
  }
  if (verdicts !== undefined) {
    fs.writeFileSync(path.join(dir, `${slug}.verdicts.json`), typeof verdicts === 'string' ? verdicts : JSON.stringify(verdicts));
  }
}

test('returns completed for newest run with exitCode 0 + clean verdict', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'my-slug', { exitCode: 0, finishedAt: 1785483574748 }, { verdict: 'clean' });
  const result = latestTerminalOutcomeForSlug('my-slug', { runsDir });
  expect(result).toEqual({ status: 'completed', runId: '2026-07-31T07-38-29-081Z', finishedAt: new Date(1785483574748).toISOString() });
});

test('returns completed for pass_no_commit_already_shipped verdict', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'my-slug', { exitCode: 0, finishedAt: 1785483574749 }, { verdict: 'pass_no_commit_already_shipped' });
  const result = latestTerminalOutcomeForSlug('my-slug', { runsDir });
  expect(result).toEqual({ status: 'completed', runId: '2026-07-31T07-38-29-081Z', finishedAt: new Date(1785483574749).toISOString() });
});

test('returns failed for non-zero exitCode', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'my-slug', { exitCode: 1, finishedAt: 1785483574750 });
  const result = latestTerminalOutcomeForSlug('my-slug', { runsDir });
  expect(result).toEqual({ status: 'failed', runId: '2026-07-31T07-38-29-081Z', finishedAt: new Date(1785483574750).toISOString() });
});

test('returns failed for exitCode 0 with a non-completed-equivalent verdict', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'my-slug', { exitCode: 0, finishedAt: 1785483574751 }, { verdict: 'transcript_errors' });
  const result = latestTerminalOutcomeForSlug('my-slug', { runsDir });
  expect(result).toEqual({ status: 'failed', runId: '2026-07-31T07-38-29-081Z', finishedAt: new Date(1785483574751).toISOString() });
});

test('returns null when there is no run dir for the slug', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'other-slug', { exitCode: 0 }, { verdict: 'clean' });
  expect(latestTerminalOutcomeForSlug('my-slug', { runsDir })).toBeNull();
});

test('returns null on malformed meta.json', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'my-slug', '{not json', { verdict: 'clean' });
  expect(latestTerminalOutcomeForSlug('my-slug', { runsDir })).toBeNull();
});

test('returns null on malformed verdicts.json', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'my-slug', { exitCode: 0 }, '{not json');
  expect(latestTerminalOutcomeForSlug('my-slug', { runsDir })).toBeNull();
});

test('returns null when runsDir does not exist', () => {
  expect(latestTerminalOutcomeForSlug('my-slug', { runsDir: '/nonexistent/path/xyz' })).toBeNull();
});

test('picks the newest of several run dirs for the same slug', () => {
  const runsDir = mkTmpRunsDir();
  writeRun(runsDir, '2026-07-01T00-00-00-000Z', 'my-slug', { exitCode: 1, finishedAt: 10 });
  writeRun(runsDir, '2026-07-31T07-38-29-081Z', 'my-slug', { exitCode: 0, finishedAt: 1785483574752 }, { verdict: 'clean' });
  writeRun(runsDir, '2026-06-01T00-00-00-000Z', 'my-slug', { exitCode: 1, finishedAt: 5 });
  const result = latestTerminalOutcomeForSlug('my-slug', { runsDir });
  expect(result).toEqual({ status: 'completed', runId: '2026-07-31T07-38-29-081Z', finishedAt: new Date(1785483574752).toISOString() });
});

test('stats at most the newest few run dirs (bound enforced)', () => {
  const runsDir = mkTmpRunsDir();
  // Create many more matching run dirs than MAX_DIRS_SCANNED, all with a
  // non-terminal-equivalent verdict so the loop never early-returns before
  // exhausting the candidate slice — proves the bound is actually applied.
  const total = MAX_DIRS_SCANNED + 10;
  for (let i = 0; i < total; i++) {
    const ts = `2026-07-${String(i + 1).padStart(2, '0')}T00-00-00-000Z`;
    writeRun(runsDir, ts, 'my-slug', { exitCode: 0, finishedAt: i }, { verdict: 'transcript_errors' });
  }

  let readFileCalls = 0;
  const fsImpl = {
    readdirSync: (...a) => fs.readdirSync(...a),
    existsSync: (...a) => fs.existsSync(...a),
    readFileSync: (...a) => {
      readFileCalls++;
      return fs.readFileSync(...a);
    },
  };

  latestTerminalOutcomeForSlug('my-slug', { runsDir, fsImpl });
  // Each scanned dir reads meta.json, then (since exitCode===0) verdicts.json
  // too, so at most MAX_DIRS_SCANNED * 2 readFileSync calls.
  expect(readFileCalls).toBeLessThanOrEqual(MAX_DIRS_SCANNED * 2);
});

// ─── sidecar-resilience (2026-08-13) ────────────────────────────────────────
//
// Every branch used to `return` on the FIRST candidate dir, so an unreadable
// or half-written sidecar in the newest run erased an older, complete terminal
// record — the anti-resurrection guard switching itself off on exactly the
// input it exists to survive, which lets reconcile re-derive a fresh queue row
// and re-run an already-completed PRD. It also made MAX_DIRS_SCANNED a no-op.

function memFs(files) {
  return {
    readdirSync: (d) => Object.keys(files[d] ?? {}),
    existsSync: (p) => {
      const dir = path.dirname(p);
      const base = path.basename(p);
      return Boolean(files[path.dirname(dir)]?.[path.basename(dir)]?.[base]);
    },
    readFileSync: (p) => {
      const dir = path.dirname(p);
      const base = path.basename(p);
      const content = files[path.dirname(dir)]?.[path.basename(dir)]?.[base];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
}

const RUNS = '/runs';
const SLUG = '900-thing';

function tree(dirs) {
  return { [RUNS]: dirs };
}

test('an unreadable meta sidecar in the newest dir falls through to an older complete run', () => {
  const fsImpl = memFs(tree({
    '2026-08-14T02-00-00-000Z': { [`${SLUG}.meta.json`]: '{ not json' },
    '2026-08-14T01-00-00-000Z': {
      [`${SLUG}.meta.json`]: JSON.stringify({ exitCode: 0, finishedAt: 1786669013583 }),
      [`${SLUG}.verdicts.json`]: JSON.stringify({ verdict: 'clean' }),
    },
  }));
  const out = latestTerminalOutcomeForSlug(SLUG, { runsDir: RUNS, fsImpl });
  expect(out).toBeTruthy();
  expect(out.status).toBe('completed');
  expect(out.runId).toBe('2026-08-14T01-00-00-000Z');
});

test('a newest run missing its verdicts sidecar falls through instead of erasing the older record', () => {
  const fsImpl = memFs(tree({
    '2026-08-14T02-00-00-000Z': { [`${SLUG}.meta.json`]: JSON.stringify({ exitCode: 0, finishedAt: 1 }) },
    '2026-08-14T01-00-00-000Z': {
      [`${SLUG}.meta.json`]: JSON.stringify({ exitCode: 0, finishedAt: 1786669013583 }),
      [`${SLUG}.verdicts.json`]: JSON.stringify({ verdict: 'pass_no_commit_prior_run_verified' }),
    },
  }));
  const out = latestTerminalOutcomeForSlug(SLUG, { runsDir: RUNS, fsImpl });
  expect(out).toBeTruthy();
  expect(out.status).toBe('completed');
  expect(out.runId).toBe('2026-08-14T01-00-00-000Z');
});

test('a non-zero exit in the newest dir is still authoritative — fall-through only covers UNREADABLE sidecars', () => {
  const fsImpl = memFs(tree({
    '2026-08-14T02-00-00-000Z': { [`${SLUG}.meta.json`]: JSON.stringify({ exitCode: 1, finishedAt: 2 }) },
    '2026-08-14T01-00-00-000Z': {
      [`${SLUG}.meta.json`]: JSON.stringify({ exitCode: 0, finishedAt: 1 }),
      [`${SLUG}.verdicts.json`]: JSON.stringify({ verdict: 'clean' }),
    },
  }));
  const out = latestTerminalOutcomeForSlug(SLUG, { runsDir: RUNS, fsImpl });
  expect(out.status).toBe('failed');
  expect(out.runId).toBe('2026-08-14T02-00-00-000Z');
});

test('every candidate being unreadable still yields null (no invented outcome)', () => {
  const fsImpl = memFs(tree({
    '2026-08-14T02-00-00-000Z': { [`${SLUG}.meta.json`]: '{ nope' },
    '2026-08-14T01-00-00-000Z': { [`${SLUG}.meta.json`]: '{ also nope' },
  }));
  expect(latestTerminalOutcomeForSlug(SLUG, { runsDir: RUNS, fsImpl })).toBeNull();
});
