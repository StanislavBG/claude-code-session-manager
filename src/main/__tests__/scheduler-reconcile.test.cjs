'use strict';

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
const { clearMainModuleCache } = require('./_helpers/schedulerHarness.cjs');

describe("cwd-preserve", () => {
  beforeAll(() => { clearMainModuleCache(); });

  /**
   * scheduler-reconcile-cwd-preserve.test.cjs — regression test for the
   * data-loss bug found while chasing PRD 1218's test:unit gate: reconcile()
   * rebuilt a queue row's `cwd` unconditionally from its PRD's own
   * frontmatter (`cwd: p.cwd`) at all three of its row-construction sites. A
   * PRD file with no `cwd:` frontmatter key — every hand-written or legacy PRD,
   * and every fixture in this test suite before this fix — parses to
   * `p.cwd === undefined`, which nulled the row's real, already-correct `cwd`.
   * queueStore.writeSplit's `job.cwd || defaultCwd` bucketing then relocated
   * the row into schedulerBatch.cjs's DEFAULT_PROJECT_CWD shard
   * (`~/Projects/session-manager`) — the WRONG project — while the row's own
   * project's shard was rewritten without it. A PRD's frontmatter `cwd` must
   * REFINE a row's existing `cwd`, never erase one.
   *
   * Covers the normal refresh path (an existing row matched to its PRD) and
   * the fresh-discovery path (a PRD with no prior row, falling back to the
   * project root it was actually found under via
   * prdLocations.deriveProjectCwdFromPrdPath rather than nulling to
   * DEFAULT_PROJECT_CWD).
   *
   * Run: npx vitest run src/main/__tests__/scheduler-reconcile.test.cjs
   */

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { registerActiveProject } = require('./_helpers/schedulerHarness.cjs');

  let tmpHome;
  let originalHome;
  let reconcile;
  let DEFAULT_PROJECT_CWD;

  beforeAll(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-cwd-preserve-'));
    process.env.HOME = tmpHome;
    ({ reconcile } = require('../scheduler.cjs'));
    ({ DEFAULT_PROJECT_CWD } = require('../lib/schedulerBatch.cjs'));
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // allProjectCwds()/activeProjectCwds() (queueStore.cjs's stateCwds) discover
  // project cwds by scanning ~/.claude/projects/*/*.jsonl for a `cwd` field —
  // same pattern as scheduler-reap-dead-running-jobs.test.cjs and friends.
  test('reconcile() never nulls an existing row\'s cwd because its PRD has no cwd: frontmatter', async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-cwd-preserve-project-'));
    registerActiveProject(projectCwd);

    const slug = `1218-cwd-preserve-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    // Deliberately NO `cwd:` frontmatter key — the exact shape of every
    // hand-written or legacy PRD that triggered the bug.
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), '# Goal\n\nNo cwd frontmatter here.\n', 'utf8');

    const job = { slug, title: 'x', cwd: projectCwd, status: 'pending' };
    const state = { jobs: [job] };

    await reconcile(state);

    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.cwd).toBe(projectCwd);
    expect(row.cwd).not.toBe(DEFAULT_PROJECT_CWD);
  });

  test('reconcile() gives a freshly-discovered, frontmatter-less PRD the project root it was actually found under, never DEFAULT_PROJECT_CWD', async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-cwd-preserve-fresh-'));
    registerActiveProject(projectCwd);

    const slug = `1218-cwd-preserve-fresh-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), '# Goal\n\nNo cwd frontmatter here either.\n', 'utf8');

    // No prior row at all — this PRD is discovered fresh by reconcile()'s own
    // onDisk scan, not handed in via `state.jobs`.
    const state = { jobs: [] };

    await reconcile(state);

    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.cwd).toBe(projectCwd);
    expect(row.cwd).not.toBe(DEFAULT_PROJECT_CWD);
  });
});

