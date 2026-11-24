/**
 * scheduler-reconcile-voice-id.test.cjs — a PRD's `voiceId` frontmatter must
 * survive every scheduler.cjs site that copies it beside `effort`. The voice
 * env test (scheduler-job-voice-env.test.cjs) builds its row by hand from
 * parsePrd; this one runs the REAL reconcile() / listPrdsInternal() against
 * real PRD files in a temp HOME + SM_SCHEDULER_HOME and checks the row.
 *
 * Sites covered (scheduler.cjs, `voiceId:` next to `effort:`):
 *   - reconcile() fresh-discovery entry      `voiceId: p.voiceId ?? null`
 *   - reconcile() existing-row refresh       `voiceId: p.voiceId ?? job.voiceId ?? null`
 *   - reconcile() invalid-row repair pass    `voiceId: p.voiceId ?? inv.row?.voiceId ?? null`
 *   - listPrdsInternal() PRD list entry      `voiceId: parsed.voiceId ?? null`
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reconcile-voice-id.test.cjs
 */

'use strict';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clearMainModuleCache, registerActiveProject } = require('./_helpers/schedulerHarness.cjs');

describe('reconcile copies voiceId onto the queue row', () => {
  let tmpHome;
  let originalHome;
  let originalSchedulerHome;
  let scheduler;
  let queueStore;
  const tmpDirs = [];

  beforeAll(() => {
    clearMainModuleCache();
    originalHome = process.env.HOME;
    originalSchedulerHome = process.env.SM_SCHEDULER_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-voice-id-home-'));
    process.env.HOME = tmpHome;
    process.env.SM_SCHEDULER_HOME = tmpHome;
    scheduler = require('../scheduler.cjs');
    queueStore = require('../lib/scheduler/queueStore.cjs');
    if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
      throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    if (originalSchedulerHome === undefined) delete process.env.SM_SCHEDULER_HOME;
    else process.env.SM_SCHEDULER_HOME = originalSchedulerHome;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // A fixture project registered as active, with one PRD in an Epic dir.
  function writePrd(frontmatterLines) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-voice-id-proj-'));
    tmpDirs.push(cwd);
    registerActiveProject(cwd);
    queueStore.bustCwdCache();
    const slug = `4134-voice-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    const lines = ['title: Voice id', `cwd: ${cwd}`, 'effort: high', ...frontmatterLines];
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), `---\n${lines.join('\n')}\n---\n\n# Goal\nCarry the voice.\n`, 'utf8');
    return { cwd, slug };
  }

  // Covers the fresh-discovery entry (`voiceId: p.voiceId ?? null`).
  test('a freshly discovered PRD with voiceId: bilko yields a row with voiceId bilko', async () => {
    const { slug } = writePrd(['voiceId: bilko']);
    const state = { jobs: [] };
    await scheduler.reconcile(state);
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.effort).toBe('high');
    expect(row.voiceId).toBe('bilko');
  });

  // Covers the fresh-discovery entry (`voiceId: p.voiceId ?? null`), no-voice case.
  test('a freshly discovered PRD without voiceId yields a null/absent voiceId', async () => {
    const { slug } = writePrd([]);
    const state = { jobs: [] };
    await scheduler.reconcile(state);
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.voiceId ?? null).toBeNull();
  });

  // Covers the existing-row refresh (`voiceId: p.voiceId ?? job.voiceId ?? null`): the PRD's voiceId wins
  // over the row's stale one.
  test('refreshing an existing row takes voiceId from the PRD', async () => {
    const { cwd, slug } = writePrd(['voiceId: bilko']);
    const state = { jobs: [{ slug, title: 'x', cwd, status: 'pending', voiceId: 'stale_voice' }] };
    await scheduler.reconcile(state);
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.effort).toBe('high');
    expect(row.voiceId).toBe('bilko');
  });

  // Covers the existing-row refresh (`voiceId: p.voiceId ?? job.voiceId ?? null`), no-voice case.
  test('refreshing an existing row for a PRD without voiceId leaves voiceId null', async () => {
    const { cwd, slug } = writePrd([]);
    const state = { jobs: [{ slug, title: 'x', cwd, status: 'pending' }] };
    await scheduler.reconcile(state);
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.voiceId ?? null).toBeNull();
  });

  // Covers the invalid-row repair pass (`voiceId: p.voiceId ?? inv.row?.voiceId ?? null`), driven through the real
  // queueStore.shapeJobs quarantine gate.
  test('repairing a quarantined invalid row takes voiceId from the PRD', async () => {
    const { cwd, slug } = writePrd(['voiceId: bilko']);
    const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const queuePath = path.join(stateDir, 'queue.json');
    const badRow = { slug, title: 'x', cwd, status: 'queued', runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null };
    fs.writeFileSync(queuePath, JSON.stringify({ jobs: [badRow] }, null, 2), 'utf8');
    const { jobs, invalid } = queueStore.shapeJobs(fs.readFileSync(queuePath, 'utf8'), queuePath);
    expect(invalid.length).toBe(1);
    const state = { jobs, invalidJobs: invalid, paused: null };
    queueStore.bustCwdCache();
    await scheduler.reconcile(state);
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.status).toBe('pending');
    expect(row.effort).toBe('high');
    expect(row.voiceId).toBe('bilko');
  });

  // Covers listPrdsInternal's list entry (`voiceId: parsed.voiceId ?? null`).
  test('listPrdsInternal reports voiceId from the PRD file, null without it', async () => {
    const voiced = writePrd(['voiceId: bilko']);
    const plain = writePrd([]);
    const voicedList = await scheduler.listPrdsInternal({ cwd: voiced.cwd });
    const plainList = await scheduler.listPrdsInternal({ cwd: plain.cwd });
    const v = voicedList.find((e) => e.slug === voiced.slug);
    const p = plainList.find((e) => e.slug === plain.slug);
    expect(v).toBeDefined();
    expect(v.effort).toBe('high');
    expect(v.voiceId).toBe('bilko');
    expect(p).toBeDefined();
    expect(p.voiceId ?? null).toBeNull();
  });
});
