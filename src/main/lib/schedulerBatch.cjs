'use strict';

/**
 * schedulerBatch.cjs — pure batch-picking logic for the scheduler.
 *
 * Extracted from scheduler.cjs so the functions can be unit-tested without
 * loading the full scheduler (which requires electron + heavy I/O).
 *
 * Group-ordering gates (failure-gate, running-gate) are evaluated
 * PER PROJECT (keyed by cwd). Jobs in different projects do not serialize
 * each other. Within a single project, the sequential-group semantics are
 * fully preserved.
 */

const path = require('node:path');
const os = require('node:os');

const DEFAULT_PROJECT_CWD = path.join(os.homedir(), 'Projects', 'session-manager');

/**
 * Per-project batch picker. Applies group-ordering rules scoped to a single
 * project (all jobs sharing one cwd).
 *
 * Rules (same as original global pickNextBatch, but scoped):
 *   1. Find the lowest parallelGroup with pending jobs not already running.
 *   2. Failure gate: if an earlier group has failed jobs, hold this project.
 *   3. If that group has jobs in flight (backfill), fire more from SAME group.
 *   4. If a lower-numbered group arrives late (late-arrival), fire it now.
 *   5. If no group is in flight, start the lowest pending group fresh.
 *
 * @param {object[]} projectJobs - All jobs for this project (all statuses).
 * @param {Set<string>} runningSlugsInProject - Slugs from the global
 *   runningSet that belong to this project.
 * @param {number} slots - Maximum jobs to return (global remaining slots;
 *   caller enforces the global cap across projects).
 * @returns {object[]} Jobs to spawn for this project this tick.
 */
function pickForProject(projectJobs, runningSlugsInProject, slots) {
  const pending = projectJobs.filter(
    (j) => j.status === 'pending' && !runningSlugsInProject.has(j.slug),
  );
  if (pending.length === 0) return [];

  const projectCwd = (projectJobs.find((j) => j.cwd) || {}).cwd || DEFAULT_PROJECT_CWD;

  // Lowest pending group (computed up-front for the failure-gate check).
  const lowestPendingGroup = pending.reduce(
    (min, j) => Math.min(min, j.parallelGroup ?? 99),
    Infinity,
  );

  // Cross-group failure gate: refuse to advance past a group with failed jobs.
  // A failed foundation PRD should not allow later groups to run and
  // silently corrupt project state. needs_review is NOT a blocker.
  const blockingFailures = projectJobs.filter(
    (j) => j.status === 'failed' && (j.parallelGroup ?? 99) < lowestPendingGroup,
  );
  if (blockingFailures.length > 0) {
    const slugs = blockingFailures.map((j) => j.slug).join(', ');
    console.log(
      `[scheduler] failure-gate [${projectCwd}]: holding g${lowestPendingGroup} — ` +
      `${blockingFailures.length} failed job(s) in earlier groups [${slugs}]. ` +
      `Reset to pending or archive to unblock.`,
    );
    return [];
  }

  // Groups with at least one job in flight: either tracked in runningSlugsInProject
  // (this process spawned it) or still marked 'running' in queue.json
  // (persisted from a previous session that hasn't been orphan-reset yet).
  const jobBySlug = new Map(projectJobs.map((j) => [j.slug, j]));
  const activeGroups = new Set();
  for (const slug of runningSlugsInProject) {
    const job = jobBySlug.get(slug);
    if (job) activeGroups.add(job.parallelGroup ?? 99);
  }
  for (const j of projectJobs) {
    if (j.status === 'running' && !runningSlugsInProject.has(j.slug)) {
      activeGroups.add(j.parallelGroup ?? 99);
    }
  }

  if (activeGroups.size > 0) {
    const lowestActive = Math.min(...activeGroups);
    if (lowestPendingGroup > lowestActive) {
      // Earlier group still running — wait for it to drain before advancing.
      console.log(
        `[scheduler] concurrency [${projectCwd}]: g${lowestActive} in flight, holding g${lowestPendingGroup}`,
      );
      return [];
    }
    if (lowestPendingGroup < lowestActive) {
      // Late-arrival: a lower-numbered (higher-priority) PRD reconciled AFTER
      // a higher-numbered group was already picked. Fire it now in parallel
      // with the active group rather than starving it until drain.
      if (slots <= 0) {
        console.log(
          `[scheduler] concurrency [${projectCwd}]: no slots for late-arrival g${lowestPendingGroup}`,
        );
        return [];
      }
      const batch = pending
        .filter((j) => (j.parallelGroup ?? 99) === lowestPendingGroup)
        .slice(0, slots);
      console.log(
        `[scheduler] concurrency [${projectCwd}]: firing late-arrival g${lowestPendingGroup} ` +
        `(${batch.length} job(s)) alongside active g${lowestActive}`,
      );
      return batch;
    }
    // Backfill slots remaining in the current group.
    if (slots <= 0) {
      console.log(`[scheduler] concurrency [${projectCwd}]: cap reached, no slots`);
      return [];
    }
    const batch = pending
      .filter((j) => (j.parallelGroup ?? 99) === lowestActive)
      .slice(0, slots);
    if (batch.length > 0) {
      console.log(
        `[scheduler] concurrency [${projectCwd}]: backfilling ${batch.length} into g${lowestActive}`,
      );
    }
    return batch;
  }

  // No active group — start the next group fresh.
  if (slots <= 0) {
    console.log(`[scheduler] concurrency [${projectCwd}]: cap reached, no slots`);
    return [];
  }
  const batch = pending
    .filter((j) => (j.parallelGroup ?? 99) === lowestPendingGroup)
    .slice(0, slots);
  console.log(
    `[scheduler] concurrency [${projectCwd}]: starting g${lowestPendingGroup} with ${batch.length} job(s)`,
  );
  return batch;
}

