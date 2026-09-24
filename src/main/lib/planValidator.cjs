'use strict';

/**
 * planValidator.cjs — pure predicate telling a work-item's dispatch whether a
 * plan-level `validator` job (PRD 1405/1407) will re-review its diff once the
 * plan finishes, so the per-job finish protocol and per-PRD validation prompt
 * (PRD 986) can both yield to it instead of duplicating the same review. No
 * filesystem or scheduler knowledge — the caller supplies the queue rows.
 */

const { bareSlug } = require('./depSlugResolve.cjs');

/**
 * hasDownstreamValidator(job, jobs) → boolean
 *
 * True iff `jobs` contains a row with `agentType === 'validator'`, status
 * `pending` or `running`, that reaches `job.slug` transitively by walking
 * `dependsOn` edges through the supplied rows (e.g. validator -> sink ->
 * job). A validator job itself never has a downstream validator (it IS the
 * plan's validation pass). Plans over the `dependsOn` cap point the
 * validator at only the plan's sink PRDs, so a direct-only check would
 * wrongly say every non-sink work item has no downstream validator.
 *
 * `jobs` may be the machine-wide queue (every project's rows merged), so
 * when `job.cwd` is known the walk excludes rows carrying a DIFFERENT
 * explicit `cwd` — a same-bare-named PRD in an unrelated project can never
 * satisfy this job's validator check. A row with no `cwd` recorded is kept
 * (queue rows may omit it; `scheduleJobSchema.cjs` makes it optional) rather
 * than guessed at, since a wrong exclusion (a real validator missed) is far
 * worse than the narrow residual risk of an unstamped row colliding by bare
 * name. Slug matching within that scope reuses the canonical
 * `depSlugResolve.cjs` rule (exact slug, else bare-name with the leading
 * `NN-` stripped) so this walk agrees with the scheduler's own dependency
 * gate on what a `dependsOn` entry resolves to.
 */
function hasDownstreamValidator(job, jobs) {
  if (!job || !Array.isArray(jobs)) return false;
  if (job.agentType === 'validator') return false;

  const projectJobs = job.cwd
    ? jobs.filter((row) => row && (row.cwd == null || row.cwd === job.cwd))
    : jobs.filter(Boolean);

  const rowBySlug = new Map();
  const rowsByBareSlug = new Map();
  for (const row of projectJobs) {
    rowBySlug.set(row.slug, row);
    const bare = bareSlug(row.slug);
    if (!rowsByBareSlug.has(bare)) rowsByBareSlug.set(bare, []);
    rowsByBareSlug.get(bare).push(row);
  }
  const rowsForSlug = (slug) => {
    const exact = rowBySlug.get(slug);
    if (exact) return [exact];
    return rowsByBareSlug.get(bareSlug(slug)) ?? [];
  };
  const matchesJob = (slug) => slug === job.slug || bareSlug(slug) === bareSlug(job.slug);

  const validators = projectJobs.filter((row) => row.agentType === 'validator'
    && (row.status === 'pending' || row.status === 'running'));

  for (const validator of validators) {
    const visited = new Set();
    const queue = Array.isArray(validator.dependsOn) ? [...validator.dependsOn] : [];
    while (queue.length) {
      const slug = queue.shift();
      if (visited.has(slug)) continue;
      visited.add(slug);
      if (matchesJob(slug)) return true;
      for (const row of rowsForSlug(slug)) {
        for (const depSlug of row.dependsOn ?? []) {
          if (!visited.has(depSlug)) queue.push(depSlug);
        }
      }
    }
  }
  return false;
}

module.exports = { hasDownstreamValidator };
