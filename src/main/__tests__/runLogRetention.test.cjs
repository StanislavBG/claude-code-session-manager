/**
 * runLogRetention.test.cjs — unit tests for src/main/lib/runLogRetention.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/runLogRetention.test.cjs
 *
 * Fixtures live under os.tmpdir() only — never the real
 * ~/.claude/session-manager/scheduled-plans/runs.
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  scanRunEntries,
  computeEligibility,
  computeReport,
  isRetentionEnabled,
  applyRetention,
  liveKeysFromJobs,
  isLiveJob,
} = require('../lib/runLogRetention.cjs');

let runsDir;

beforeEach(() => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-retention-test-'));
});

afterEach(() => {
  fs.rmSync(runsDir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRun(runId, slug, { finishedAt, extraFiles = [] } = {}) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.log`), 'log output\n');
  fs.writeFileSync(
    path.join(dir, `${slug}.meta.json`),
    JSON.stringify({ slug, exitCode: 0, finishedAt })
  );
  for (const name of extraFiles) {
    fs.writeFileSync(path.join(dir, name), 'extra\n');
  }
  return dir;
}

// ─── scanRunEntries ─────────────────────────────────────────────────────────

test('scanRunEntries: returns [] for a missing runsDir (never throws)', () => {
  const missing = path.join(runsDir, 'does-not-exist');
  expect(scanRunEntries(missing)).toEqual([]);
});

test('scanRunEntries: finds one entry per slug, even when a dir holds many slugs', () => {
  makeRun('2026-01-01T00-00-00-000Z', 'a-slug', { finishedAt: Date.now() });
  const dir = path.join(runsDir, '2026-01-01T00-00-00-000Z');
  fs.writeFileSync(path.join(dir, 'b-slug.log'), 'log\n');
  fs.writeFileSync(path.join(dir, 'b-slug.meta.json'), JSON.stringify({ finishedAt: Date.now() }));

  const entries = scanRunEntries(runsDir);
  expect(entries.map((e) => e.slug).sort()).toEqual(['a-slug', 'b-slug']);
  expect(entries.every((e) => e.files.length === 2)).toBe(true);
});

// ─── default is dry-run: nothing removed with no opt-in ────────────────────

test('applyRetention: DEFAULT (no settings) is dry-run — deletes nothing, regardless of how old the runs are', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 300 * DAY_MS });

  const result = applyRetention(runsDir, undefined, { now });
  expect(result.deleted).toBe(false);
  expect(result.removedFiles).toBeUndefined();
  expect(fs.readdirSync(runsDir).length).toBe(2);

  // The same data WOULD flag one eligible run once a real policy is computed
  // (this is what the human-facing report is built from) — proves the dry
  // run above wasn't a no-op because nothing was ever eligible.
  const withPolicy = computeReport(runsDir, { maxAgeDays: 30 }, { now });
  expect(withPolicy.eligible.length).toBeGreaterThan(0);
});

test('applyRetention: enabled=false is still dry-run regardless of policy', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 300 * DAY_MS });

  const settings = { schedulerRunLogRetention: { enabled: false, policy: { maxAgeDays: 30 } } };
  const result = applyRetention(runsDir, settings, { now });
  expect(result.deleted).toBe(false);
  expect(fs.readdirSync(runsDir).length).toBe(2);
});

test('isRetentionEnabled: requires enabled===true AND a non-empty policy', () => {
  expect(isRetentionEnabled(undefined)).toBe(false);
  expect(isRetentionEnabled({})).toBe(false);
  expect(isRetentionEnabled({ schedulerRunLogRetention: { enabled: true } })).toBe(false);
  expect(isRetentionEnabled({ schedulerRunLogRetention: { enabled: true, policy: {} } })).toBe(false);
  expect(
    isRetentionEnabled({ schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 30 } } })
  ).toBe(true);
  expect(
    isRetentionEnabled({ schedulerRunLogRetention: { enabled: 'true', policy: { maxAgeDays: 30 } } })
  ).toBe(false); // must be boolean true, not truthy
});

// ─── explicit opt-in actually deletes ───────────────────────────────────────

test('applyRetention: deletes ONLY when schedulerRunLogRetention.enabled===true plus a policy', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 400 * DAY_MS });
  const recentDir = makeRun('2020-06-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 1 * DAY_MS });

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 30 } } };
  const result = applyRetention(runsDir, settings, { now });

  expect(result.deleted).toBe(true);
  expect(result.removedFiles).toBeGreaterThan(0);
  // old, non-most-recent run's directory is gone entirely
  expect(fs.existsSync(path.join(runsDir, '2020-01-01T00-00-00-000Z'))).toBe(false);
  // most-recent run for the slug survives regardless of policy
  expect(fs.existsSync(recentDir)).toBe(true);
});

// ─── live-job protection ────────────────────────────────────────────────────

test('isLiveJob: pending/running/needs_review/investigating are live; completed/failed are not', () => {
  expect(isLiveJob({ status: 'pending' })).toBe(true);
  expect(isLiveJob({ status: 'running' })).toBe(true);
  expect(isLiveJob({ status: 'needs_review' })).toBe(true);
  expect(isLiveJob({ status: 'investigating' })).toBe(true);
  expect(isLiveJob({ status: 'completed' })).toBe(false);
  expect(isLiveJob({ status: 'failed' })).toBe(false);
  expect(isLiveJob(null)).toBe(false);
});

test('a run belonging to a needs_review job is NEVER eligible, regardless of age', () => {
  const now = Date.now();
  // Two runs of the same slug so the protected one is not simply "most recent".
  makeRun('2020-01-01T00-00-00-000Z', 'watched-slug', { finishedAt: now - 500 * DAY_MS });
  makeRun('2020-02-01T00-00-00-000Z', 'watched-slug', { finishedAt: now - 490 * DAY_MS }); // this one is live
  makeRun('2026-01-01T00-00-00-000Z', 'watched-slug', { finishedAt: now - 1 * DAY_MS }); // most recent

  const jobs = [{ slug: 'watched-slug', runId: '2020-02-01T00-00-00-000Z', status: 'needs_review' }];
  const liveKeys = liveKeysFromJobs(jobs);
  expect(liveKeys.has('watched-slug|2020-02-01T00-00-00-000Z')).toBe(true);

  const report = computeReport(runsDir, { maxAgeDays: 30 }, { now, liveKeys });
  const eligibleRunIds = report.eligible.map((e) => e.runId);
  expect(eligibleRunIds).toContain('2020-01-01T00-00-00-000Z'); // old, not live, not most-recent — eligible
  expect(eligibleRunIds).not.toContain('2020-02-01T00-00-00-000Z'); // live — protected
  expect(eligibleRunIds).not.toContain('2026-01-01T00-00-00-000Z'); // most recent — protected

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 30 } } };
  const result = applyRetention(runsDir, settings, { now, liveKeys });
  expect(fs.existsSync(path.join(runsDir, '2020-02-01T00-00-00-000Z'))).toBe(true);
});

test('queued/running jobs are also protected, same as needs_review', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'busy-slug', { finishedAt: now - 500 * DAY_MS });
  makeRun('2020-02-01T00-00-00-000Z', 'busy-slug', { finishedAt: now - 1 * DAY_MS }); // most recent, also running

  const jobs = [{ slug: 'busy-slug', runId: '2020-02-01T00-00-00-000Z', status: 'running' }];
  const liveKeys = liveKeysFromJobs(jobs);
  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 0 } } };
  const result = applyRetention(runsDir, settings, { now, liveKeys });

  // old one is eligible and removed (age 0 means "older than 0 days")
  expect(fs.existsSync(path.join(runsDir, '2020-01-01T00-00-00-000Z'))).toBe(false);
  // running one is protected even though its own age also clears the 0-day cap
  expect(fs.existsSync(path.join(runsDir, '2020-02-01T00-00-00-000Z'))).toBe(true);
});

// ─── most-recent-per-slug protection ────────────────────────────────────────

test('the most recent run for a slug is never eligible, even past the age cap', () => {
  const now = Date.now();
  makeRun('2018-01-01T00-00-00-000Z', 'lonely-slug', { finishedAt: now - 3000 * DAY_MS });

  const report = computeReport(runsDir, { maxAgeDays: 1 }, { now });
  expect(report.eligible.length).toBe(0);

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 1 } } };
  const result = applyRetention(runsDir, settings, { now });
  expect(result.removedFiles).toBe(0);
  expect(fs.existsSync(path.join(runsDir, '2018-01-01T00-00-00-000Z'))).toBe(true);
});

// ─── age + count combinability ──────────────────────────────────────────────

test('age-based policy: only entries older than maxAgeDays (and not most-recent) are eligible', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 's', { finishedAt: now - 90 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 's', { finishedAt: now - 10 * DAY_MS });
  makeRun('2020-09-01T00-00-00-000Z', 's', { finishedAt: now - 1 * DAY_MS }); // most recent

  const report = computeReport(runsDir, { maxAgeDays: 30 }, { now });
  expect(report.eligible.map((e) => e.runId)).toEqual(['2020-01-01T00-00-00-000Z']);
});

test('count-based policy: keeps the N most recent runs per slug, rest eligible', () => {
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const runId = `2020-0${i + 1}-01T00-00-00-000Z`;
    ids.push(runId);
    makeRun(runId, 'count-slug', { finishedAt: now - (5 - i) * DAY_MS });
  }

  const report = computeReport(runsDir, { keepPerSlug: 2 }, { now });
  // 5 runs, keep 2 most recent (ranks 0,1) -> 3 eligible (ranks 2,3,4)
  expect(report.eligible.length).toBe(3);
  const eligibleRunIds = new Set(report.eligible.map((e) => e.runId));
  expect(eligibleRunIds.has(ids[4])).toBe(false); // most recent
  expect(eligibleRunIds.has(ids[3])).toBe(false); // 2nd most recent, kept by count
  expect(eligibleRunIds.has(ids[0])).toBe(true);
});

test('age + count policies combine conservatively (AND): an entry needs both to be eligible', () => {
  const now = Date.now();
  // Old by age, but within the keepPerSlug=3 window (rank 1 of 3).
  makeRun('2020-01-01T00-00-00-000Z', 's', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-02-01T00-00-00-000Z', 's', { finishedAt: now - 300 * DAY_MS });
  makeRun('2020-03-01T00-00-00-000Z', 's', { finishedAt: now - 1 * DAY_MS }); // most recent

  const policy = { maxAgeDays: 30, keepPerSlug: 3 };
  const report = computeReport(runsDir, policy, { now });
  // Both are old enough by age, but keepPerSlug=3 keeps all 3 ranks (0,1,2) — none eligible.
  expect(report.eligible.length).toBe(0);
});

// ─── report surface: usage stats ────────────────────────────────────────────

test('computeReport: reports total bytes, dir count, and oldest run date', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'a', { finishedAt: now - 100 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 'b', { finishedAt: now - 10 * DAY_MS });

  const report = computeReport(runsDir, {}, { now });
  expect(report.usage.dirCount).toBe(2);
  expect(report.usage.runCount).toBe(2);
  expect(report.usage.totalBytes).toBeGreaterThan(0);
  expect(report.usage.oldestRunAt).toBe(now - 100 * DAY_MS);
  // no policy set -> nothing eligible, purely informational
  expect(report.eligible.length).toBe(0);
});

// ─── directory-level cleanup: partial dirs never fully removed ─────────────

test('a directory holding an unclaimed extra file is never in removableDirs, even if its own entry is eligible', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'shared-dir-slug', {
    finishedAt: now - 400 * DAY_MS,
    extraFiles: ['definition-of-done-abc12345.md'],
  });
  makeRun('2026-01-01T00-00-00-000Z', 'shared-dir-slug', { finishedAt: now - 1 * DAY_MS });

  const report = computeReport(runsDir, { maxAgeDays: 30 }, { now });
  expect(report.eligible.length).toBe(1);
  expect(report.removableDirs).toEqual([]);

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 30 } } };
  const result = applyRetention(runsDir, settings, { now });
  // the slug's own log+meta are removed...
  expect(fs.existsSync(path.join(runsDir, '2020-01-01T00-00-00-000Z', 'shared-dir-slug.log'))).toBe(false);
  // ...but the directory itself survives because of the unclaimed DoD report
  expect(fs.existsSync(path.join(runsDir, '2020-01-01T00-00-00-000Z'))).toBe(true);
  expect(fs.existsSync(path.join(runsDir, '2020-01-01T00-00-00-000Z', 'definition-of-done-abc12345.md'))).toBe(true);
});

test('a directory whose sole entry is eligible is fully removed (dir + files)', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'solo-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2026-01-01T00-00-00-000Z', 'solo-slug', { finishedAt: now - 1 * DAY_MS });

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 30 } } };
  applyRetention(runsDir, settings, { now });
  expect(fs.existsSync(path.join(runsDir, '2020-01-01T00-00-00-000Z'))).toBe(false);
});

// ─── liveKeysFromJobs: null-runId backfill (needs_review can lose its runId) ─

test('liveKeysFromJobs: backfills protection via a runsDir scan when a live job has lost its runId', () => {
  makeRun('2020-01-01T00-00-00-000Z', 'lost-slug', { finishedAt: Date.now() });
  const jobs = [{ slug: 'lost-slug', runId: null, status: 'needs_review' }];
  const keys = liveKeysFromJobs(jobs, { runsDir });
  expect(keys.has('lost-slug|2020-01-01T00-00-00-000Z')).toBe(true);
});

test('liveKeysFromJobs: without a runsDir hint, a live job with no runId yields no protection (documented limitation — callers should always pass runsDir)', () => {
  const jobs = [{ slug: 'lost-slug', runId: null, status: 'needs_review' }];
  expect(liveKeysFromJobs(jobs).size).toBe(0);
});

// ─── applyRetention: fail-safe fallback when the caller forgets liveKeys/jobs ─

test('applyRetention: enabled=true with no liveKeys/jobs falls back to reading the real scheduler queue (queueStore) instead of silently protecting nothing', () => {
  const now = Date.now();
  makeRun('2020-05-01T00-00-00-000Z', 'fallback-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 'fallback-slug', { finishedAt: now - 1 * DAY_MS }); // most recent, unrelated

  const queueStore = require('../lib/queueStore.cjs');
  const original = queueStore.readMergedSync;
  queueStore.readMergedSync = () => ({
    jobs: [{ slug: 'fallback-slug', runId: '2020-05-01T00-00-00-000Z', status: 'running' }],
  });
  try {
    const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 0 } } };
    applyRetention(runsDir, settings, { now }); // deliberately no liveKeys, no jobs
    expect(fs.existsSync(path.join(runsDir, '2020-05-01T00-00-00-000Z'))).toBe(true);
  } finally {
    queueStore.readMergedSync = original;
  }
});

test('applyRetention: dry-run path (enabled=false) never reads queueStore for live protection', () => {
  const now = Date.now();
  makeRun('2020-05-01T00-00-00-000Z', 'no-touch-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 'no-touch-slug', { finishedAt: now - 1 * DAY_MS });

  const queueStore = require('../lib/queueStore.cjs');
  const original = queueStore.readMergedSync;
  let called = false;
  queueStore.readMergedSync = () => {
    called = true;
    return { jobs: [] };
  };
  try {
    const settings = { schedulerRunLogRetention: { enabled: false, policy: { maxAgeDays: 0 } } };
    const result = applyRetention(runsDir, settings, { now });
    expect(result.deleted).toBe(false);
    expect(called).toBe(false);
  } finally {
    queueStore.readMergedSync = original;
  }
});
