'use strict';

/**
 * runLogRetention.cjs — computes and applies a retention policy over `scheduled-plans/runs/`.
 *
 * That directory is a machine-level Session-Manager runtime artifact store
 * (execution logs of the scheduler's own `claude -p` runs), not anything
 * governed by the per-project single-writer law in opsOwnership.cjs — see
 * queueStore.cjs's header comment, which draws the same line for
 * scheduler-machine.json.
 *
 * Directory shape: one subdirectory per tick (`RUNS_DIR/<iso-ts>/`, minted by
 * scheduler.cjs's pickRunDir), which commonly holds MANY different PRD
 * slugs' artifacts side by side — `<slug>.log`, `<slug>.meta.json`, the
 * `<slug>.supervisor.json` dispatch record (jobSupervisorRecord.cjs), and an
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
 * FILE KINDS. Each (runId, slug) entry owns two kinds of file:
 *   - BULK: `<slug>.log`, `<slug>.supervisor.json`, `<slug>*.patch`,
 *     `root-cause-<slug>.md` — the space hogs.
 *   - METADATA: `<slug>.meta.json`, `<slug>.verdicts.json`,
 *     `<slug>.outcome.json` — tiny; terminalRunOutcome.cjs reads the newest
 *     run's copies as the re-run guard fallback.
 *
 * SEMANTICS (age-driven):
 *   - Retention is ON by default (DEFAULT_RUN_LOG_RETENTION) when settings
 *     carry no `schedulerRunLogRetention`. An explicit `enabled: false` (or a
 *     config with no non-empty policy) opts out: computeReport, and
 *     applyRetention when opted out, only READ the filesystem.
 *   - A LIVE entry (status pending/running/needs_review/investigating — see
 *     LIVE_STATUSES) loses nothing, regardless of age or count.
 *   - With `maxAgeDays` set, age alone decides: a non-live entry older than
 *     maxAgeDays loses its BULK files even when it is the slug's newest/only
 *     run. `keepPerSlug` applies within the age window only — entries younger
 *     than maxAgeDays are always kept, so it never rescues an old entry.
 *   - With only `keepPerSlug` set (no maxAgeDays), bulk files of entries ranked
 *     beyond the newest N are eligible.
 *   - METADATA is removed only from entries that are bulk-eligible AND not the
 *     slug's newest run: the newest run of every slug always keeps its
 *     meta/verdicts/outcome files.
 *   - A directory left holding only definition-of-done-*.md files (batch-keyed,
 *     claimed by no entry) whose mtime is older than maxAgeDays is removed with
 *     them; a directory left empty is removed.
 */

const fs = require('node:fs');
const path = require('node:path');
const schedulerPaths = require('./schedulerPaths.cjs');

// Any status that is not yet a terminal outcome. Mirrors the status literals
// used throughout scheduler.cjs (see e.g. its DOD_SLUG_RE-adjacent status
// checks) — 'completed' and 'failed' are the only terminal ones.
const LIVE_STATUSES = new Set(['pending', 'running', 'needs_review', 'investigating']);

/**
 * Built-in policy applied when settings carry no `schedulerRunLogRetention`:
 * drop runs older than 14 days but always keep each slug's newest 3.
 * (Policy keys follow the module's own names: maxAgeDays / keepPerSlug.)
 */
