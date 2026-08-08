/**
 * scheduleJobStatusDrift.test.cjs — guards the mirrored copies of
 * JOB_STATUSES (src/main/lib/scheduleJobSchema.cjs) against silent drift.
 *
 * The renderer cannot require a .cjs module directly, and src/preload/api.d.ts
 * is types-only (erased at build time, nothing to import at test runtime), so
 * each consumer keeps its own hand-written mirror of the status enum:
 *   - src/preload/api.d.ts's `ScheduleJobStatus` union
 *   - src/renderer/components/ui/StatusBadge.tsx's `JobStatus` union
 *   - src/renderer/components/SchedulePanel.tsx's `FilterStatus` union
 *     (which also carries the UI-only 'all' meta-value)
 *
 * This test reads each file's source text and extracts its status list by
 * regex, then diffs it against JOB_STATUSES — the single source of truth.
 * A file whose union drifts (a status added/removed/renamed in one place but
 * not the others) fails this test instead of silently mis-filtering jobs,
 * which is exactly how the 2026-08-07 'queued' incident went undetected.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduleJobStatusDrift.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { JOB_STATUSES } = require('../lib/scheduleJobSchema.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function extractQuotedList(source, anchorRegex) {
  const match = source.match(anchorRegex);
  if (!match) throw new Error(`extractQuotedList: anchor not found — ${anchorRegex}`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test('JOB_STATUSES is the expected canonical list', () => {
  expect(JOB_STATUSES).toEqual(['pending', 'running', 'investigating', 'completed', 'failed', 'needs_review', 'quarantined']);
});

function sorted(list) {
  return [...list].sort();
}

test('src/preload/api.d.ts ScheduleJobStatus matches JOB_STATUSES', () => {
  const source = readSource('src/preload/api.d.ts');
  const values = extractQuotedList(source, /export type ScheduleJobStatus = ([^;]+);/);
  expect(sorted(values)).toEqual(sorted(JOB_STATUSES));
});

test('src/renderer/components/ui/StatusBadge.tsx JobStatus matches JOB_STATUSES', () => {
  const source = readSource('src/renderer/components/ui/StatusBadge.tsx');
  const values = extractQuotedList(source, /export type JobStatus = ([^\n]+)/);
  expect(sorted(values)).toEqual(sorted(JOB_STATUSES));
});

test('src/renderer/components/SchedulePanel.tsx FilterStatus matches JOB_STATUSES plus "all"', () => {
  const source = readSource('src/renderer/components/SchedulePanel.tsx');
  const values = extractQuotedList(source, /type FilterStatus = ([^\n]+)/);
  expect(sorted(values)).toEqual(sorted(['all', ...JOB_STATUSES]));
});
