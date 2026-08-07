'use strict';

/**
 * runLogRetention.cjs — computes (and, only when explicitly opted in,
 * applies) a retention policy over `scheduled-plans/runs/`.
 *
 * That directory is a machine-level Session-Manager runtime artifact store
 * (execution logs of the scheduler's own `claude -p` runs), not anything
 * governed by the per-project single-writer law in opsOwnership.cjs — see
 * queueStore.cjs's header comment, which draws the same line for
 * scheduler-machine.json.
 *
 * Directory shape: one subdirectory per tick (`RUNS_DIR/<iso-ts>/`, minted by
 * scheduler.cjs's pickRunDir), which commonly holds MANY different PRD
 * slugs' artifacts side by side — `<slug>.log`, `<slug>.meta.json`, and an
 * optional `root-cause-<slug>.md` (rcaReport.cjs) per slug. Retention is
 * therefore computed per (runId, slug) ENTRY, not per directory: a directory
 * is only "fully removable" once every entry it holds is independently
 * eligible AND every file physically present in it is claimed by one of
 * those entries. Definition-of-done reports
 * (`definition-of-done-<batchKey>.md`, definitionOfDone.cjs) are keyed by a
 * hash of a job batch, not a single slug, so they are deliberately left
 * unclaimed by any entry — their presence in a directory blocks that
 * directory from being fully removed, but never blocks removal of a claimed
 * slug's own files.
 *
 * SAFETY MODEL (the point of this module — see the PRD that added it):
 *   - Nothing is ever deleted unless the caller passes settings with
 *     `schedulerRunLogRetention.enabled === true` AND a non-empty policy.
 *     Everywhere else (computeReport, and applyRetention with no opt-in)
 *     this module only READS the filesystem.
 *   - An entry belonging to a job that is currently live — status `pending`
 *     (queued), `running`, `needs_review`, or `investigating` (the exact
 *     literals scheduler.cjs uses; see LIVE_STATUSES) — is never eligible,
 *     regardless of age or count policy.
 *   - The most recent entry for any given slug is never eligible, even past
 *     an age cap — every PRD keeps at least its latest evidence.
 *   - Age and count policies are COMBINABLE and combine conservatively
 *     (AND): when both are set, an entry must clear both floors to be
 *     eligible. A policy is a safety floor, not a removal trigger — setting
 *     one dimension should never make the other one weaker.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_RUNS_DIR = path.join(
  os.homedir(),
  '.claude', 'session-manager', 'scheduled-plans', 'runs'
);

// Any status that is not yet a terminal outcome. Mirrors the status literals
// used throughout scheduler.cjs (see e.g. its DOD_SLUG_RE-adjacent status
// checks) — 'completed' and 'failed' are the only terminal ones.
const LIVE_STATUSES = new Set(['pending', 'running', 'needs_review', 'investigating']);

const META_SUFFIX = '.meta.json';
const DAY_MS = 24 * 60 * 60 * 1000;

function isLiveJob(job) {
  return !!job && LIVE_STATUSES.has(job.status);
}

/**
 * Build the `${slug}|${runId}` protection set from a scheduler job list
 * (queueStore.readMergedSync().jobs, or any array with the same shape). Jobs
 * with no runId yet (never started) have no run directory to protect.
 *
 * A `needs_review` job can lose its `runId` (an old queue-schema gap —
 * scheduler.cjs's own `resolveRunId` backfill exists for the same reason)
 * while a run directory for its slug still exists on disk. When `runsDir` is
 * given, every run directory containing `<slug>.log` is protected for such a
 * job — not just scheduler.cjs's single newest match, since this module has
 * no way to know which one the job actually corresponds to and protecting
 * too many is always safe here, never protecting too few.
 */
function liveKeysFromJobs(jobs, opts) {
  const runsDir = opts && opts.runsDir;
  const keys = new Set();
  for (const job of jobs || []) {
    if (!isLiveJob(job) || !job.slug) continue;
    if (job.runId) {
      keys.add(`${job.slug}|${job.runId}`);
      continue;
    }
    if (!runsDir) continue;
    let dirs;
    try {
      dirs = fs.readdirSync(runsDir);
    } catch {
      continue;
    }
    for (const d of dirs) {
      try {
        if (fs.existsSync(path.join(runsDir, d, `${job.slug}.log`))) keys.add(`${job.slug}|${d}`);
      } catch {
        // skip
      }
    }
  }
  return keys;
}

