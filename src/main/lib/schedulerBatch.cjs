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
const { projectJobCap } = require('./schedulerConfig.cjs');

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
  // A dep that never ran (its PRD source vanished before dispatch — see
  // scheduleJobSchema.cjs's 'skipped' status) is just as blocking as a
  // failed one and deserves the same explicit reason, not a silent fall into
  // the generic `holds` bucket — resetting won't help here (the source file
  // is gone), so the guidance differs from the failed-dep case.
  const heldBySkippedDep = [];
  // Per-job hold records, surfaced to the UI so a `pending` row can say WHICH
  // dep is holding it instead of leaving the reason in console.log.
  const holds = [];
  for (const j of allPending) {
    const dep = blockingDep(j);
    if (!dep) { pending.push(j); continue; }
    const depRows = rowsForDep(dep);
    const failed = depRows.some((d) => d.status === 'failed');
    const skipped = depRows.some((d) => d.status === 'skipped');
    if (failed) heldByFailedDep.push({ job: j, dep });
    else if (skipped) heldBySkippedDep.push({ job: j, dep });
    holds.push({
      slug: j.slug,
      dep,
      depStatus: depRows.find((d) => d.status !== 'completed')?.status ?? 'unknown',
    });
    // running/pending/needs_review dep — simply not eligible this tick.
  }
  if (pending.length === 0) {
    const reasons = [];
    if (heldByFailedDep.length > 0) {
      const detail = heldByFailedDep.map(({ job, dep }) => `${job.slug} <- ${dep}`).join(', ');
      reasons.push(`holding ${heldByFailedDep.length} job(s) behind failed dependencies [${detail}]. Reset or archive the dep to unblock.`);
    }
    if (heldBySkippedDep.length > 0) {
      const detail = heldBySkippedDep.map(({ job, dep }) => `${job.slug} <- ${dep}`).join(', ');
      reasons.push(`holding ${heldBySkippedDep.length} job(s) behind never-ran dependencies [${detail}]. The dep's PRD source is gone — author a fresh PRD for that work to unblock.`);
    }
    if (reasons.length > 0) {
      const reason = `[scheduler] depends-gate [${projectCwd}]: ${reasons.join(' ')}`;
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

  // Per-project cap: an INNER constraint layered under the global sessionSlots
  // pool passed in via `slots`. A project already running at its cap is held
  // here even when the machine-wide pool has slots free elsewhere — see
  // schedulerConfig.cjs's projectJobCap doc for the incident this fixes.
  //
  // Count every queue.json row already `running` for this project, not just
  // the caller-tracked `runningSlugsInProject` — a row can be genuinely alive
  // but still outside the tracked `running` Set during the boot-orphan grace
  // window (see pickNextBatch's own untrackedRunning correction above), and
  // the cap must not admit a job past it on that technicality.
  const cap = projectJobCap(projectCwd);
  const actualRunningInProject = projectJobs.filter((j) => j.status === 'running').length;
  const capRemaining = Math.max(0, cap - actualRunningInProject);
  const effectiveSlots = Math.min(slots, capRemaining);
  if (effectiveSlots <= 0) {
    const reason = `[scheduler] project-cap [${projectCwd}]: ${runningSlugsInProject.size}/${cap} ` +
      `already running, holding ${pending.length} eligible job(s)`;
    console.log(reason);
    return { batch: [], reason, holds };
  }

  // parallelGroup is a PRIORITY HINT, not a barrier: when there are more
  // eligible jobs than slots, the lower (earlier-authored) PRD numbers go
  // first. Everything else about the number is display-only.
  const batch = pending
    .slice()
    .sort((a, b) => (a.parallelGroup ?? 99) - (b.parallelGroup ?? 99))
    .slice(0, effectiveSlots);
  console.log(
    `[scheduler] concurrency [${projectCwd}]: firing ${batch.length} of ${pending.length} ` +
    `eligible job(s) [${batch.map((j) => j.slug).join(', ')}]`,
  );
  return { batch, reason: null, holds };
}

/**
 * enqueueTimestamp(job) → ms since epoch, or Infinity when unprovable.
 *
 * The moment a row became `pending`, resolved in priority order:
 * `createdAt` → `queuedAt` (stamped by reconcile when it mints a row, PRD
 * 1086) → the first `statusHistory` entry INTO 'pending' → `startedAt`
 * (a reset row's last run start — older than any fresh enqueue, which is
 * the right side to err on) → Infinity. Shared by the cross-project fairness
 * tiebreak below and by findStarvedProjects (PRD 1087), so the two can never
 * disagree about a row's age. Never throws on a malformed value.
 */
function enqueueTimestamp(job) {
  const candidates = [job?.createdAt, job?.queuedAt];
  const firstPending = (job?.statusHistory || []).find((h) => h && h.to === 'pending');
  if (firstPending) candidates.push(firstPending.at);
  candidates.push(job?.startedAt);
  for (const c of candidates) {
    if (!c) continue;
    const ms = Date.parse(c);
    if (!Number.isNaN(ms)) return ms;
  }
  return Infinity;
}

/**
 * Pick the next batch of jobs to spawn this tick.
 *
 * FAIRNESS CONTRACT (PRD 1086). Projects with pending work are served in
 * this order, and slots are handed out ROUND-ROBIN across them — one job per
 * project per pass, cycling until the pool is exhausted or a full pass adds
 * nothing. A single project can therefore never drain every free slot while
 * another project with eligible work gets none in the same tick.
 *   1. fewest jobs currently `running` in that project, ascending;
 *   2. tiebreak: the oldest pending job's enqueue timestamp
 *      (enqueueTimestamp — createdAt → queuedAt → statusHistory → startedAt),
 *      ascending, unprovable ages last;
 *   3. final deterministic tiebreak: the project cwd string.
 *
 * WHY NOT THE PRD NUMBER. The previous sort key was each project's lowest
 * pending `parallelGroup`. NN numbers are allocated PER PROJECT
 * (scheduler.cjs allocateParallelGroup → prdDirForCwd(cwd)) and only ever
 * grow, so comparing them across projects compares unrelated sequences: a
 * project with a long PRD history always sorts behind a young one and starves
 * for as long as the young one keeps queueing. Observed live 2026-09-01:
 * social-signals-trader (8 pending, lowest NN 3887) got zero starts for 3.5 h
 * while starry-night-ships (lowest NN 158) took every freed slot. The number
 * stays a priority hint WITHIN a project (pickForProject) and must never be
 * used across projects again.
 *
 * Within a project nothing changes: dependsOn gating, failed/skipped-dep
 * reasons, the per-project cap and parallelGroup-ascending ordering are all
 * pickForProject's, untouched. Because pickForProject counts a project's
 * `running` rows from the rows it is handed, each pass hands it a per-tick
 * view in which the jobs already picked THIS tick are marked running — so the
 * cap holds across passes and a project is never offered a slot past it.
 *
 * O(N · passes) where passes ≤ freeSlots.
 *
 * @param {object[]} allJobs - Full queue.json job list.
 * @param {Set<string>} running - In-process running slugs (runningSet).
 * @param {number} freeSlots - Slots free RIGHT NOW in the machine-wide
 *   `sessionSlots` pool (`sessionSlots.available()`). This is already
 *   net of every held slot — scheduler jobs AND chat runs — so it must not
 *   have the running count subtracted from it again. The scheduler no longer
 *   keeps a private concurrency cap of its own: per sessionSlots.cjs's own
 *   charter, caps belong to Session-Manager's one pool, not to each consumer.
 * @returns {{ batch: object[], reason: string | null, holds: object[] }} Jobs
 *   to spawn this tick, plus (when batch is empty because a gate held it) the
 *   human-readable hold reason that would otherwise only reach console.log.
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

  // Per-project candidates (only projects with pending work), each carrying
  // a per-tick VIEW of its rows that this loop mutates as it picks, so
  // pickForProject's running count and cap stay accurate across passes.
  const candidates = [];
  for (const [cwd, projectJobs] of projectMap) {
    const hasPending = projectJobs.some(
      (j) => j.status === 'pending' && !running.has(j.slug),
    );
    if (!hasPending) continue;
    const view = projectJobs.map((j) => ({ ...j }));
    const runningSlugsInProject = new Set(
      projectJobs.filter((j) => running.has(j.slug)).map((j) => j.slug),
    );
    const runningCount = projectJobs.filter((j) => j.status === 'running').length;
    const oldestPendingMs = projectJobs
      .filter((j) => j.status === 'pending' && !running.has(j.slug))
      .reduce((min, j) => Math.min(min, enqueueTimestamp(j)), Infinity);
    candidates.push({ cwd, view, runningSlugsInProject, runningCount, oldestPendingMs, active: true });
  }

  candidates.sort((a, b) => (
    (a.runningCount - b.runningCount)
    || (a.oldestPendingMs - b.oldestPendingMs)
    || (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0)
  ));

  const batch = [];
  const holdsBySlug = new Map();
  let heldReason = null;
  // Round-robin: one slot per project per pass.
  while (slots > 0) {
    let addedThisPass = 0;
    for (const c of candidates) {
      if (slots <= 0) break;
      if (!c.active) continue;
      const result = pickForProject(c.view, c.runningSlugsInProject, 1);
      for (const h of result.holds ?? []) if (!holdsBySlug.has(h.slug)) holdsBySlug.set(h.slug, h);
      if (result.batch.length === 0) {
        if (heldReason === null && result.reason) heldReason = result.reason;
        c.active = false; // nothing more this tick from this project
        continue;
      }
      const picked = result.batch[0];
      batch.push(picked);
      slots -= 1;
      addedThisPass += 1;
      // Reflect the pick in this project's per-tick view so the next pass
      // sees it as in flight (cap + running count), and never re-offers it.
      const row = c.view.find((j) => j.slug === picked.slug);
      if (row) row.status = 'running';
      c.runningSlugsInProject.add(picked.slug);
      c.runningCount += 1;
    }
    if (addedThisPass === 0) break;
  }
  const holds = [...holdsBySlug.values()];
  return { batch, reason: batch.length === 0 ? heldReason : null, holds };
}

/**
 * findStarvedProjects(jobs, now, thresholdMs) → [{ cwd, pendingCount, oldestPendingSlug, ageMs }]
 *
 * PRD 1087 — the escalation counterpart to the fairness rule above. A project
 * is STARVED when it has pending work, nothing of its own running, its oldest
 * pending job has provably waited longer than `thresholdMs`, AND some OTHER
 * project currently has a running job (so the machine is dispatching, just
 * not for this project — an idle or paused machine is not starvation).
 *
 * Pure and escalation-only: never mutates, reorders or dispatches. A pending
 * row whose age cannot be proven (no enqueue timestamp — see
 * enqueueTimestamp) is warn-logged and NOT reported, the same posture as
 * findStrandedInvestigations.
 */
function findStarvedProjects(jobs, now, thresholdMs) {
  const byCwd = new Map();
  for (const j of jobs ?? []) {
    const key = j.cwd || DEFAULT_PROJECT_CWD;
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(j);
  }
  const runningCwds = new Set(
    [...byCwd.entries()].filter(([, rows]) => rows.some((j) => j.status === 'running')).map(([cwd]) => cwd),
  );
  if (runningCwds.size === 0) return []; // idle/paused machine — nobody is being passed over
  const out = [];
  for (const [cwd, rows] of byCwd) {
    if (runningCwds.has(cwd)) continue;
    const pending = rows.filter((j) => j.status === 'pending');
    if (pending.length === 0) continue;
    let oldest = null;
    let oldestMs = Infinity;
    let unprovable = 0;
    for (const j of pending) {
      const ms = enqueueTimestamp(j);
      if (ms === Infinity) { unprovable += 1; continue; }
      if (ms < oldestMs) { oldestMs = ms; oldest = j; }
    }
    if (!oldest) {
      console.warn(`[scheduler] findStarvedProjects: ${cwd} has ${pending.length} pending job(s) with no enqueue timestamp — cannot prove age, leaving alone`);
      continue;
    }
    const ageMs = now - oldestMs;
    if (ageMs < thresholdMs) continue;
    out.push({ cwd, pendingCount: pending.length, oldestPendingSlug: oldest.slug, ageMs, unprovable });
  }
  return out;
}

module.exports = { pickForProject, pickNextBatch, enqueueTimestamp, findStarvedProjects, DEFAULT_PROJECT_CWD };