/**
 * Pick the next batch of jobs to spawn this tick.
 *
 * Group-ordering gates are evaluated PER PROJECT (keyed by cwd), so jobs in
 * different projects are not serialized by each other's groups. Within a
 * single project, the existing sequential-group semantics are fully preserved.
 *
 * O(N) where N = allJobs.length.
 *
 * @param {object[]} allJobs - Full queue.json job list.
 * @param {Set<string>} running - In-process running slugs (runningSet).
 * @param {number} cap - concurrencyCap.
 * @returns {object[]} Jobs to spawn this tick.
 */
function pickNextBatch(allJobs, running, cap) {
  if (!allJobs.some((j) => j.status === 'pending' && !running.has(j.slug))) return [];

  // Global slot accounting: take the higher of in-process running count and
  // queue.json running count (handles orphaned running entries from a previous
  // session not yet reaped).
  const queueRunningCount = allJobs.filter((j) => j.status === 'running').length;
  const effectiveRunning = Math.max(running.size, queueRunningCount);
  let slots = cap - effectiveRunning;
  if (slots <= 0) {
    console.log(
      `[scheduler] concurrency: cap ${cap} reached (${effectiveRunning} running), no slots`,
    );
    return [];
  }

  // Group all jobs by project cwd.
  const projectMap = new Map();
  for (const job of allJobs) {
    const key = job.cwd || DEFAULT_PROJECT_CWD;
    if (!projectMap.has(key)) projectMap.set(key, []);
    projectMap.get(key).push(job);
  }

  // Build per-project candidate list (only projects that have pending jobs).
  const projectCandidates = [];
  for (const [, projectJobs] of projectMap) {
    const hasPending = projectJobs.some(
      (j) => j.status === 'pending' && !running.has(j.slug),
    );
    if (!hasPending) continue;

    const runningSlugsInProject = new Set(
      projectJobs.filter((j) => running.has(j.slug)).map((j) => j.slug),
    );
    const lowestPendingForProject = projectJobs
      .filter((j) => j.status === 'pending' && !running.has(j.slug))
      .reduce((min, j) => Math.min(min, j.parallelGroup ?? 99), Infinity);

    projectCandidates.push({ projectJobs, runningSlugsInProject, lowestPendingForProject });
  }

  // Sort by lowest pending group so earlier (higher-priority) groups win
  // slot allocation ties across projects.
  projectCandidates.sort((a, b) => a.lowestPendingForProject - b.lowestPendingForProject);

  // Aggregate batch across projects, consuming global slots as we go.
  const batch = [];
  for (const { projectJobs, runningSlugsInProject } of projectCandidates) {
    if (slots <= 0) break;
    const projectBatch = pickForProject(projectJobs, runningSlugsInProject, slots);
    batch.push(...projectBatch);
    slots -= projectBatch.length;
  }
  return batch;
}

module.exports = { pickForProject, pickNextBatch, DEFAULT_PROJECT_CWD };
