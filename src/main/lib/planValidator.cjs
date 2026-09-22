'use strict';

/**
 * planValidator.cjs — pure predicate telling a work-item's dispatch whether a
 * plan-level `validator` job (PRD 1405/1407) will re-review its diff once the
 * plan finishes, so the per-job finish protocol and per-PRD validation prompt
 * (PRD 986) can both yield to it instead of duplicating the same review. No
 * filesystem or scheduler knowledge — the caller supplies the queue rows.
 */

/**
 * hasDownstreamValidator(job, jobs) → boolean
 *
 * True iff `jobs` contains a row with `agentType === 'validator'`, status
 * `pending` or `running`, whose `dependsOn` names `job.slug`. A validator job
 * itself never has a downstream validator (it IS the plan's validation pass).
 */
function hasDownstreamValidator(job, jobs) {
  if (!job || !Array.isArray(jobs)) return false;
  if (job.agentType === 'validator') return false;
  return jobs.some((row) => row
    && row.agentType === 'validator'
    && (row.status === 'pending' || row.status === 'running')
    && Array.isArray(row.dependsOn)
    && row.dependsOn.includes(job.slug));
}

module.exports = { hasDownstreamValidator };