const DEFAULT_RUN_LOG_RETENTION = Object.freeze({
  enabled: true,
  policy: Object.freeze({ maxAgeDays: 14, keepPerSlug: 3 }),
});

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
      const isBulk = (f) =>
        f === `${slug}.log` ||
        f === `${slug}.supervisor.json` ||
        f === `root-cause-${slug}.md` ||
        (f.startsWith(`${slug}.`) && f.endsWith('.patch'));
      const isMetadata = (f) =>
        f === metaFile || f === `${slug}.verdicts.json` || f === `${slug}.outcome.json`;
      const relatedNames = files.filter((f) => isBulk(f) || isMetadata(f));

      let sizeBytes = 0;
      let mtimeMs = null;
      const filePaths = [];
      const fileInfos = [];
      for (const name of relatedNames) {
        const fp = path.join(dir, name);
        filePaths.push(fp);
        try {
          const st = fs.statSync(fp);
          sizeBytes += st.size;
          fileInfos.push({ path: fp, size: st.size, kind: isBulk(name) ? 'bulk' : 'metadata' });
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
        fileInfos,
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
    // Age alone decides when set; keepPerSlug only governs count-only policies.
    const retained = maxAgeDays != null ? !(ageDays > maxAgeDays) : !(rank >= keepPerSlug);
    const bulkEligible = hasPolicy && !isLive && !retained;
    const metaEligible = bulkEligible && !isMostRecent;
    const infos = e.fileInfos || [];
    const removeFiles = infos.filter((f) => (f.kind === 'bulk' ? bulkEligible : metaEligible));
    return {
      ...e,
      ageDays,
      rank,
      isMostRecent,
      isLive,
      bulkEligible,
      metaEligible,
      removeFiles,
      eligible: removeFiles.length > 0,
    };
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
  let bulkBytes = 0;
  let metadataBytes = 0;
  for (const e of eligible) {
    for (const f of e.removeFiles) {
      if (f.kind === 'bulk') bulkBytes += f.size;
      else metadataBytes += f.size;
    }
  }

  // A directory is fully removable when, after the eligible files are
  // unlinked, nothing remains except definition-of-done reports older than
  // maxAgeDays (which go with it). Any other leftover (a non-eligible entry's
  // files, an unclaimed file, a young DoD report) keeps the directory alive.
  const maxAgeDays = policy && policy.maxAgeDays;
  const removing = new Set();
  for (const e of eligible) for (const f of e.removeFiles) removing.add(f.path);

  let allDirs;
  try {
    allDirs = fs.readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(runsDir, d.name));
  } catch {
    allDirs = [];
  }
  const removableDirs = [];
  const dodFiles = [];
  for (const dir of allDirs) {
    let actualFiles;
    try {
      actualFiles = fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (actualFiles.length === 0) continue; // empty orphans: sweepOrphanDirs
    const dirDod = [];
    let removable = true;
    for (const f of actualFiles) {
      const fp = path.join(dir, f);
      if (removing.has(fp)) continue;
      if (maxAgeDays != null && /^definition-of-done-.*\.md$/.test(f)) {
        try {
          const st = fs.statSync(fp);
          if ((now - st.mtimeMs) / DAY_MS > maxAgeDays) {
            dirDod.push({ path: fp, size: st.size, kind: 'metadata' });
            continue;
          }
        } catch {
          // vanished — treat as gone
          continue;
        }
      }
      removable = false;
      break;
    }
    if (removable) {
      removableDirs.push(dir);
      for (const d of dirDod) {
        dodFiles.push(d);
        metadataBytes += d.size;
      }
    }
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
    eligibleSummary: {
      count: eligible.length,
      bytes: bulkBytes + metadataBytes,
      bulkBytes,
      metadataBytes,
    },
    dodFiles,
    removableDirs,
  };
}

/**
 * The effective retention config: the caller's `schedulerRunLogRetention`
 * when present, else DEFAULT_RUN_LOG_RETENTION.
 */
function resolveRetentionConfig(settings) {
  const cfg = settings && settings.schedulerRunLogRetention;
  return cfg == null ? DEFAULT_RUN_LOG_RETENTION : cfg;
}

/**
 * True when the effective config (see resolveRetentionConfig) has
 * `enabled === true` plus a non-empty policy. An absent setting resolves to
 * the default (enabled); an explicit `enabled: false` opts out.
 */
function isRetentionEnabled(settings) {
  const cfg = resolveRetentionConfig(settings);
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
 * Build the set of runIds currently claimed by a job in status 'running' —
 * used by the orphan pass below to skip a directory whose spawn may be
 * mid-flight right now (scheduler.cjs's pickRunDir mints the runId/dir pair
 * before the child process is spawned; the directory itself is only
 * mkdir'd, and files only start landing in it, once execution actually
 * commits — see executeJob). Deliberately keyed by runId alone, not
 * `${slug}|${runId}` like liveKeysFromJobs: a shared batch dir (tickQueue
 * hands ONE runId to several jobs at once) is in flight if ANY job dispatched
 * into it is still running, regardless of which slug.
 */
function runningRunIdsFromJobs(jobs) {
  const ids = new Set();
  for (const job of jobs || []) {
    if (job && job.status === 'running' && job.runId) ids.add(job.runId);
  }
  return ids;
}

/**
 * Resolve the running-runId protection set for applyRetention's orphan pass,
 * mirroring resolveLiveKeysForApply's precedence: explicit opts win, then
 * opts.jobs, then (only when deletion is actually about to happen) a direct
 * read of the real scheduler queue.
 */
function resolveRunningRunIdsForApply(opts, enabled) {
  if (opts && opts.runningRunIds) return opts.runningRunIds;
  if (opts && opts.jobs) return runningRunIdsFromJobs(opts.jobs);
  if (!enabled) return new Set();
  try {
    const queueStore = require('./queueStore.cjs');
    const state = queueStore.readMergedSync();
    return runningRunIdsFromJobs(state.jobs || []);
  } catch {
    return new Set();
  }
}

/**
 * Remove every EMPTY directory directly under runsDir, at any age, except
 * one whose runId is in runningRunIds. These are orphans left behind by a
 * dispatch that minted a runId/dir pair (pickRunDir) but aborted before
 * spawnJob's executeJob ever wrote into it (slot-acquire miss, worktree-cap
 * deferral, launch-gate block, ...) — scanRunEntries never sees them (no
 * meta.json), so the age/count policy above can't reach them either.
 * Returns the count of directories removed.
 */
function sweepOrphanDirs(runsDir, runningRunIds, errors) {
  let dirNames;
  try {
    dirNames = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const runId of dirNames) {
    if (runningRunIds.has(runId)) continue;
    const dir = path.join(runsDir, runId);
    try {
      if (fs.readdirSync(dir).length !== 0) continue;
      fs.rmdirSync(dir);
      removed += 1;
    } catch (e) {
      if (e && e.code !== 'ENOENT') errors.push({ path: dir, error: e.message });
    }
  }
  return removed;
}

/**
 * Compute the report, and — ONLY when isRetentionEnabled(settings) — delete
 * the eligible files, rmdir any directory left fully empty, and sweep any
 * orphan empty run directory (see sweepOrphanDirs). With no opt-in (the
 * default), this is exactly computeReport(): read-only, `deleted: false`,
 * nothing removed.
 */
function applyRetention(runsDir, settings, opts) {
  const cfg = resolveRetentionConfig(settings);
  const policy = (cfg && cfg.policy) || {};
  const enabled = isRetentionEnabled(settings);
  const liveKeys = resolveLiveKeysForApply(runsDir, opts, enabled);
  const report = computeReport(runsDir, policy, { now: opts && opts.now, liveKeys });

  if (!enabled) {
    return {
      deleted: false,
      reason: 'dry-run: schedulerRunLogRetention is disabled (enabled !== true, or has no policy)',
      report,
    };
  }

  let removedFiles = 0;
  let freedBytes = 0;
  const errors = [];

  const toRemove = [];
  for (const entry of report.eligible) for (const f of entry.removeFiles) toRemove.push(f.path);
  for (const f of report.dodFiles) toRemove.push(f.path);
  for (const fp of toRemove) {
    try {
      const st = fs.statSync(fp);
      fs.unlinkSync(fp);
      removedFiles += 1;
      freedBytes += st.size;
    } catch (e) {
      if (e && e.code !== 'ENOENT') errors.push({ path: fp, error: e.message });
    }
  }

  for (const dir of report.removableDirs) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (e) {
      if (e && e.code !== 'ENOENT') errors.push({ path: dir, error: e.message });
    }
  }

  const runningRunIds = resolveRunningRunIdsForApply(opts, enabled);
  const orphanDirsRemoved = sweepOrphanDirs(runsDir, runningRunIds, errors);

  return { deleted: true, removedFiles, freedBytes, orphanDirsRemoved, errors, report };
}

/**
 * One-shot production entry point: reads the REAL scheduler queue (jobs +
 * machine config, via queueStore.readMergedSync) and calls applyRetention
 * with those jobs passed EXPLICITLY as opts.jobs — never relying on
 * applyRetention's own internal queueStore fallback (resolveLiveKeysForApply
 * above), which exists only as a defensive net for callers who forget to
 * thread live-job info through, not as this module's primary path. Deletion
 * happens unless the read config opts out with
 * schedulerRunLogRetention.enabled === false (see isRetentionEnabled).
 *
 * Intended to be called once per app boot (see index.cjs's deferred 30s
 * startup timer, alongside finalizeClosedDays) — never on its own timer.
 */
function runBootSweep(opts) {
  const runsDir = (opts && opts.runsDir) || schedulerPaths.runsDir();
  const queueStore = require('./queueStore.cjs');
  const state = queueStore.readMergedSync();
  return applyRetention(runsDir, state.config || {}, { jobs: state.jobs || [] });
}

module.exports = {
  DEFAULT_RUN_LOG_RETENTION,
  resolveRetentionConfig,
  LIVE_STATUSES,
  isLiveJob,
  liveKeysFromJobs,
  runningRunIdsFromJobs,
  sweepOrphanDirs,
  scanRunEntries,
  computeEligibility,
  computeReport,
  isRetentionEnabled,
  applyRetention,
  runBootSweep,
};
