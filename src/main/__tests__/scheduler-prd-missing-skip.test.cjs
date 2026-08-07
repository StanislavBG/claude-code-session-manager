/**
 * scheduler-prd-missing-skip.test.cjs — regression test for PRD 812's
 * failure-classification fix: a queued job whose PRD source has disappeared
 * between enqueue and dispatch (e.g. a test fixture that leaked into the
 * live queue and was cleaned up before the job ran) must be retired as a
 * stale row (exitCode: 0, skipped: 'prd-missing'), not treated as a hard
 * job failure (exitCode: -1). A genuinely unreadable/unparseable PRD (a
 * real, non-ENOENT error) must still fail with exitCode: -1.
 *
 * HOME-isolated per the same incident: stub HOME to a mkdtemp dir before
 * requiring scheduler.cjs, and never write into the real scheduler root.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-prd-missing-skip.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let executeJob;
let spawnJob;
let PRDS_DIR;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-missing-skip-'));
  process.env.HOME = tmpHome;

  ({ executeJob, spawnJob, PRDS_DIR } = require('../scheduler.cjs'));

  if (!PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('a job whose PRD source is gone everywhere is retired, not failed', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-missing-project-'));
  // config.cjs's writeJsonSync (used for the job's meta.json) restricts
  // writes to WRITE_PREFIXES, which includes `<home>/.claude` — so runDir
  // must live under the stubbed tmpHome's .claude/, not the system tmpdir.
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-prd-missing-run-'));
  try {
    const slug = `812-test-missing-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const job = { slug, cwd: projectCwd };

    const result = await executeJob(job, runDir, projectCwd, () => {});

    expect(result.exitCode).toBe(0);
    expect(result.skipped).toBe('prd-missing');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('a job whose PRD source exists but is unreadable for a non-ENOENT reason still fails', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-toobig-project-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-prd-toobig-run-'));
  try {
    const slug = `812-test-toobig-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    // parsePrd rejects any PRD over 1MB with a plain Error (no .code) — this
    // is the "found but unparseable" case, distinct from ENOENT, and must
    // stay a real failure.
    const oversized = '---\ntitle: too big\n---\n\n' + 'x'.repeat(1024 * 1024 + 1);
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), oversized, 'utf8');

    const job = { slug, cwd: projectCwd };
    const result = await executeJob(job, runDir, projectCwd, () => {});

    expect(result.exitCode).toBe(-1);
    expect(result.skipped).toBeUndefined();
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

// This is the actual regression case: PRD 812's fix only covered executeJob's
// own return value. The bug lived one layer up, in spawnJob's post-run
// handler, which only short-circuited on skipped === 'prd-archived' and let
// 'prd-missing' fall through into the verify path meant for real runs —
// downgrading a stale-queue-entry retire into a needs_review with a bogus RCA
// feedback item. Drive spawnJob itself (not just executeJob) so this covers
// the actual defect, not just the classification it depends on.
test("spawnJob's post-run handler retires a prd-missing skip as a plain completion, without running verify", async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-missing-spawnjob-project-'));
  registerActiveProject(projectCwd);
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-prd-missing-spawnjob-run-'));
  try {
    const slug = `812-test-spawnjob-missing-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const queuePath = writeProjectQueue(projectCwd, [
      { slug, status: 'pending', cwd: projectCwd },
    ]);

    const job = { slug, cwd: projectCwd };
    await spawnJob(job, 'run-spawnjob-missing', runDir, projectCwd);

    const state = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    const row = state.jobs.find((j) => j.slug === slug);
    expect(row).toBeDefined();
    expect(row.status).toBe('completed');
    expect(row.exitCode).toBe(0);
    expect(row.error).toBeNull();
    // No verify pass ran and no RCA feedback fired: a verified run always
    // stamps a verify-derived status ('needs_review') or a landedCommit/verify
    // field onto the row. Neither is present here — the row was completed by
    // the early-return skip branch, not the verification block further down.
    expect(row.status).not.toBe('needs_review');
    expect(row.landedCommit).toBeUndefined();
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
