/**
 * prdRepairParked.test.cjs — PRD u9: let the planner repair a parked
 * (needs_review/failed) or skipped PRD, then reset it, without a race
 * between editing the spec and the job restarting.
 *
 * Covers:
 *  1. updatePrd now accepts a queue row in needs_review/failed/skipped (as
 *     well as the existing pending/quarantined) — a body patch and a
 *     frontmatter patch both land. It still refuses running/completed, with
 *     the new plain-word messages, and writes nothing in that case.
 *  2. resetRefusalMessage: one case per branch (completed, skipped, other),
 *     each with canForce true and false where that distinction matters.
 *  3. The repair recipe end to end: a needs_review row -> updatePrd with a
 *     new body -> resetJob -> the row is pending and the PRD file holds the
 *     new body.
 *
 * HOME-isolation + fixture-project pattern mirrors prdUpdateDependsOn.test.cjs.
 * Every slug used below is unique to its own test — scheduler.remote.getJob
 * matches by slug only (no cwd filter), so two tests racing the same slug
 * across two different fixture projects would be ambiguous.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdRepairParked.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let config;
let resetRefusalMessage;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-repair-parked-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
  config = require('../config.cjs');
  ({ resetRefusalMessage } = scheduler);

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), `${JSON.stringify({ cwd })}\n`);
}

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerActiveProject(cwd);
  // updatePrd writes through config.writeTextAtomic, which enforces
  // validatePath's allowed-write-root boundary (os.homedir() by default).
  config.addAllowedRoot(cwd);
  const opsRoot = path.join(cwd, 'session-manager-operations');
  const prdsDir = path.join(opsRoot, 'scheduler', 'epics', 'test-epic-1', 'prds');
  const stateDir = path.join(opsRoot, 'scheduler', 'state');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf8');
  queueStore.bustCwdCache();
  return { cwd, prdsDir, stateDir };
}

function writePrd(prdsDir, filename, cwd) {
  fs.writeFileSync(
    path.join(prdsDir, filename),
    `---\ntitle: ${filename}\ncwd: ${cwd}\nestimateMinutes: 10\ncreatedVia: scheduler-api\n---\n\n# Goal\nDo the thing.\n`,
    'utf8',
  );
}

/** Writes a single job row into the fixture project's queue.json. */
function writeQueueJob(stateDir, job) {
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [job] }, null, 2), 'utf8');
  queueStore.bustCwdCache();
}

// ---------- updatePrd status rule ----------

for (const status of ['needs_review', 'failed', 'skipped']) {
  test(`updatePrd accepts a body patch on a "${status}" row`, async () => {
    const slug = `5-fix-body-${status}`;
    const { cwd, prdsDir, stateDir } = makeFixtureProject(`sm-repair-${status}-body-`);
    try {
      writePrd(prdsDir, `${slug}.md`, cwd);
      writeQueueJob(stateDir, { slug, status, cwd, title: 'Fix me' });

      const result = await scheduler.remote.updatePrd({ slug, cwd, body: '# Goal\nDo the FIXED thing.\n' });

      expect(result.ok).toBe(true);
      const written = fs.readFileSync(path.join(prdsDir, `${slug}.md`), 'utf8');
      expect(written).toContain('Do the FIXED thing.');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`updatePrd accepts a frontmatter patch on a "${status}" row`, async () => {
    const slug = `5-fix-fm-${status}`;
    const { cwd, prdsDir, stateDir } = makeFixtureProject(`sm-repair-${status}-fm-`);
    try {
      writePrd(prdsDir, `${slug}.md`, cwd);
      writeQueueJob(stateDir, { slug, status, cwd, title: 'Fix me' });

      const result = await scheduler.remote.updatePrd({ slug, cwd, frontmatter: { estimateMinutes: 20 } });

      expect(result.ok).toBe(true);
      const written = fs.readFileSync(path.join(prdsDir, `${slug}.md`), 'utf8');
      expect(written).toMatch(/^estimateMinutes: 20$/m);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

const REFUSAL_CASES = [
  ['running', 'job status is "running" — wait for it to end, or stop it with scheduler_cancel_job, then edit it.'],
  ['completed', 'job status is "completed" — its work already landed. Queue a new PRD for more work.'],
];

for (const [status, expectedError] of REFUSAL_CASES) {
  test(`updatePrd refuses a "${status}" row with the plain-word message and writes nothing`, async () => {
    const slug = `5-fix-refuse-${status}`;
    const { cwd, prdsDir, stateDir } = makeFixtureProject(`sm-repair-${status}-refuse-`);
    try {
      writePrd(prdsDir, `${slug}.md`, cwd);
      writeQueueJob(stateDir, { slug, status, cwd, title: 'Fix me' });
      const before = fs.readFileSync(path.join(prdsDir, `${slug}.md`), 'utf8');

      const result = await scheduler.remote.updatePrd({ slug, cwd, body: '# Goal\nShould not land.\n' });

      expect(result).toEqual({ ok: false, error: expectedError });
      const after = fs.readFileSync(path.join(prdsDir, `${slug}.md`), 'utf8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ---------- resetRefusalMessage ----------

test('resetRefusalMessage: completed, canForce true names the force override', () => {
  expect(resetRefusalMessage('completed', { canForce: true })).toBe(
    'job already completed — resetting it would re-execute shipped work; archive the PRD instead, or pass force:true',
  );
});

test('resetRefusalMessage: completed, canForce false omits the force override', () => {
  expect(resetRefusalMessage('completed', { canForce: false })).toBe(
    'job already completed — resetting it would re-execute shipped work; archive the PRD instead',
  );
});

test('resetRefusalMessage: skipped, canForce true', () => {
  expect(resetRefusalMessage('skipped', { canForce: true })).toBe('job was skipped — pass force:true to run it again');
});

test('resetRefusalMessage: skipped, canForce false', () => {
  expect(resetRefusalMessage('skipped', { canForce: false })).toBe(
    'job was skipped — only scheduler_reset_job with force:true can run it again',
  );
});

test('resetRefusalMessage: any other status falls back to a generic message', () => {
  expect(resetRefusalMessage('quarantined', { canForce: true })).toBe('job status is "quarantined" — it cannot be reset now');
});

// ---------- repair recipe end to end ----------

test('repair recipe: needs_review row -> updatePrd new body -> resetJob -> pending with the new body on disk', async () => {
  const slug = '6-repair-me-e2e';
  const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-repair-e2e-');
  try {
    writePrd(prdsDir, `${slug}.md`, cwd);
    writeQueueJob(stateDir, { slug, status: 'needs_review', cwd, title: 'Repair me' });

    const updateResult = await scheduler.remote.updatePrd({ slug, cwd, body: '# Goal\nDo the REPAIRED thing.\n' });
    expect(updateResult.ok).toBe(true);

    const resetResult = await scheduler.remote.resetJob(slug, { cwd });
    expect(resetResult).toEqual({ ok: true, slug, status: 'pending' });

    const job = await scheduler.remote.getJob(slug);
    expect(job.status).toBe('pending');

    const written = fs.readFileSync(path.join(prdsDir, `${slug}.md`), 'utf8');
    expect(written).toContain('Do the REPAIRED thing.');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
