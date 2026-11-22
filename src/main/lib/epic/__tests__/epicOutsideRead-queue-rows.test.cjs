/**
 * epicOutsideRead-queue-rows.test.cjs — the outside record (GET /admin/epic)
 * must count an Epic's live queue rows as projected by the REAL
 * scheduler.remote.listJobs(). That projection once dropped epicId and
 * sourcePromptId, so buildKnownPrds matched no row: Self Epic f25f3d71 read
 * in_review with total 1 while 1048 ran and 1049-1055 were pending.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicOutsideRead-queue-rows.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const queueStore = require('../../scheduler/queueStore.cjs');
const scheduler = require('../../../scheduler.cjs');
const { getEpicRecord } = require('../epicOutsideRead.cjs');

const tmpDirs = [];
let prevHome;

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-outside-rows-home-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function setupEpic(cwd, epicId) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({
    sessions: {
      [epicId]: {
        id: epicId,
        cwd,
        goalText: 'Batch Epic\n\nRun a batch.',
        claudeSessionId: `sess-${epicId}`,
        status: 'active',
        tag: 'feature',
        agentType: 'architect',
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    },
    events: {
      // One earlier PRD already checked in — the pre-fix record saw only this.
      [epicId]: [{ kind: 'response', prdSlug: '1047-first', validation: 'unvalidated', outcome: 'completed', at: '2026-11-02T00:00:00.000Z', text: 'ok' }],
    },
  }));
}

test('remote.listJobs rows carry epicId + sourcePromptId (null when absent)', async () => {
  vi.spyOn(queueStore, 'readMerged').mockResolvedValue({
    jobs: [
      { slug: '1-a', title: 'A', status: 'pending', cwd: '/p', epicId: 'e-1', sourcePromptId: 'e-1' },
      { slug: '2-b', title: 'B', status: 'pending', cwd: '/p' },
    ],
    config: {},
  });
  const rows = await scheduler.remote.listJobs();
  expect(rows).toEqual([
    { slug: '1-a', title: 'A', status: 'pending', cwd: '/p', agentType: null, epicId: 'e-1', sourcePromptId: 'e-1' },
    { slug: '2-b', title: 'B', status: 'pending', cwd: '/p', agentType: null, epicId: null, sourcePromptId: null },
  ]);
});

test('an Epic with batch-created queue rows reads working with matching pending/running counts', async () => {
  const cwd = await mkTmp('sm-outside-rows-cwd-');
  const epicId = 'f25f3d71';
  setupEpic(cwd, epicId);

  const raw = [
    { slug: '1048-run', title: 'run', status: 'running', cwd, epicId, sourcePromptId: epicId, agentType: 'dev-lead' },
    ...[1049, 1050, 1051, 1052, 1053, 1054].map((n) => (
      { slug: `${n}-step-${n}`, title: `step ${n}`, status: 'pending', cwd, epicId, sourcePromptId: epicId, agentType: 'dev-lead' }
    )),
    // A batch row with only sourcePromptId set still belongs to the Epic.
    { slug: '1055-validate', title: 'validate', status: 'pending', cwd, sourcePromptId: epicId, agentType: 'validator' },
    // Another Epic's row must not be counted.
    { slug: '2000-other', title: 'other', status: 'running', cwd, epicId: 'e-other', sourcePromptId: 'e-other' },
  ];
  vi.spyOn(queueStore, 'readMerged').mockResolvedValue({ jobs: raw, config: {} });

  const rec = await getEpicRecord(cwd, {
    id: epicId,
    projectRoots: () => [cwd],
    listJobs: () => scheduler.remote.listJobs(),
  });
  expect(rec).not.toBeNull();
  expect(rec.state).toBe('working');
  expect(rec.prds.running).toBe(1);
  expect(rec.prds.pending).toBe(7);
  expect(rec.prds.completed).toBe(1);
  expect(rec.prds.total).toBe(9);
});
