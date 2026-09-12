/**
 * scheduler-quarantine-autoresolve.test.cjs
 *
 * Covers the bounded automatic exit for a quarantined row that never
 * received a `createdVia` provenance stamp (this PRD): the pure selector
 * `selectQuarantineAutoResolveTargets`, the async applier
 * `autoResolveQuarantine` (which re-reads the PRD file's frontmatter fresh
 * from disk immediately before transitioning, so it can never race
 * reconcile()'s own adopt path), and the kill switch
 * `quarantineAutoResolveDisabled`.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — same
 * reason as scheduler-failed-autoreset.test.cjs (appendAuditEvent writes
 * under $HOME/.claude/session-manager/audit-log.jsonl).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-quarantine-autoresolve.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-autoresolve-test-'));
process.env.HOME = tmpHome;

const {
  selectQuarantineAutoResolveTargets,
  autoResolveQuarantine,
  QUARANTINE_RESOLVE_CAP,
  quarantineAutoResolveDisabled,
} = require('../scheduler.cjs');

const MIN_MS = 60_000;
const THRESHOLD_MS = 60 * MIN_MS;

function quarantinedJob(overrides = {}) {
  return {
    slug: 'quarantined-row',
    cwd: '/home/user/project',
    status: 'quarantined',
    statusHistory: [{ to: 'quarantined', at: new Date(Date.now() - 90 * MIN_MS).toISOString() }],
    ...overrides,
  };
}

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerActiveProject(cwd);
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'test-epic-1', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  return { cwd, prdsDir };
}

// --- selectQuarantineAutoResolveTargets ---

test('a fresh quarantined row (under threshold) is not selected', () => {
  const job = quarantinedJob({
    statusHistory: [{ to: 'quarantined', at: new Date(Date.now() - 2 * MIN_MS).toISOString() }],
  });
  assert.equal(selectQuarantineAutoResolveTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('a non-quarantined status is never selected', () => {
  const job = quarantinedJob({ status: 'failed' });
  assert.equal(selectQuarantineAutoResolveTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('a quarantined row with no statusHistory entry cannot have its age proven, and is skipped', () => {
  const job = quarantinedJob({ statusHistory: [] });
  assert.equal(selectQuarantineAutoResolveTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('a quarantined row past threshold, under the cap, is selected', () => {
  const job = quarantinedJob({ quarantineResolveAttempts: 0 });
  const found = selectQuarantineAutoResolveTargets([job], Date.now(), THRESHOLD_MS);
  assert.equal(found.length, 1);
  assert.equal(found[0].slug, 'quarantined-row');
  assert.ok(found[0].ageMs >= 90 * MIN_MS - 1000);
});

test('a quarantined row that already spent its resolve cap is excluded', () => {
  const job = quarantinedJob({ quarantineResolveAttempts: QUARANTINE_RESOLVE_CAP });
  assert.equal(selectQuarantineAutoResolveTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('quarantineAutoResolveDisabled reflects SM_QUARANTINE_AUTORESOLVE_DISABLE', () => {
  const saved = process.env.SM_QUARANTINE_AUTORESOLVE_DISABLE;
  try {
    delete process.env.SM_QUARANTINE_AUTORESOLVE_DISABLE;
    assert.equal(quarantineAutoResolveDisabled(), false);
    process.env.SM_QUARANTINE_AUTORESOLVE_DISABLE = '1';
    assert.equal(quarantineAutoResolveDisabled(), true);
  } finally {
    if (saved === undefined) delete process.env.SM_QUARANTINE_AUTORESOLVE_DISABLE;
    else process.env.SM_QUARANTINE_AUTORESOLVE_DISABLE = saved;
  }
});

// --- autoResolveQuarantine: the applier ---

test('a quarantined row whose PRD file still has no createdVia is auto-resolved to skipped', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-quarantine-autoresolve-noprovenance-');
  try {
    fs.writeFileSync(
      path.join(prdsDir, 'quarantined-row.md'),
      `---\ntitle: Unstamped PRD\ncwd: ${cwd}\nestimateMinutes: 15\n---\n\n# Goal\nDo the thing.\n`,
      'utf8',
    );
    const job = quarantinedJob({ cwd, quarantineResolveAttempts: 0 });
    const outcome = await autoResolveQuarantine(job, 90 * MIN_MS);
    assert.equal(outcome, 'skipped');
    assert.equal(job.status, 'skipped');
    assert.equal(job.quarantineResolveAttempts, 1);
    assert.ok(typeof job.error === 'string' && /createdVia/.test(job.error));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a quarantined row whose PRD file HAS been stamped with createdVia is left alone — reconcile owns it now', async () => {
  const { cwd, prdsDir } = makeFixtureProject('sm-quarantine-autoresolve-stamped-');
  try {
    fs.writeFileSync(
      path.join(prdsDir, 'quarantined-row.md'),
      `---\ntitle: Stamped PRD\ncwd: ${cwd}\nestimateMinutes: 15\ncreatedVia: scheduler-api\nissuedAt: 2026-08-07T00:00:00.000Z\n---\n\n# Goal\nDo the thing.\n`,
      'utf8',
    );
    const job = quarantinedJob({ cwd, quarantineResolveAttempts: 0 });
    const outcome = await autoResolveQuarantine(job, 90 * MIN_MS);
    assert.equal(outcome, null);
    assert.equal(job.status, 'quarantined'); // untouched — the adopt path owns the next pass
    assert.equal(job.quarantineResolveAttempts, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('autoResolveQuarantine race-guards against a row that moved off quarantined', async () => {
  const job = quarantinedJob({ status: 'pending', quarantineResolveAttempts: 0 });
  assert.equal(await autoResolveQuarantine(job, 90 * MIN_MS), null);
  assert.equal(job.status, 'pending'); // untouched
});

test('autoResolveQuarantine race-guards against a row whose resolve cap is already spent', async () => {
  const job = quarantinedJob({ quarantineResolveAttempts: QUARANTINE_RESOLVE_CAP });
  assert.equal(await autoResolveQuarantine(job, 90 * MIN_MS), null);
  assert.equal(job.status, 'quarantined'); // untouched
});

test('a quarantined row whose PRD file is missing entirely is treated as still lacking provenance and auto-resolved', async () => {
  const job = quarantinedJob({ cwd: '/nonexistent/project/path', quarantineResolveAttempts: 0 });
  const outcome = await autoResolveQuarantine(job, 90 * MIN_MS);
  assert.equal(outcome, 'skipped');
  assert.equal(job.status, 'skipped');
});
