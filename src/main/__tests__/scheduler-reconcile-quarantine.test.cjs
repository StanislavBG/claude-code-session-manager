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
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reconcile-quarantine.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

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
    const { AUDIT_LOG_PATH } = require('../lib/auditLog.cjs');

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

    const auditLines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
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

    const { AUDIT_LOG_PATH } = require('../lib/auditLog.cjs');
    queueStore.bustCwdCache();
    const state = { jobs: [quarantinedRow], invalidJobs: [], paused: null };
    await scheduler.reconcile(state);

    const row = state.jobs.find((j) => j.slug === '9004-adopt-me');
    expect(row).toBeDefined();
    expect(row.status).toBe('pending');

    const auditLines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(auditLines.some((rec) => rec.kind === 'scheduler_prd_adopted' && rec.slug === '9004-adopt-me')).toBe(true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
