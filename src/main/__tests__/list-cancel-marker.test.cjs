/**
 * list-cancel-marker.test.cjs — a human-cancelled queue row keeps its status
 * (failed or needs_review) but every list reader gets cancelled: true from the
 * shared isCancelledRow predicate; a real failure carries no cancelled key.
 * Covers remote.listPrds (compact + fields:'full') and remote.listJobs.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/list-cancel-marker.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let cwd;

const EPIC = 'cancel-marker-epic';
const CANCELLED_AT = '2026-11-22T10:00:00.000Z';
const CANCELLED = ['cm-cancelled-failed', 'cm-cancelled-review'];
const REAL_FAIL = 'cm-real-failed';

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-list-cancel-marker-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
  cwd = path.join(tmpHome, 'proj');
  const prds = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', EPIC, 'prds');
  fs.mkdirSync(prds, { recursive: true });
  for (const slug of [...CANCELLED, REAL_FAIL]) {
    fs.writeFileSync(path.join(prds, `${slug}.md`),
      `---\ntitle: ${slug}\ncwd: ${cwd}\nestimateMinutes: 10\nepicId: ${EPIC}\nsourcePromptId: ${EPIC}\n---\n\n# Goal\n\nx\n`);
  }
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd })}\n`);
  const base = (slug, status) => ({ slug, title: slug, cwd, epicId: EPIC, sourcePromptId: EPIC, status, dependsOn: [], finishedAt: CANCELLED_AT });
  await scheduler.writeQueue({
    jobs: [
      { ...base('cm-cancelled-failed', 'failed'), cancelledAt: CANCELLED_AT, error: 'cancelled via admin API' },
      { ...base('cm-cancelled-review', 'needs_review'), cancelledAt: CANCELLED_AT },
      { ...base(REAL_FAIL, 'failed'), error: 'gate failed: exit 1' },
    ],
    config: {},
    paused: null,
  });
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function assertMarks(rows) {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  for (const slug of CANCELLED) {
    expect(bySlug.get(slug), slug).toBeTruthy();
    expect(bySlug.get(slug).cancelled).toBe(true);
  }
  expect(bySlug.get('cm-cancelled-failed').status).toBe('failed');
  expect(bySlug.get('cm-cancelled-review').status).toBe('needs_review');
  const real = bySlug.get(REAL_FAIL);
  expect(real.status).toBe('failed');
  expect(Object.prototype.hasOwnProperty.call(real, 'cancelled')).toBe(false);
  expect(rows.filter((r) => r.cancelled === true).map((r) => r.slug).sort()).toEqual([...CANCELLED].sort());
}

test('listPrds compact marks exactly the cancelled rows', async () => {
  const res = await scheduler.remote.listPrds({ epicId: EPIC });
  expect(res.total).toBe(3);
  assertMarks(res.prds);
});

test("listPrds fields:'full' marks exactly the cancelled rows", async () => {
  const res = await scheduler.remote.listPrds({ epicId: EPIC, fields: 'full' });
  expect(res.total).toBe(3);
  assertMarks(res.prds);
});

test('listJobs marks exactly the cancelled rows and keeps its other fields', async () => {
  const jobs = await scheduler.remote.listJobs();
  assertMarks(jobs);
  const real = jobs.find((j) => j.slug === REAL_FAIL);
  expect(Object.keys(real).sort()).toEqual(['agentType', 'cwd', 'epicId', 'phase', 'slug', 'sourcePromptId', 'status', 'title']);
});
