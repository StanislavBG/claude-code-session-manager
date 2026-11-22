'use strict';

/**
 * scheduler-fixes-row.test.cjs — reconcile() copies a freshly discovered PRD's
 * `fixes` frontmatter onto its queue row (like isFixPlan), so the
 * validator-quality numbers read rows, never thousands of PRD files. The key
 * must survive a queue.json save + load (ScheduleJobSchema) and land on the
 * row's history.jsonl line.
 *
 * Run: npx vitest run src/main/__tests__/scheduler-fixes-row.test.cjs
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearMainModuleCache, registerActiveProject } = require('./_helpers/schedulerHarness.cjs');

const FIXES = [
  { prd: '3601-parse-verdict', missKind: 'missed-ac', reason: 'validator passed a missing test' },
  { prd: '3602-count-misses', missKind: 'regression', reason: 'broke the weekly rollup' },
];

describe('reconcile stamps fixes onto the queue row', () => {
  let tmpHome;
  let originalHome;
  let originalSchedHome;
  let projectCwd;
  let prdsDir;
  let scheduler;
  let queueStore;
  let queueHistory;

  beforeAll(() => {
    clearMainModuleCache();
    originalHome = process.env.HOME;
    originalSchedHome = process.env.SM_SCHEDULER_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fixes-row-'));
    process.env.HOME = tmpHome;
    process.env.SM_SCHEDULER_HOME = tmpHome;
    projectCwd = fs.mkdtempSync(path.join(tmpHome, 'project-'));
    registerActiveProject(projectCwd);
    prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'fixes-row-epic', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    scheduler = require('../scheduler.cjs');
    queueStore = require('../lib/scheduler/queueStore.cjs');
    queueHistory = require('../lib/scheduler/queueHistory.cjs');
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    if (originalSchedHome === undefined) delete process.env.SM_SCHEDULER_HOME;
    else process.env.SM_SCHEDULER_HOME = originalSchedHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writePrd(slug, extraFm) {
    const fm = [`title: ${slug}`, `cwd: ${projectCwd}`, 'createdVia: scheduler-api', ...extraFm];
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), `---\n${fm.join('\n')}\n---\n# Goal\n\nx\n`, 'utf8');
  }

  test('a PRD with fixes frontmatter gives a row carrying the same array; one without gives no key', async () => {
    const withSlug = `9101-fixes-with-${process.pid}`;
    const withoutSlug = `9102-fixes-without-${process.pid}`;
    writePrd(withSlug, [`fixes: ${JSON.stringify(FIXES)}`]);
    writePrd(withoutSlug, []);

    const state = { jobs: [] };
    await scheduler.reconcile(state);

    const withRow = state.jobs.find((j) => j.slug === withSlug);
    const withoutRow = state.jobs.find((j) => j.slug === withoutSlug);
    expect(withRow).toBeDefined();
    expect(withoutRow).toBeDefined();
    expect(withRow.fixes).toEqual(FIXES);
    expect(Object.prototype.hasOwnProperty.call(withoutRow, 'fixes')).toBe(false);

    // Survives a queue.json save and load through ScheduleJobSchema.
    const merged = queueStore.readMergedSync();
    merged.jobs = state.jobs;
    await queueStore.writeSplit(merged, projectCwd);
    const reloaded = queueStore.readMergedSync();
    expect(reloaded.invalidJobs).toEqual([]);
    const reWith = reloaded.jobs.find((j) => j.slug === withSlug);
    const reWithout = reloaded.jobs.find((j) => j.slug === withoutSlug);
    expect(reWith.fixes).toEqual(FIXES);
    expect(Object.prototype.hasOwnProperty.call(reWithout, 'fixes')).toBe(false);

    // A finished row's history.jsonl line keeps it.
    const finished = {
      ...reWith,
      status: 'completed',
      runId: 'run-fixes-1',
      finishedAt: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(),
      exitCode: 0,
    };
    const { toArchive } = queueHistory.partitionJobs([finished], Date.now());
    expect(toArchive.map((j) => j.slug)).toEqual([withSlug]);
    await queueHistory.appendHistory(toArchive);
    const historyPath = queueStore.projectHistoryPath(projectCwd);
    const line = fs.readFileSync(historyPath, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).find((e) => e.slug === withSlug);
    expect(line).toBeDefined();
    expect(line.fixes).toEqual(FIXES);
  });

  test('ScheduleJobSchema accepts and keeps fixes, and rejects a malformed entry', () => {
    const { ScheduleJobSchema } = require('../lib/scheduler/scheduleJobSchema.cjs');
    const ok = ScheduleJobSchema.safeParse({ slug: 's', status: 'pending', fixes: FIXES });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.fixes).toEqual(FIXES);
    const bad = ScheduleJobSchema.safeParse({ slug: 's', status: 'pending', fixes: [{ prd: 1 }] });
    expect(bad.success).toBe(false);
  });
});