/**
 * Scan RUNS_DIR into one entry per (runId, slug) pair found via its
 * `<slug>.meta.json` file. Read-only; never throws on a missing runsDir.
 */
function scanRunEntries(runsDir) {
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }

  const entries = [];
  for (const de of dirEntries) {
    if (!de.isDirectory()) continue;
    const runId = de.name;
    const dir = path.join(runsDir, runId);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // vanished between readdir calls
    }

    const metaFiles = files.filter((f) => f.endsWith(META_SUFFIX));
    for (const metaFile of metaFiles) {
      const slug = metaFile.slice(0, -META_SUFFIX.length);
      const relatedNames = files.filter(
        (f) => f === metaFile || f === `${slug}.log` || f === `root-cause-${slug}.md`
      );

      let sizeBytes = 0;
      let mtimeMs = null;
      const filePaths = [];
      for (const name of relatedNames) {
        const fp = path.join(dir, name);
        filePaths.push(fp);
        try {
          const st = fs.statSync(fp);
          sizeBytes += st.size;
          if (mtimeMs === null || st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        } catch {
          // file vanished mid-scan — skip its contribution
        }
      }

      let recordedAtMs = null;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8'));
        const candidate = meta.finishedAt ?? meta.startedAt;
        if (typeof candidate === 'number' && Number.isFinite(candidate)) recordedAtMs = candidate;
      } catch {
        // corrupt/unreadable meta.json — fall back to file mtime below
      }

      entries.push({
        runId,
        slug,
        dir,
        files: filePaths,
        sizeBytes,
        timeMs: recordedAtMs ?? mtimeMs ?? 0,
      });
    }
  }
  return entries;
}

/**
 * Evaluate eligibility for each entry against a policy. Returns entries
 * augmented with { ageDays, rank, isMostRecent, isLive, eligible }.
 *
 * @param {Array} entries          Output of scanRunEntries().
 * @param {{maxAgeDays?: number, keepPerSlug?: number}} policy
 * @param {{now?: number, liveKeys?: Set<string>}} opts
 */
function computeEligibility(entries, policy, opts) {
  const { maxAgeDays, keepPerSlug } = policy || {};
  const now = (opts && opts.now) ?? Date.now();
  const liveKeys = (opts && opts.liveKeys) ?? new Set();
  const hasPolicy = maxAgeDays != null || keepPerSlug != null;

  const bySlug = new Map();
  for (const e of entries) {
    if (!bySlug.has(e.slug)) bySlug.set(e.slug, []);
    bySlug.get(e.slug).push(e);
  }
  const rankOf = new Map();
  for (const list of bySlug.values()) {
    list.sort((a, b) => b.timeMs - a.timeMs);
    list.forEach((e, i) => rankOf.set(e, i));
  }

  return entries.map((e) => {
    const rank = rankOf.get(e) ?? 0;
    const isMostRecent = rank === 0;
    const isLive = liveKeys.has(`${e.slug}|${e.runId}`);
    const ageDays = (now - e.timeMs) / DAY_MS;
    const ageOk = maxAgeDays == null || ageDays > maxAgeDays;
    const countOk = keepPerSlug == null || rank >= keepPerSlug;
    const eligible = hasPolicy && !isLive && !isMostRecent && ageOk && countOk;
    return { ...e, ageDays, rank, isMostRecent, isLive, eligible };
  });
}

/**
 * Read-only report: current usage against runsDir, plus what the given
 * policy WOULD remove. Never writes or deletes anything.
 */
