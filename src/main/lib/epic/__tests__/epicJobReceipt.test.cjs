/**
 * epicJobReceipt.test.cjs — gatherEpicJobReceipt over a temp runs dir.
 * Run: timeout 180 npx vitest run src/main/lib/epic/__tests__/epicJobReceipt.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { gatherEpicJobReceipt } = require('../epicJobReceipt.cjs');

let root;
const CWD = '/p/alpha';
const SINCE = Date.parse('2026-10-22T00:00:00.000Z');

function addRun(runId, slug, meta) {
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.meta.json`), JSON.stringify({ slug, cwd: CWD, ...meta }));
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'epicreceipt-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

test('sums attempts per PRD; ignores other projects, old runs; null cost counted as run only', async () => {
  addRun('2026-10-22T01-00-00-000Z', '100-a', {
    exitCode: 1, numTurns: 5, outputTokens: 1000, totalCostUsd: 1.5, finishedAt: 1000, durationMs: 60000,
  });
  addRun('2026-10-22T02-00-00-000Z', '100-a', {
    exitCode: 0, numTurns: 7, outputTokens: 2000, totalCostUsd: 2, finishedAt: 2000, durationMs: 90000,
  });
  // Same slug, other project — ignored.
  addRun('2026-10-22T03-00-00-000Z', '100-a', { cwd: '/p/beta', totalCostUsd: 50, numTurns: 99 });
  // Before sinceMs — ignored.
  addRun('2026-10-21T23-00-00-000Z', '100-a', { totalCostUsd: 99, numTurns: 99 });
  // Null cost — counts as a run, not toward cost.
  addRun('2026-10-22T04-00-00-000Z', '099-b', {
    exitCode: 0, numTurns: 3, outputTokens: 500, totalCostUsd: null, finishedAt: 3000, durationMs: 10000,
  });
  // Slug not asked for — ignored.
  addRun('2026-10-22T05-00-00-000Z', '200-z', { totalCostUsd: 7 });
  // Malformed meta — skipped.
  fs.writeFileSync(path.join(root, '2026-10-22T05-00-00-000Z', '100-a.meta.json'), '{not json');
  // Non-run dir name — skipped.
  fs.mkdirSync(path.join(root, 'junk'));

  const r = await gatherEpicJobReceipt({ cwd: CWD, slugs: ['100-a', '099-b'], sinceMs: SINCE, runsRoot: root });

  expect(r.runs).toBe(3);
  expect(r.costUsd).toBeCloseTo(3.5);
  expect(r.costKnownRuns).toBe(2);
  expect(r.outputTokens).toBe(3500);
  expect(r.numTurns).toBe(15);
  expect(r.durationMs).toBe(160000);
  expect(r.byPrd).toEqual([
    { slug: '099-b', runs: 1, costUsd: 0, lastExitCode: 0, lastFinishedAt: 3000 },
    { slug: '100-a', runs: 2, costUsd: 3.5, lastExitCode: 0, lastFinishedAt: 2000 },
  ]);
});

test('missing runs folder returns zeros and does not reject', async () => {
  const r = await gatherEpicJobReceipt({
    cwd: CWD, slugs: ['100-a'], sinceMs: 0, runsRoot: path.join(root, 'nope'),
  });
  expect(r).toEqual({
    runs: 0, costUsd: 0, costKnownRuns: 0, outputTokens: 0, numTurns: 0, durationMs: 0, byPrd: [],
  });
});

test('slugs with a slash, backslash, "." or ".." are dropped; files they would reach are never read', async () => {
  const RUN = '2026-10-22T01-00-00-000Z';
  addRun(RUN, '100-a', { exitCode: 0, numTurns: 2, outputTokens: 10, totalCostUsd: 1, finishedAt: 1000, durationMs: 5 });
  const runDir = path.join(root, RUN);
  const bait = JSON.stringify({ cwd: CWD, exitCode: 9, numTurns: 1000, outputTokens: 1000, totalCostUsd: 1000, durationMs: 1000 });
  // '../leak' from inside the run dir reaches <root>/leak.meta.json — outside the run folder.
  fs.writeFileSync(path.join(root, 'leak.meta.json'), bait);
  // '../../leak' reaches the runs root's parent.
  const parentBait = path.join(path.dirname(root), `${path.basename(root)}-leak.meta.json`);
  fs.writeFileSync(parentBait, bait);
  // Where '.', '..', 'sub\\leak' and 'sub/leak' would land.
  fs.writeFileSync(path.join(runDir, '..meta.json'), bait);
  fs.writeFileSync(path.join(runDir, '...meta.json'), bait);
  fs.writeFileSync(path.join(runDir, 'sub\\leak.meta.json'), bait);
  fs.mkdirSync(path.join(runDir, 'sub'));
  fs.writeFileSync(path.join(runDir, 'sub', 'leak.meta.json'), bait);
  try {
    const r = await gatherEpicJobReceipt({
      cwd: CWD,
      slugs: ['../leak', `../../${path.basename(root)}-leak`, 'sub/leak', 'sub\\leak', '..\\leak', '.', '..', '100-a'],
      sinceMs: SINCE,
      runsRoot: root,
    });
    expect(r).toEqual({
      runs: 1, costUsd: 1, costKnownRuns: 1, outputTokens: 10, numTurns: 2, durationMs: 5,
      byPrd: [{ slug: '100-a', runs: 1, costUsd: 1, lastExitCode: 0, lastFinishedAt: 1000 }],
    });
  } finally {
    fs.rmSync(parentBait, { force: true });
  }
});

test('lists each run folder once and opens only the wanted meta files that exist', async () => {
  addRun('2026-10-22T01-00-00-000Z', '100-a', { exitCode: 0, numTurns: 1, totalCostUsd: 1, finishedAt: 1000 });
  addRun('2026-10-22T02-00-00-000Z', '101-b', { exitCode: 0, numTurns: 2, totalCostUsd: 2, finishedAt: 2000 });
  fs.mkdirSync(path.join(root, '2026-10-22T03-00-00-000Z'));
  // A meta file for a slug nobody asked for — listed, never opened.
  addRun('2026-10-22T03-00-00-000Z', '900-x', { totalCostUsd: 9 });
  const readSpy = vi.spyOn(fsp, 'readFile');
  const readdirSpy = vi.spyOn(fsp, 'readdir');

  const r = await gatherEpicJobReceipt({
    cwd: CWD, slugs: ['100-a', '101-b', '102-c', '103-d', '104-e'], sinceMs: SINCE, runsRoot: root,
  });

  const metaReads = readSpy.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith('.meta.json'));
  expect(metaReads.sort()).toEqual([
    path.join(root, '2026-10-22T01-00-00-000Z', '100-a.meta.json'),
    path.join(root, '2026-10-22T02-00-00-000Z', '101-b.meta.json'),
  ]);
  const runDirListings = readdirSpy.mock.calls.map((c) => String(c[0])).filter((p) => p !== root);
  expect(runDirListings.sort()).toEqual([
    path.join(root, '2026-10-22T01-00-00-000Z'),
    path.join(root, '2026-10-22T02-00-00-000Z'),
    path.join(root, '2026-10-22T03-00-00-000Z'),
  ]);
  expect(r.runs).toBe(2);
  expect(r.costUsd).toBeCloseTo(3);
});
