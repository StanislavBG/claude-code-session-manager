/**
 * prdCreate-cross-epic-files-overlap.test.cjs — createPrd / createPrdBatch WARN
 * (never refuse) when a pending/running/investigating PRD of another Epic in the
 * same project declares overlapping files (the 2026-11-22 Self stall: 1047 and
 * 1056 both declared pipelines/ops/sm_contract.py + tests/test_sm_contract.py).
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdCreate-cross-epic-files-overlap.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd, createPrdBatch } = require('../prdCreate.cjs');
const schedulerBatch = require('../../scheduler/schedulerBatch.cjs');

const EPIC_A = 'portfolio-and-kiln-owner-decisions-in-session-ma-f25f3d71';
const EPIC_B = 'portfolio-use-session-manager-s-outside-contract-a23ae9c4';
const FILES = ['pipelines/ops/sm_contract.py', 'tests/test_sm_contract.py'];

let cwd;
let outDir;
let nextNn;
let rows;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cross-epic-files-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 1047;
  rows = [];
  remote = {
    async allocateParallelGroup() { return nextNn++; },
    async readPrd(slug) {
      try { return { ok: true, text: await fsp.readFile(path.join(outDir, `${slug}.md`), 'utf8') }; } catch { return { ok: false }; }
    },
    async writePrd(slug, body) {
      const p = path.join(outDir, `${slug}.md`);
      await fsp.writeFile(p, body);
      // Mirror listPrds: no `files` on the row, so the # Files section is read back.
      const epicId = (/^sourcePromptId: (.+)$/m.exec(body) || [])[1] ?? null;
      rows.push({ slug, epicId, status: 'pending' });
      return { ok: true, path: p, epicId };
    },
    async listPrds() { return { prds: rows, total: rows.length, limit: rows.length, offset: 0, hasMore: false }; },
  };
});

const entry = (slug, o = {}) => ({
  title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const overlapWarnings = (r) => (r.warnings ?? []).filter((w) => w.startsWith('Files overlap with'));

test('schedulerBatch exports the scheduler\'s own filesOverlap / pathsOverlap', () => {
  expect(typeof schedulerBatch.filesOverlap).toBe('function');
  expect(typeof schedulerBatch.pathsOverlap).toBe('function');
  expect(schedulerBatch.filesOverlap(['./a//b.js'], ['a/b.js'])).toBe(true);
});

test('overlap with another Epic\'s pending PRD warns, naming its NN slug, Epic and paths (never refuses)', async () => {
  const a = await createPrd(entry('sm-contract-client', { cwd, sourcePromptId: EPIC_A, files: FILES }), remote);
  expect(a.ok).toBe(true);
  expect(overlapWarnings(a)).toEqual([]);

  const b = await createPrd(entry('sm-contract-tests', { cwd, sourcePromptId: EPIC_B, files: ['tests/test_sm_contract.py', 'other.py'] }), remote);
  expect(b.ok).toBe(true);
  const w = overlapWarnings(b);
  expect(w).toHaveLength(1);
  expect(w[0]).toContain('1047-sm-contract-client');
  expect(w[0]).toContain(EPIC_A);
  expect(w[0]).toContain('tests/test_sm_contract.py');
  expect(w[0]).not.toContain('other.py');
});

test('running and investigating rows warn too; row-supplied files are used without reading', async () => {
  rows = [
    { slug: '900-x', epicId: EPIC_A, status: 'running', files: ['src/a.js'] },
    { slug: '901-y', epicId: EPIC_A, status: 'investigating', files: ['src/a.js'] },
  ];
  const b = await createPrd(entry('z', { cwd, sourcePromptId: EPIC_B, files: ['src/a.js'] }), remote);
  expect(b.ok).toBe(true);
  expect(overlapWarnings(b).map((x) => x.split(' (')[0])).toEqual(['Files overlap with 900-x', 'Files overlap with 901-y']);
});

test('same-Epic overlap does not warn', async () => {
  await createPrd(entry('first', { cwd, sourcePromptId: EPIC_A, files: FILES }), remote);
  const b = await createPrd(entry('second', { cwd, sourcePromptId: EPIC_A, files: FILES }), remote);
  expect(b.ok).toBe(true);
  expect(overlapWarnings(b)).toEqual([]);
});

test('overlap with a completed (or cancelled) PRD does not warn', async () => {
  rows = [
    { slug: '900-done', epicId: EPIC_A, status: 'completed', files: FILES },
    { slug: '901-gone', epicId: EPIC_A, status: 'cancelled', files: FILES },
  ];
  const b = await createPrd(entry('z', { cwd, sourcePromptId: EPIC_B, files: FILES }), remote);
  expect(b.ok).toBe(true);
  expect(overlapWarnings(b)).toEqual([]);
});

test('a folder entry (trailing /) overlapping a file warns', async () => {
  rows = [{ slug: '900-ops', epicId: EPIC_A, status: 'pending', files: ['pipelines/ops/sm_contract.py'] }];
  const b = await createPrd(entry('z', { cwd, sourcePromptId: EPIC_B, files: ['pipelines/ops/'] }), remote);
  expect(b.ok).toBe(true);
  const w = overlapWarnings(b);
  expect(w).toHaveLength(1);
  expect(w[0]).toContain('900-ops');
  expect(w[0]).toContain('pipelines/ops/ ~ pipelines/ops/sm_contract.py');
});

test('batch path carries the warning on the overlapping entry only', async () => {
  rows = [{ slug: '1000-sm-contract-client', epicId: EPIC_A, status: 'pending', files: FILES }];
  const r = await createPrdBatch([
    entry('unrelated', { files: ['docs/x.md'] }),
    entry('sm-contract-tests', { files: ['tests/test_sm_contract.py'] }),
  ], remote, { cwd, sourcePromptId: EPIC_B });
  expect(r.ok).toBe(true);
  const results = r.results ?? r.prds;
  expect(overlapWarnings(results[0])).toEqual([]);
  const w = overlapWarnings(results[1]);
  expect(w).toHaveLength(1);
  expect(w[0]).toContain('1000-sm-contract-client');
  expect(w[0]).toContain(EPIC_A);
});

// 2026-11-24 Bilko: PRD 2005 named the same files as 2001, written moments
// before by another Epic and not yet reconciled — its listing row has status
// null, and the advisory skipped it.
test('a live, never-reconciled row (status null) of another Epic warns', async () => {
  rows = [{ slug: '2001-sync-drop-record-push', epicId: EPIC_A, status: null, archived: false, files: ['scripts/sync-local-main.sh'] }];
  const b = await createPrd(entry('sync-push-guard', { cwd, sourcePromptId: EPIC_B, files: ['scripts/sync-local-main.sh'] }), remote);
  expect(b.ok).toBe(true);
  const w = overlapWarnings(b);
  expect(w).toHaveLength(1);
  expect(w[0]).toContain('2001-sync-drop-record-push');
  expect(w[0]).toContain(EPIC_A);
});

test('an archived status-null row does not warn', async () => {
  rows = [{ slug: '2001-sync-drop-record-push', epicId: EPIC_A, status: null, archived: true, files: ['scripts/sync-local-main.sh'] }];
  const b = await createPrd(entry('sync-push-guard', { cwd, sourcePromptId: EPIC_B, files: ['scripts/sync-local-main.sh'] }), remote);
  expect(b.ok).toBe(true);
  expect(overlapWarnings(b)).toEqual([]);
});
