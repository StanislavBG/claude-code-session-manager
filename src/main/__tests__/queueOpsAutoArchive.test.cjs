/**
 * queueOpsAutoArchive.test.cjs — unit tests for queueOps.cjs's
 * selectAutoArchivable predicate + autoArchiveCompleted orchestration
 * (auto-archiving completed PRDs' .md files out of the live prds/ dir).
 *
 * selectAutoArchivable is pure (no fs) so it's fully covered here without
 * touching disk. autoArchiveCompleted's disk-mutating path (archiveMany) is
 * mostly exercised only via its kill-switch / no-op branches, since
 * archiveMany's default destination is not test-injectable — except for the
 * two retire-flag tests below, which write into PRDS_DIR (a lazy getter
 * resolved under this run's SM_SCHEDULER_HOME sandbox — see
 * tests/setup/schedulerSandbox.cjs — so they never touch a real
 * ~/.claude/session-manager tree) and stub 'electron' via require.cache so
 * registerQueueOpsHandlers' ipcMain.handle calls are no-ops outside a real
 * Electron process. 'electron' is an externalized node_modules dependency
 * under vitest, so vi.mock('electron', ...) never intercepts queueOps.cjs's
 * own require('electron') — pre-seeding require.cache for its resolved path
 * is the one hook that reaches it.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/queueOpsAutoArchive.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { ipcMain: { handle: () => {} } },
};

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const NOW = Date.parse('2026-07-24T12:00:00.000Z');

const { selectAutoArchivable, autoArchiveCompleted, archiveMany, registerQueueOpsHandlers, PRDS_DIR } = require('../queueOps.cjs');

function fresh(overrides = {}) {
  return {
    slug: '01-fresh',
    status: 'completed',
    finishedAt: new Date(NOW - 1 * 60 * 60_000).toISOString(), // 1h ago
    ...overrides,
  };
}

function old(overrides = {}) {
  return {
    slug: '02-old',
    status: 'completed',
    finishedAt: new Date(NOW - 10 * 24 * 60 * 60_000).toISOString(), // 10d ago
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.SM_PRD_AUTOARCHIVE_DISABLE;
});

// ---------- selectAutoArchivable ----------

test('selectAutoArchivable: fresh completed job stays (not old enough)', () => {
  const slugs = selectAutoArchivable([fresh()], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: old completed job archives', () => {
  const slugs = selectAutoArchivable([old()], { nowMs: NOW });
  expect(slugs).toEqual(['02-old']);
});

test('selectAutoArchivable: needs_review jobs never archive, regardless of age', () => {
  const j = old({ slug: '03-review', status: 'needs_review' });
  const slugs = selectAutoArchivable([j], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: failed jobs never archive, regardless of age', () => {
  const j = old({ slug: '04-failed', status: 'failed' });
  const slugs = selectAutoArchivable([j], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: pending jobs never archive', () => {
  const j = old({ slug: '05-pending', status: 'pending', finishedAt: null });
  const slugs = selectAutoArchivable([j], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: running jobs never archive', () => {
  const j = old({ slug: '06-running', status: 'running', finishedAt: null });
  const slugs = selectAutoArchivable([j], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: a completed job with a PENDING NN-fix-<slug> sibling is protected', () => {
  const original = old({ slug: '07-thing', status: 'completed' });
  const fixPlan = { slug: '07-fix-thing', status: 'pending', finishedAt: null };
  const slugs = selectAutoArchivable([original, fixPlan], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: a completed job with a RUNNING NN-fix-<slug> sibling is protected', () => {
  const original = old({ slug: '08-thing', status: 'completed' });
  const fixPlan = { slug: '08-fix-thing', status: 'running', finishedAt: null };
  const slugs = selectAutoArchivable([original, fixPlan], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: a completed job with a COMPLETED fix-plan sibling is free to archive (no longer protected)', () => {
  const original = old({ slug: '09-thing', status: 'completed' });
  const fixPlan = old({ slug: '09-fix-thing', status: 'completed' });
  const slugs = selectAutoArchivable([original, fixPlan], { nowMs: NOW }).sort();
  expect(slugs).toEqual(['09-fix-thing', '09-thing']);
});

test('selectAutoArchivable: job with no/invalid finishedAt never archives even if status completed', () => {
  const j = { slug: '10-nofinish', status: 'completed', finishedAt: null };
  const slugs = selectAutoArchivable([j], { nowMs: NOW });
  expect(slugs).toEqual([]);
});

test('selectAutoArchivable: respects retentionMs override', () => {
  const j = { slug: '11-recent', status: 'completed', finishedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() };
  const slugs = selectAutoArchivable([j], { nowMs: NOW, retentionMs: 60 * 60_000 }); // 1h retention
  expect(slugs).toEqual(['11-recent']);
});

test('selectAutoArchivable: defaults retentionMs to the shared HISTORY_RETENTION_MS constant', () => {
  const j = { slug: '12-boundary', status: 'completed', finishedAt: new Date(NOW - RETENTION_MS - 1).toISOString() };
  const slugs = selectAutoArchivable([j], { nowMs: NOW });
  expect(slugs).toEqual(['12-boundary']);
});

// ---------- autoArchiveCompleted ----------

test('autoArchiveCompleted: kill switch SM_PRD_AUTOARCHIVE_DISABLE=1 skips entirely', async () => {
  process.env.SM_PRD_AUTOARCHIVE_DISABLE = '1';
  const result = await autoArchiveCompleted({ jobs: [old()] }, { nowMs: NOW });
  expect(result.archived).toBe(0);
  expect(result.skipped).toBe('disabled');
});

test('autoArchiveCompleted: no eligible slugs returns a no-op without touching disk', async () => {
  const result = await autoArchiveCompleted({ jobs: [fresh()] }, { nowMs: NOW });
  expect(result.ok).toBe(true);
  expect(result.archived).toBe(0);
  expect(result.archivedTo).toBe(null);
  expect(result.results).toEqual([]);
});

test('autoArchiveCompleted: tolerates a missing/malformed state.jobs', async () => {
  const result = await autoArchiveCompleted({}, { nowMs: NOW });
  expect(result.archived).toBe(0);
});

// ---------- archiving never strands a runnable queue job (scheduler PRD:
// archived-prd-skip — job 822-epics-nav-rename fired ENOENT after its PRD
// was archived out from under a still-queued job) ----------

test('selectAutoArchivable never selects a slug whose job is still pending or running, so auto-archive can never leave a runnable job pointing at an archived PRD', () => {
  const pending = old({ slug: '13-pending', status: 'pending', finishedAt: null });
  const running = old({ slug: '14-running', status: 'running', finishedAt: null });
  const completed = old({ slug: '15-done', status: 'completed' });
  const slugs = selectAutoArchivable([pending, running, completed], { nowMs: NOW });
  expect(slugs).toEqual(['15-done']);
});

// ---------- retire-flag deadlock guard (PRD 1442: reconcile() -> mutate()
// body -> autoArchiveCompleted -> archiveMany -> retireCompletedSlugsFn ->
// mutate() re-entered every tick, so mutateTail never settled) ----------

test('autoArchiveCompleted never invokes retireCompletedSlugs', async () => {
  const slug = 'test-auto-archive-no-retire';
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  const src = path.join(PRDS_DIR, `${slug}.md`);
  fs.writeFileSync(src, '# Goal\n\ntest\n', 'utf8');

  const spy = vi.fn(async () => {});
  registerQueueOpsHandlers({ retireCompletedSlugs: spy });

  const job = old({ slug, status: 'completed' });
  const result = await autoArchiveCompleted({ jobs: [job] }, { nowMs: NOW });

  expect(result.archived).toBe(1);
  expect(fs.existsSync(src)).toBe(false);
  expect(result.results[0].ok).toBe(true);
  expect(fs.existsSync(result.results[0].archivedTo)).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});

test('manual archiveMany still retires', async () => {
  const slug = 'test-manual-archive-still-retires';
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  const src = path.join(PRDS_DIR, `${slug}.md`);
  fs.writeFileSync(src, '# Goal\n\ntest\n', 'utf8');

  const spy = vi.fn(async () => {});
  registerQueueOpsHandlers({ retireCompletedSlugs: spy });

  const result = await archiveMany([slug]);

  expect(result.archived).toBe(1);
  expect(fs.existsSync(src)).toBe(false);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith([slug]);
});
