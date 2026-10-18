/**
 * runLogRetention.test.cjs — unit tests for src/main/lib/scheduler/runLogRetention.cjs.
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
  runningRunIdsFromJobs,
  isLiveJob,
  runBootSweep,
  DEFAULT_RUN_LOG_RETENTION,
} = require('../lib/scheduler/runLogRetention.cjs');

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

test('DEFAULT_RUN_LOG_RETENTION: enabled, 14 days, keep newest 3', () => {
  expect(DEFAULT_RUN_LOG_RETENTION).toEqual({ enabled: true, policy: { maxAgeDays: 14, keepPerSlug: 3 } });
});

test('applyRetention: absent setting applies the default policy — age alone decides; the newest run keeps only its meta', () => {
  const now = Date.now();
  const old = makeRun('2026-01-01T00-00-00-000Z', 'dflt-slug', { finishedAt: now - 20 * DAY_MS });
  const keep = [
    makeRun('2026-01-02T00-00-00-000Z', 'dflt-slug', { finishedAt: now - 19 * DAY_MS }),
    makeRun('2026-01-03T00-00-00-000Z', 'dflt-slug', { finishedAt: now - 18 * DAY_MS }),
    makeRun('2026-01-04T00-00-00-000Z', 'dflt-slug', { finishedAt: now - 17 * DAY_MS }),
  ];

  const result = applyRetention(runsDir, undefined, { now, jobs: [] });
  expect(result.deleted).toBe(true);
  expect(fs.existsSync(old)).toBe(false);
  // older non-newest runs lose everything
  expect(fs.existsSync(keep[0])).toBe(false);
  expect(fs.existsSync(keep[1])).toBe(false);
  // the slug's newest run loses bulk but keeps its meta
  expect(fs.existsSync(path.join(keep[2], 'dflt-slug.log'))).toBe(false);
  expect(fs.existsSync(path.join(keep[2], 'dflt-slug.meta.json'))).toBe(true);
});

test('applyRetention: explicit enabled=false is dry-run regardless of policy — nothing deleted', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 'old-slug', { finishedAt: now - 300 * DAY_MS });

  const settings = { schedulerRunLogRetention: { enabled: false, policy: { maxAgeDays: 30 } } };
  const result = applyRetention(runsDir, settings, { now });
  expect(result.deleted).toBe(false);
  expect(fs.readdirSync(runsDir).length).toBe(2);
});

test('isRetentionEnabled: requires enabled===true AND a non-empty policy', () => {
  expect(isRetentionEnabled(undefined)).toBe(true); // absent → built-in default
  expect(isRetentionEnabled({})).toBe(true);
  expect(isRetentionEnabled({ schedulerRunLogRetention: { enabled: false } })).toBe(false);
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

test('the only run of a slug past the age cap loses its bulk files but keeps .meta.json/.verdicts.json/.outcome.json', () => {
  const now = Date.now();
  const dir = makeRun('2018-01-01T00-00-00-000Z', 'lonely-slug', {
    finishedAt: now - 3000 * DAY_MS,
    extraFiles: ['lonely-slug.supervisor.json', 'lonely-slug.1.patch', 'root-cause-lonely-slug.md', 'lonely-slug.verdicts.json', 'lonely-slug.outcome.json'],
  });

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 1 } } };
  const result = applyRetention(runsDir, settings, { now, jobs: [] });
  expect(result.removedFiles).toBe(4);
  for (const f of ['lonely-slug.log', 'lonely-slug.supervisor.json', 'lonely-slug.1.patch', 'root-cause-lonely-slug.md']) {
    expect(fs.existsSync(path.join(dir, f))).toBe(false);
  }
  for (const f of ['lonely-slug.meta.json', 'lonely-slug.verdicts.json', 'lonely-slug.outcome.json']) {
    expect(fs.existsSync(path.join(dir, f))).toBe(true);
  }
});

test('a live needs_review run 60d old is untouched, even though it is the only run', () => {
  const now = Date.now();
  const dir = makeRun('2026-08-01T00-00-00-000Z', 'parked-slug', { finishedAt: now - 60 * DAY_MS });
  const jobs = [{ slug: 'parked-slug', runId: '2026-08-01T00-00-00-000Z', status: 'needs_review' }];
  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 14, keepPerSlug: 3 } } };
  const result = applyRetention(runsDir, settings, { now, jobs });
  expect(result.removedFiles).toBe(0);
  expect(fs.existsSync(path.join(dir, 'parked-slug.log'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'parked-slug.meta.json'))).toBe(true);
});

test('a needs_review job with no runId protects every run dir holding its log', () => {
  const now = Date.now();
  const dir = makeRun('2026-08-01T00-00-00-000Z', 'lost-parked', { finishedAt: now - 60 * DAY_MS });
  const jobs = [{ slug: 'lost-parked', runId: null, status: 'needs_review' }];
  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 14 } } };
  applyRetention(runsDir, settings, { now, jobs });
  expect(fs.existsSync(path.join(dir, 'lost-parked.log'))).toBe(true);
});

test('a dir holding only definition-of-done files older than maxAgeDays is removed; a young one survives', () => {
  const now = Date.now();
  const oldDir = path.join(runsDir, '2026-07-01T00-00-00-000Z');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'definition-of-done-abc12345.md');
  fs.writeFileSync(oldFile, 'dod\n');
  const t = (now - 40 * DAY_MS) / 1000;
  fs.utimesSync(oldFile, t, t);
  const youngDir = path.join(runsDir, '2026-10-17T00-00-00-000Z');
  fs.mkdirSync(youngDir, { recursive: true });
  fs.writeFileSync(path.join(youngDir, 'definition-of-done-def67890.md'), 'dod\n');

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 14 } } };
  const result = applyRetention(runsDir, settings, { now, jobs: [] });
  expect(fs.existsSync(oldDir)).toBe(false);
  expect(fs.existsSync(youngDir)).toBe(true);
  expect(result.removedFiles).toBe(1);
});

test('computeReport (dry-run) bytes equal applyRetention freedBytes, split by kind', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'rep-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-02-01T00-00-00-000Z', 'rep-slug', { finishedAt: now - 300 * DAY_MS });
  const dodDir = path.join(runsDir, '2020-03-01T00-00-00-000Z');
  fs.mkdirSync(dodDir, { recursive: true });
  const dod = path.join(dodDir, 'definition-of-done-aaaa1111.md');
  fs.writeFileSync(dod, 'dod report\n');
  const t = (now - 100 * DAY_MS) / 1000;
  fs.utimesSync(dod, t, t);

  const cfg = { enabled: true, policy: { maxAgeDays: 14 } };
  const report = computeReport(runsDir, cfg.policy, { now, liveKeys: new Set() });
  expect(report.eligibleSummary.bulkBytes).toBeGreaterThan(0);
  expect(report.eligibleSummary.metadataBytes).toBeGreaterThan(0);
  expect(report.eligibleSummary.bytes).toBe(report.eligibleSummary.bulkBytes + report.eligibleSummary.metadataBytes);

  const result = applyRetention(runsDir, { schedulerRunLogRetention: cfg }, { now, jobs: [] });
  expect(result.freedBytes).toBe(report.eligibleSummary.bytes);
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

test('with maxAgeDays set, keepPerSlug does not rescue an old run; with only keepPerSlug it still ranks', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 's', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-02-01T00-00-00-000Z', 's', { finishedAt: now - 300 * DAY_MS });
  makeRun('2020-03-01T00-00-00-000Z', 's', { finishedAt: now - 1 * DAY_MS }); // most recent, inside window

  const both = computeReport(runsDir, { maxAgeDays: 30, keepPerSlug: 3 }, { now });
  expect(both.eligible.map((e) => e.runId).sort()).toEqual(['2020-01-01T00-00-00-000Z', '2020-02-01T00-00-00-000Z']);
  const countOnly = computeReport(runsDir, { keepPerSlug: 3 }, { now });
  expect(countOnly.eligible.length).toBe(0);
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

  const queueStore = require('../lib/scheduler/queueStore.cjs');
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

// ─── runBootSweep: the one production caller ────────────────────────────────

test('runBootSweep: reads queueStore ONCE and threads its jobs explicitly into applyRetention (never the internal fallback re-read)', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'boot-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-02-01T00-00-00-000Z', 'boot-slug', { finishedAt: now - 390 * DAY_MS }); // live, protected
  makeRun('2026-01-01T00-00-00-000Z', 'boot-slug', { finishedAt: now - 1 * DAY_MS }); // most recent

  const queueStore = require('../lib/scheduler/queueStore.cjs');
  const original = queueStore.readMergedSync;
  let calls = 0;
  queueStore.readMergedSync = () => {
    calls += 1;
    if (calls === 1) {
      return {
        config: { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 7 } } },
        jobs: [{ slug: 'boot-slug', runId: '2020-02-01T00-00-00-000Z', status: 'running' }],
      };
    }
    // If applyRetention's internal fallback ever re-reads the store, this
    // second shape (no live jobs) would let the protected run be deleted —
    // proving runBootSweep did NOT thread jobs explicitly.
    return { config: {}, jobs: [] };
  };
  try {
    const result = runBootSweep({ now, runsDir });
    expect(calls).toBe(1); // proves applyRetention never fell back to its own re-read
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(path.join(runsDir, '2020-01-01T00-00-00-000Z'))).toBe(false); // eligible, removed
    expect(fs.existsSync(path.join(runsDir, '2020-02-01T00-00-00-000Z'))).toBe(true); // live, protected
    expect(fs.existsSync(path.join(runsDir, '2026-01-01T00-00-00-000Z'))).toBe(true); // most recent, protected
  } finally {
    queueStore.readMergedSync = original;
  }
});

test('runBootSweep: dry-run when config explicitly opts out', () => {
  const now = Date.now();
  makeRun('2020-01-01T00-00-00-000Z', 'noop-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2026-01-01T00-00-00-000Z', 'noop-slug', { finishedAt: now - 1 * DAY_MS });

  const queueStore = require('../lib/scheduler/queueStore.cjs');
  const original = queueStore.readMergedSync;
  queueStore.readMergedSync = () => ({ config: { schedulerRunLogRetention: { enabled: false } }, jobs: [] });
  try {
    const result = runBootSweep({ now, runsDir });
    expect(result.deleted).toBe(false);
    expect(fs.readdirSync(runsDir).length).toBe(2);
  } finally {
    queueStore.readMergedSync = original;
  }
});

test('runBootSweep: a deletion failure (permission error) is caught, logged in result.errors, and never thrown', () => {
  const now = Date.now();
  const dir = makeRun('2020-01-01T00-00-00-000Z', 'fail-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2026-01-01T00-00-00-000Z', 'fail-slug', { finishedAt: now - 1 * DAY_MS });

  const queueStore = require('../lib/scheduler/queueStore.cjs');
  const original = queueStore.readMergedSync;
  queueStore.readMergedSync = () => ({
    config: { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 7 } } },
    jobs: [],
  });

  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (p) => {
    if (String(p).startsWith(dir)) {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return originalUnlink(p);
  };

  try {
    expect(() => runBootSweep({ now, runsDir })).not.toThrow();
    const result = runBootSweep({ now, runsDir });
    expect(result.deleted).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  } finally {
    fs.unlinkSync = originalUnlink;
    queueStore.readMergedSync = original;
  }
});

// ─── orphan pass: empty run directories (PRD 1120) ─────────────────────────

test('runningRunIdsFromJobs: only status===running jobs with a runId are protected', () => {
  const ids = runningRunIdsFromJobs([
    { slug: 'a', status: 'running', runId: 'run-a' },
    { slug: 'b', status: 'pending', runId: 'run-b' },
    { slug: 'c', status: 'running', runId: null },
    null,
  ]);
  expect(ids.has('run-a')).toBe(true);
  expect(ids.has('run-b')).toBe(false);
  expect(ids.size).toBe(1);
});

test('applyRetention orphan pass: an empty run directory 1 minute old is removed while a directory with a .log is retained', () => {
  const now = Date.now();
  // Orphan: minted by pickRunDir but the dispatch aborted before executeJob
  // ever wrote into it — no meta.json, so scanRunEntries never sees it.
  const orphanDir = path.join(runsDir, '2026-09-05T14-00-00-000Z');
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphanTime = (now - 60_000) / 1000;
  fs.utimesSync(orphanDir, orphanTime, orphanTime);

  // Real run: has a .log, must survive regardless of the orphan pass.
  makeRun('2026-09-05T15-00-00-000Z', 'real-slug', { finishedAt: now - 60_000 });

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 7, keepPerSlug: 1 } } };
  const result = applyRetention(runsDir, settings, { now, jobs: [] });

  expect(result.orphanDirsRemoved).toBe(1);
  expect(fs.existsSync(orphanDir)).toBe(false);
  expect(fs.existsSync(path.join(runsDir, '2026-09-05T15-00-00-000Z', 'real-slug.log'))).toBe(true);
});

test('applyRetention orphan pass: skips an empty directory whose runId belongs to a currently-running job (spawn in flight)', () => {
  const now = Date.now();
  const inFlightRunId = '2026-09-05T16-00-00-000Z';
  const inFlightDir = path.join(runsDir, inFlightRunId);
  fs.mkdirSync(inFlightDir, { recursive: true });

  const settings = { schedulerRunLogRetention: { enabled: true, policy: { maxAgeDays: 7, keepPerSlug: 1 } } };
  const jobs = [{ slug: 'mid-dispatch', status: 'running', runId: inFlightRunId }];
  const result = applyRetention(runsDir, settings, { now, jobs });

  expect(result.orphanDirsRemoved).toBe(0);
  expect(fs.existsSync(inFlightDir)).toBe(true);
});

test('applyRetention orphan pass: never runs when retention is opted out (dry-run)', () => {
  const now = Date.now();
  const orphanDir = path.join(runsDir, '2020-01-01T00-00-00-000Z');
  fs.mkdirSync(orphanDir, { recursive: true });

  const result = applyRetention(runsDir, { schedulerRunLogRetention: { enabled: false } }, { now, jobs: [] });
  expect(result.deleted).toBe(false);
  expect(fs.existsSync(orphanDir)).toBe(true);
});

test('applyRetention: dry-run path (enabled=false) never reads queueStore for live protection', () => {
  const now = Date.now();
  makeRun('2020-05-01T00-00-00-000Z', 'no-touch-slug', { finishedAt: now - 400 * DAY_MS });
  makeRun('2020-06-01T00-00-00-000Z', 'no-touch-slug', { finishedAt: now - 1 * DAY_MS });

  const queueStore = require('../lib/scheduler/queueStore.cjs');
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