function computeReport(runsDir, policy, opts) {
  const now = (opts && opts.now) ?? Date.now();
  const liveKeys = (opts && opts.liveKeys) ?? new Set();
  const entries = scanRunEntries(runsDir);
  const evaluated = computeEligibility(entries, policy || {}, { now, liveKeys });

  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  const dirSet = new Set(entries.map((e) => e.dir));
  const oldestRunAt = entries.length ? Math.min(...entries.map((e) => e.timeMs)) : null;

  const eligible = evaluated.filter((e) => e.eligible);
  const eligibleBytes = eligible.reduce((sum, e) => sum + e.sizeBytes, 0);

  // A directory is fully removable only when every file physically present
  // in it belongs to an eligible entry — an unclaimed file (a DoD report, or
  // a slug entry that isn't eligible) keeps the directory itself alive even
  // though the eligible entries' own files can still be unlinked.
  const removableDirs = [];
  for (const dir of dirSet) {
    let actualFiles;
    try {
      actualFiles = fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (actualFiles.length === 0) continue;
    const claimedEligible = new Set();
    for (const e of evaluated) {
      if (e.dir !== dir || !e.eligible) continue;
      for (const fp of e.files) claimedEligible.add(path.basename(fp));
    }
    if (actualFiles.every((f) => claimedEligible.has(f))) removableDirs.push(dir);
  }

  return {
    generatedAt: now,
    runsDir,
    policy: policy || null,
    usage: {
      totalBytes,
      dirCount: dirSet.size,
      runCount: entries.length,
      oldestRunAt,
    },
    eligible,
    eligibleSummary: { count: eligible.length, bytes: eligibleBytes },
    removableDirs,
  };
}

/**
 * True only when settings carry an explicit, well-formed opt-in:
 * `schedulerRunLogRetention.enabled === true` plus a non-empty policy.
 */
function isRetentionEnabled(settings) {
  const cfg = settings && settings.schedulerRunLogRetention;
  if (!cfg || cfg.enabled !== true) return false;
  const policy = cfg.policy;
  return !!policy && (policy.maxAgeDays != null || policy.keepPerSlug != null);
}

/**
 * Resolve the live-job protection set for applyRetention. Prefers whatever
 * the caller supplied (opts.liveKeys, or opts.jobs to derive it from); if
 * neither is given AND deletion is actually about to happen, falls back to
 * reading the real scheduler queue itself via queueStore.cjs (plain Node, no
 * Electron deps — safe to require here) rather than silently treating no
 * jobs as live. This is deliberately defense-in-depth: a future caller that
 * forgets to thread live-job info through must not thereby lose live-job
 * protection.
 */
function resolveLiveKeysForApply(runsDir, opts, enabled) {
  if (opts && opts.liveKeys) return opts.liveKeys;
  if (opts && opts.jobs) return liveKeysFromJobs(opts.jobs, { runsDir });
  if (!enabled) return new Set(); // dry-run path never deletes; no live read needed
  try {
    const queueStore = require('./queueStore.cjs');
    const state = queueStore.readMergedSync();
    return liveKeysFromJobs(state.jobs || [], { runsDir });
  } catch {
    return new Set();
  }
}

/**
 * Compute the report, and — ONLY when isRetentionEnabled(settings) — delete
 * the eligible files and rmdir any directory left fully empty. With no
 * opt-in (the default), this is exactly computeReport(): read-only,
 * `deleted: false`, nothing removed.
 */
function applyRetention(runsDir, settings, opts) {
  const cfg = (settings && settings.schedulerRunLogRetention) || null;
  const policy = (cfg && cfg.policy) || {};
  const enabled = isRetentionEnabled(settings);
  const liveKeys = resolveLiveKeysForApply(runsDir, opts, enabled);
  const report = computeReport(runsDir, policy, { now: opts && opts.now, liveKeys });

  if (!enabled) {
    return {
      deleted: false,
      reason: 'dry-run: schedulerRunLogRetention.enabled is not true (or has no policy)',
      report,
    };
  }

  let removedFiles = 0;
  let freedBytes = 0;
  const errors = [];

  for (const entry of report.eligible) {
    for (const fp of entry.files) {
      try {
        const st = fs.statSync(fp);
        fs.unlinkSync(fp);
        removedFiles += 1;
        freedBytes += st.size;
      } catch (e) {
        if (e && e.code !== 'ENOENT') errors.push({ path: fp, error: e.message });
      }
    }
  }

  for (const dir of report.removableDirs) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (e) {
      if (e && e.code !== 'ENOENT') errors.push({ path: dir, error: e.message });
    }
  }

  return { deleted: true, removedFiles, freedBytes, errors, report };
}

module.exports = {
  DEFAULT_RUNS_DIR,
  LIVE_STATUSES,
  isLiveJob,
  liveKeysFromJobs,
  scanRunEntries,
  computeEligibility,
  computeReport,
  isRetentionEnabled,
  applyRetention,
};