describe("history-backfill", () => {
  beforeAll(() => { clearMainModuleCache(); });

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
   * Run: npx vitest run src/main/__tests__/scheduler-reconcile.test.cjs
   */

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { makeFixtureCwd: harnessMakeFixtureCwd } = require('./_helpers/schedulerHarness.cjs');

  const tmpDirs = [];

  const makeFixtureCwd = () => harnessMakeFixtureCwd('sm-reconcile-history-', tmpDirs);

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
});

describe("invalid-repair", () => {
  beforeAll(() => { clearMainModuleCache(); });

  /**
   * scheduler-reconcile-invalid-repair.test.cjs — end-to-end reproduction of
   * the 2026-08-07 1021/1022 incident: a queue.json row with `"status":
   * "queued"` (a value outside ScheduleJobStatus) sat unpicked for 4+ hours.
   *
   * queueStore.shapeJobs (scheduleJobSchema.cjs, landed by a prior PRD)
   * already quarantines such a row into `invalidJobs` on read rather than
   * passing it through — but reconcile() itself was still add-only (`if
   * (seen.has(slug)) continue`), so a quarantined row was never repaired, only
   * silently absent from state.jobs with no log of what its bad status had
   * been.
   *
   * This test exercises the real quarantine path (queueStore.shapeJobs on the
   * raw incident JSON) against a real on-disk PRD, runs the real reconcile(),
   * and asserts: computeStallSummary flags the PRE-repair state as stalled,
   * reconcile() repairs the row to 'pending', logs the repair at warn level,
   * and audits it.
   *
   * HOME-isolated (mirrors scheduler-prd-missing-skip.test.cjs): stub HOME to
   * a mkdtemp dir before requiring scheduler.cjs/queueStore.cjs, and register
   * the fixture project as "active" via a fake ~/.claude/projects transcript —
   * reconcile's PRD/history discovery (prdLocations.cjs, queueHistory.cjs)
   * only scans cwds it can find that way.
   *
   * Run: npx vitest run src/main/__tests__/scheduler-reconcile.test.cjs
   */

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { registerActiveProject } = require('./_helpers/schedulerHarness.cjs');

  let tmpHome;
  let originalHome;
  let scheduler;
  let queueStore;

  beforeAll(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-repair-home-'));
    process.env.HOME = tmpHome;

    scheduler = require('../scheduler.cjs');
    queueStore = require('../lib/queueStore.cjs');

    if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
      throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
    }
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFixtureProject(prefix) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    registerActiveProject(cwd);
    const opsRoot = path.join(cwd, 'session-manager-operations');
    const prdsDir = path.join(opsRoot, 'scheduler', 'prds');
    const stateDir = path.join(opsRoot, 'scheduler', 'state');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    return { cwd, prdsDir, stateDir };
  }

  test('reconcile() repairs a queue row with an invalid status back to pending, logs, and audits it', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-reconcile-repair-proj-');
    try {
      // Real on-disk PRD (its file location is the reconcile source of truth).
      fs.writeFileSync(
        path.join(prdsDir, '1021-fix-the-thing.md'),
        '---\ntitle: Fix the thing\ncwd: ' + cwd + '\nestimateMinutes: 15\n---\n\n# Goal\nFix it.\n',
        'utf8',
      );

      // The exact incident shape: a row whose status is 'queued', outside
      // ScheduleJobStatus entirely.
      const badRow = {
        slug: '1021-fix-the-thing',
        title: 'Fix the thing',
        cwd,
        status: 'queued',
        runId: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        error: null,
      };
      const queuePath = path.join(stateDir, 'queue.json');
      fs.writeFileSync(queuePath, JSON.stringify({ jobs: [badRow] }, null, 2), 'utf8');

      // Exercise the REAL quarantine gate (same one queueStore.readMerged runs
      // at boot/every IPC read) rather than hand-building invalidJobs.
      const { jobs, invalid } = queueStore.shapeJobs(fs.readFileSync(queuePath, 'utf8'), queuePath);
      expect(jobs.length).toBe(0); // the bad row never reaches state.jobs
      expect(invalid.length).toBe(1);
      expect(invalid[0].slug).toBe(badRow.slug);
      expect(invalid[0].row.status).toBe('queued');

      const state = { jobs, invalidJobs: invalid, paused: null };

      // Stall detector must flag the PRE-repair state: the queue holds a
      // (quarantined) job but nothing is running or pending and it isn't
      // paused — this is exactly the condition that was silent for 4+ hours.
      const preRepairStall = scheduler.computeStallSummary(state);
      expect(preRepairStall.stalled).toBe(true);
      expect(preRepairStall.total).toBe(1);
      expect(preRepairStall.running).toBe(0);
      expect(preRepairStall.pending).toBe(0);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // scheduler.cjs destructures `appendAuditEvent` out of auditLog.cjs at
      // require time, so spying on the module's export property after the
      // fact wouldn't intercept scheduler.cjs's already-bound reference —
      // assert against the real (tmpHome-isolated) audit log file instead.
      const { auditLogPath } = require('../lib/auditLog.cjs');
      expect(auditLogPath().startsWith(tmpHome)).toBe(true);

      queueStore.bustCwdCache();
      await scheduler.reconcile(state);

      const repaired = state.jobs.find((j) => j.slug === badRow.slug);
      expect(repaired).toBeDefined();
      expect(repaired.status).toBe('pending');

      const warnedRepair = warnSpy.mock.calls.some((args) =>
        String(args[0]).includes('repaired invalid queue row') && String(args[0]).includes(badRow.slug),
      );
      expect(warnedRepair).toBe(true);

      const auditLines = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const auditedRepair = auditLines.some(
        (rec) => rec.kind === 'scheduler_row_repaired' && rec.slug === badRow.slug && rec.oldStatus === 'queued',
      );
      expect(auditedRepair).toBe(true);

      // Post-repair, the same condition must no longer read as stalled.
      const postRepairStall = scheduler.computeStallSummary(state);
      expect(postRepairStall.stalled).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reconcile() does not resurrect an invalid row whose slug already has a terminal history record', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-reconcile-repair-done-');
    try {
      fs.writeFileSync(
        path.join(prdsDir, '1022-already-done.md'),
        '---\ntitle: Already done\ncwd: ' + cwd + '\nestimateMinutes: 15\n---\n\n# Goal\nDone.\n',
        'utf8',
      );

      const badRow = {
        slug: '1022-already-done',
        title: 'Already done',
        cwd,
        status: 'queued',
        runId: 'run-xyz',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        error: null,
      };
      const queuePath = path.join(stateDir, 'queue.json');
      fs.writeFileSync(queuePath, JSON.stringify({ jobs: [badRow] }, null, 2), 'utf8');

      const { jobs, invalid } = queueStore.shapeJobs(fs.readFileSync(queuePath, 'utf8'), queuePath);
      expect(invalid.length).toBe(1);

      const state = { jobs, invalidJobs: invalid, paused: null };

      // A terminal record already exists for this slug — reconcile must never
      // repair the corrupted row back into a runnable 'pending' state on top
      // of already-shipped work.
      fs.writeFileSync(
        path.join(stateDir, 'history.jsonl'),
        JSON.stringify({ slug: badRow.slug, status: 'completed', finishedAt: new Date().toISOString(), runId: 'run-xyz' }) + '\n',
        'utf8',
      );

      queueStore.bustCwdCache();
      await scheduler.reconcile(state);

      expect(state.jobs.find((j) => j.slug === badRow.slug)).toBeUndefined();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("quarantine", () => {
  beforeAll(() => { clearMainModuleCache(); });

  /**
   * scheduler-reconcile-quarantine.test.cjs — PRD-authoring-lockdown provenance
   * gate: reconcile() must never turn a discovered PRD with no `createdVia`
   * frontmatter into a runnable 'pending' queue row. It quarantines it instead
   * (a distinct, non-runnable status), logs a warning naming the file, and
   * audits the event — then, once the file is stamped (the Scheduler tab's
   * "adopt PRD" action / scheduler_update_prd, both routed through
   * remote.updatePrd), promotes the row to 'pending' on the very next pass.
   *
   * Mirrors scheduler-reconcile-invalid-repair.test.cjs's HOME-isolation setup.
   *
   * Run: npx vitest run src/main/__tests__/scheduler-reconcile.test.cjs
   */

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { registerActiveProject } = require('./_helpers/schedulerHarness.cjs');

  let tmpHome;
  let originalHome;
  let scheduler;
  let queueStore;

  beforeAll(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-quarantine-home-'));
    process.env.HOME = tmpHome;

    scheduler = require('../scheduler.cjs');
    queueStore = require('../lib/queueStore.cjs');

    if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
      throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
    }
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFixtureProject(prefix) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    registerActiveProject(cwd);
    const opsRoot = path.join(cwd, 'session-manager-operations');
    // Epic-scoped, not the retired flat dir: a flat PRD with no live queue row
    // gets swept into prds-archived/ by reconcile()'s own consolidation pass
    // (see consolidateAllFlatPrds) BEFORE it's ever scanned as a discoverable
    // PRD — exactly the scenario every test below needs to observe, so the
    // flat layout would race the very thing under test.
    const prdsDir = path.join(opsRoot, 'scheduler', 'epics', 'test-epic-1', 'prds');
    const stateDir = path.join(opsRoot, 'scheduler', 'state');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    return { cwd, prdsDir, stateDir };
  }

  test('reconcile() quarantines a newly-discovered PRD with no createdVia provenance', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-quarantine-new-');
    try {
      fs.writeFileSync(
        path.join(prdsDir, '9001-hand-written.md'),
        `---\ntitle: Hand-written PRD\ncwd: ${cwd}\nestimateMinutes: 15\n---\n\n# Goal\nDo the thing.\n`,
        'utf8',
      );
      fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { auditLogPath } = require('../lib/auditLog.cjs');

      queueStore.bustCwdCache();
      const state = { jobs: [], invalidJobs: [], paused: null };
      await scheduler.reconcile(state);

      const row = state.jobs.find((j) => j.slug === '9001-hand-written');
      expect(row).toBeDefined();
      expect(row.status).toBe('quarantined');

      const warned = warnSpy.mock.calls.some((args) =>
        String(args[0]).includes('quarantining unstamped PRD') && String(args[0]).includes('9001-hand-written'),
      );
      expect(warned).toBe(true);

      const auditLines = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(auditLines.some((rec) => rec.kind === 'prd_quarantined' && rec.slug === '9001-hand-written')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reconcile() queues a newly-discovered PRD stamped with createdVia as pending, not quarantined', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-quarantine-stamped-');
    try {
      fs.writeFileSync(
        path.join(prdsDir, '9002-api-written.md'),
        `---\ntitle: API-written PRD\ncwd: ${cwd}\nestimateMinutes: 15\ncreatedVia: scheduler-api\nissuedAt: 2026-08-07T00:00:00.000Z\n---\n\n# Goal\nDo the thing.\n`,
        'utf8',
      );
      fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');

      queueStore.bustCwdCache();
      const state = { jobs: [], invalidJobs: [], paused: null };
      await scheduler.reconcile(state);

      const row = state.jobs.find((j) => j.slug === '9002-api-written');
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reconcile() exempts a fix-plan PRD (NN-fix-*) from quarantine even with no createdVia', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-quarantine-fixplan-');
    try {
      fs.writeFileSync(
        path.join(prdsDir, '9003-fix-something.md'),
        `---\ntitle: Fix something\ncwd: ${cwd}\nestimateMinutes: 15\n---\n\n# Goal\nHeal it.\n`,
        'utf8',
      );
      fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');

      queueStore.bustCwdCache();
      const state = { jobs: [], invalidJobs: [], paused: null };
      await scheduler.reconcile(state);

      const row = state.jobs.find((j) => j.slug === '9003-fix-something');
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reconcile() does NOT stamp investigationDepth for a createdVia-stamped PRD whose slug merely starts with "fix-" (PRD 1126/1131 regression)', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-quarantine-fake-fixplan-');
    try {
      // Mirrors PRD 1126: authored via scheduler_create_prd (createdVia stamped),
      // slug happens to kebab-case into "fix-..." — must NOT be treated as a
      // genuine scheduler-authored fix plan just because the name matches.
      fs.writeFileSync(
        path.join(prdsDir, '9005-fix-plan-death-reopens-parent.md'),
        `---\ntitle: Fix plan death reopens parent\ncwd: ${cwd}\nestimateMinutes: 15\ncreatedVia: scheduler-api\nissuedAt: 2026-08-07T00:00:00.000Z\n---\n\n# Goal\nDo the thing.\n`,
        'utf8',
      );
      fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');

      queueStore.bustCwdCache();
      const state = { jobs: [], invalidJobs: [], paused: null };
      await scheduler.reconcile(state);

      const row = state.jobs.find((j) => j.slug === '9005-fix-plan-death-reopens-parent');
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
      expect(row.isFixPlan).toBe(false);
      expect(row.investigationDepth).toBeUndefined();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reconcile() stamps isFixPlan + investigationDepth for a genuine spawnInvestigation-authored fix plan (explicit isFixPlan:true, no createdVia)', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-quarantine-genuine-fixplan-');
    try {
      fs.writeFileSync(
        path.join(prdsDir, '9006-fix-something.md'),
        `---\ntitle: Fix something\ncwd: ${cwd}\nestimateMinutes: 15\nisFixPlan: true\n---\n\n# Goal\nHeal it.\n`,
        'utf8',
      );
      fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');

      queueStore.bustCwdCache();
      const state = { jobs: [], invalidJobs: [], paused: null };
      await scheduler.reconcile(state);

      const row = state.jobs.find((j) => j.slug === '9006-fix-something');
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');
      expect(row.isFixPlan).toBe(true);
      expect(row.investigationDepth).toBe(2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reconcile() adopts a quarantined row to pending once its PRD file is stamped', async () => {
    const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-quarantine-adopt-');
    try {
      const prdPath = path.join(prdsDir, '9004-adopt-me.md');
      fs.writeFileSync(
        prdPath,
        `---\ntitle: Adopt me\ncwd: ${cwd}\nestimateMinutes: 15\n---\n\n# Goal\nAdopt.\n`,
        'utf8',
      );
      const quarantinedRow = {
        slug: '9004-adopt-me',
        title: 'Adopt me',
        cwd,
        status: 'quarantined',
        runId: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        error: null,
      };
      fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [quarantinedRow] }, null, 2), 'utf8');

      // Simulate the adopt action: stamp the file via the same update-prd
      // logic the IPC handler/admin route call (parsePrdFile/serializePrdFile
      // round-trip), rather than hand-writing raw text, to exercise the real
      // round-trip path this feature depends on.
      const { parsePrdFile, serializePrdFile } = require('../lib/prdFrontmatter.cjs');
      const raw = fs.readFileSync(prdPath, 'utf8');
      const { frontmatter: fm, body } = parsePrdFile(raw);
      fm.createdVia = 'legacy-adopted';
      fm.issuedAt = '2026-08-07T01:00:00.000Z';
      fs.writeFileSync(prdPath, serializePrdFile(fm, body), 'utf8');

      const { auditLogPath } = require('../lib/auditLog.cjs');
      queueStore.bustCwdCache();
      const state = { jobs: [quarantinedRow], invalidJobs: [], paused: null };
      await scheduler.reconcile(state);

      const row = state.jobs.find((j) => j.slug === '9004-adopt-me');
      expect(row).toBeDefined();
      expect(row.status).toBe('pending');

      const auditLines = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(auditLines.some((rec) => rec.kind === 'scheduler_prd_adopted' && rec.slug === '9004-adopt-me')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
