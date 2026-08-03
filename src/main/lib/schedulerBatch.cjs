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
 * Per-project batch picker. `dependsOn` is the ONLY ordering primitive.
 *
 * Rules:
 *   1. Eligible = pending, not already running, and no blocking dependency.
 *   2. A dep is blocking while a queue row for it exists non-completed; a
 *      FAILED dep holds its dependents with an explicit reason. Transitive
 *      holds fall out of this for free (a held job stays `pending`, which is
 *      itself a blocking state for anything depending on IT).
 *   3. Everything eligible fires, up to `slots`, ordered by parallelGroup
 *      ascending as a PRIORITY HINT only — never as a barrier.
 *
 * `parallelGroup` used to be a WAVE number and this function used to fire at
 * most one wave per tick, holding every higher wave while a lower one was in
 * flight. PRD 832 made the number strictly UNIQUE per PRD and moved ordering
 * to `dependsOn` — `prdCreate.cjs` now warns that an explicit parallelGroup is
 * "deprecated and ignored" — but this picker was never updated to match. With
 * unique numbers every wave is a singleton, so the batch was always exactly
 * ONE job, and because numbers are allocated monotonically upward, each newly
 * queued PRD always sorted ABOVE the in-flight one and was held behind it.
 * Measured effect: max concurrency 1 across 25 recorded runs, against a
 * 5-slot pool. The group logic is gone; the real limits are the machine-wide
 * `sessionSlots` pool and the memory gate, both enforced by the caller in
 * scheduler.cjs's tickQueue.
 *
 * @param {object[]} projectJobs - All jobs for this project (all statuses).
 * @param {Set<string>} runningSlugsInProject - Slugs from the global
 *   runningSet that belong to this project.
 * @param {number} slots - Maximum jobs to return (global remaining slots;
 *   caller enforces the global cap across projects).
 * @returns {{ batch: object[], reason: string | null }} Jobs to spawn for this
 *   project this tick, plus (when batch is empty because a gate held it) the
 *   human-readable reason text that would otherwise only reach console.log.
 */
function pickForProject(projectJobs, runningSlugsInProject, slots) {
  const projectCwd = (projectJobs.find((j) => j.cwd) || {}).cwd || DEFAULT_PROJECT_CWD;

  // Explicit dependsOn eligibility (PRD 832). A dep slug is BLOCKING while a
  // queue row for it exists in a non-completed state; a slug with no row is
  // treated as already done (completed rows are retired to history shards,
  // so absence is the normal end-state of a finished dep). A FAILED dep
  // holds the dependent with an explicit reason, mirroring the failure gate.
  // Legacy jobs without dependsOn keep the shared-NN group semantics below
  // unchanged (lowest-number-first waves), so an in-flight mixed queue keeps
  // its order without migration.
  const rowBySlug = new Map(projectJobs.map((j) => [j.slug, j]));
  // A PRD's filename slug carries the auto-allocated `NN-` prefix
  // (prdCreate.cjs builds `${nn}-${slug}`), but a human/agent authoring
  // `dependsOn:` writes the BARE name it chose — it cannot know the number
  // the allocator will hand out. Without this, every such dep resolved to
  // undefined and was silently treated as "already done", turning the whole
  // dependency gate into a no-op (observed live 2026-08-01: 22 PRDs listing
  // `leftnav-two-face-framework` while the real row was
  // `873-leftnav-two-face-framework`, all of them eligible immediately even
  // though the framework PRD they build on had not landed). Resolve a dep by
  // exact slug first, then fall back to matching rows whose slug is that dep
  // with a leading `NN-` stripped.
  const rowsByBareSlug = new Map();
  for (const j of projectJobs) {
    const bare = String(j.slug ?? '').replace(/^\d+-/, '');
    if (!rowsByBareSlug.has(bare)) rowsByBareSlug.set(bare, []);
    rowsByBareSlug.get(bare).push(j);
  }
  /** Every queue row a dep string refers to (exact match, else bare-name match). */
  const rowsForDep = (slug) => {
    const exact = rowBySlug.get(slug);
    if (exact) return [exact];
    return rowsByBareSlug.get(String(slug ?? '').replace(/^\d+-/, '')) ?? [];
  };
  const blockingDep = (j) => (j.dependsOn ?? []).find((slug) => (
    rowsForDep(slug).some((dep) => dep.status !== 'completed')
  ));

  const allPending = projectJobs.filter(
    (j) => j.status === 'pending' && !runningSlugsInProject.has(j.slug),
  );
  if (allPending.length === 0) return { batch: [], reason: null, holds: [] };

  const pending = [];
  const heldByFailedDep = [];
  // Per-job hold records, surfaced to the UI so a `pending` row can say WHICH
  // dep is holding it instead of leaving the reason in console.log.
  const holds = [];
  for (const j of allPending) {
    const dep = blockingDep(j);
    if (!dep) { pending.push(j); continue; }
    const depRows = rowsForDep(dep);
    const failed = depRows.some((d) => d.status === 'failed');
    if (failed) heldByFailedDep.push({ job: j, dep });
    holds.push({
      slug: j.slug,
      dep,
      depStatus: depRows.find((d) => d.status !== 'completed')?.status ?? 'unknown',
    });
    // running/pending/needs_review dep — simply not eligible this tick.
  }
  if (pending.length === 0) {
    if (heldByFailedDep.length > 0) {
      const detail = heldByFailedDep.map(({ job, dep }) => `${job.slug} <- ${dep}`).join(', ');
      const reason = `[scheduler] depends-gate [${projectCwd}]: holding ${heldByFailedDep.length} job(s) behind failed dependencies [${detail}]. Reset or archive the dep to unblock.`;
      console.log(reason);
      return { batch: [], reason, holds };
    }
    return { batch: [], reason: null, holds };
  }

  if (slots <= 0) {
    const reason = `[scheduler] concurrency [${projectCwd}]: no slots free, holding ${pending.length} eligible job(s)`;
    console.log(reason);
    return { batch: [], reason, holds };
  }

  // parallelGroup is a PRIORITY HINT, not a barrier: when there are more
  // eligible jobs than slots, the lower (earlier-authored) PRD numbers go
  // first. Everything else about the number is display-only.
  const batch = pending
    .slice()
    .sort((a, b) => (a.parallelGroup ?? 99) - (b.parallelGroup ?? 99))
    .slice(0, slots);
  console.log(
    `[scheduler] concurrency [${projectCwd}]: firing ${batch.length} of ${pending.length} ` +
    `eligible job(s) [${batch.map((j) => j.slug).join(', ')}]`,
  );
  return { batch, reason: null, holds };
}

/**
 * Pick the next batch of jobs to spawn this tick.
 *
 * Dependency gates are evaluated PER PROJECT (keyed by cwd), so jobs in
 * different projects never serialize each other.
 *
 * O(N) where N = allJobs.length.
 *
 * @param {object[]} allJobs - Full queue.json job list.
 * @param {Set<string>} running - In-process running slugs (runningSet).
 * @param {number} freeSlots - Slots free RIGHT NOW in the machine-wide
 *   `sessionSlots` pool (`sessionSlots.available()`). This is already
 *   net of every held slot — scheduler jobs AND chat runs — so it must not
 *   have the running count subtracted from it again. The scheduler no longer
 *   keeps a private concurrency cap of its own: per sessionSlots.cjs's own
 *   charter, caps belong to Session-Manager's one pool, not to each consumer.
 * @returns {{ batch: object[], reason: string | null }} Jobs to spawn this
 *   tick, plus (when batch is empty because a gate held it) the human-readable
 *   hold reason that would otherwise only reach console.log.
 */
function pickNextBatch(allJobs, running, freeSlots) {
  if (!allJobs.some((j) => j.status === 'pending' && !running.has(j.slug))) {
    return { batch: [], reason: null, holds: [] };
  }

  // Orphan correction: a queue.json row still marked `running` that this
  // process did NOT spawn holds no pool slot (it is a leftover from a crashed
  // prior session, pending boot reconciliation). The pool cannot see it, so
  // discount it here rather than starting a job into a slot a soon-to-be-
  // reaped process may still be occupying.
  const queueRunningCount = allJobs.filter((j) => j.status === 'running').length;
  const untrackedRunning = Math.max(0, queueRunningCount - running.size);
  let slots = freeSlots - untrackedRunning;
  if (slots <= 0) {
    const reason = `[scheduler] concurrency: no session slots free ` +
      `(${freeSlots} free in pool, ${untrackedRunning} untracked running row(s))`;
    console.log(reason);
    return { batch: [], reason, holds: [] };
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

  // Aggregate batch across projects, consuming global slots as we go. Track
  // the first hold reason seen so callers can explain an empty overall batch.
  const batch = [];
  const holds = [];
  let heldReason = null;
  for (const { projectJobs, runningSlugsInProject } of projectCandidates) {
    if (slots <= 0) break;
    const projectResult = pickForProject(projectJobs, runningSlugsInProject, slots);
    batch.push(...projectResult.batch);
    holds.push(...(projectResult.holds ?? []));
    slots -= projectResult.batch.length;
    if (heldReason === null && projectResult.reason) heldReason = projectResult.reason;
  }
  return { batch, reason: batch.length === 0 ? heldReason : null, holds };
}

module.exports = { pickForProject, pickNextBatch, DEFAULT_PROJECT_CWD };
