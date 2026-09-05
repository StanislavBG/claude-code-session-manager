'use strict';

/**
 * jobDirtFilter.cjs — strip paths a scheduled job can NEVER be responsible
 * for out of its post-run dirty delta.
 *
 * The commit guard parks a job on `needs_review` ("finish protocol
 * incomplete: N uncommitted file(s)") whenever its run leaves tracked files
 * dirty. That is the right rule for source files. It is wrong for
 * `session-manager-operations/`: the SINGLE-WRITER LAW (lib/opsOwnership.cjs)
 * says the app itself owns every namespace under that root — `scheduler`
 * writes queue.json/history.jsonl on every dispatch and every finalize,
 * `prompt-sessions` writes active-index.json and transcripts continuously.
 * Those writes land DURING the job's own run, inside its own guard window,
 * and get attributed to the job.
 *
 * Result before this filter: a job that did everything right and committed
 * cleanly still parked, because the scheduler's own bookkeeping was dirty
 * underneath it. Observed 2026-09-05 on social-signals-trader PRDs 4055 and
 * 4056 (leftover lists led with active-index.json / queue.json /
 * history.jsonl / .max-allocated-group) and on starry-night-ships PRD 206.
 * Each parked row then blocked every job that dependsOn it, which is how a
 * queue with 40 ready PRDs stops dead.
 *
 * Deliberately narrow: ONLY the app-owned operations root. A job that dirties
 * real source and walks away is still a genuine finish-protocol violation and
 * must still park.
 */

/** The one app-owned root. Matches at any depth, and only as a path segment. */
const OPS_ROOT_SEGMENT = 'session-manager-operations';

/** True when `p` lives under an app-owned operations root. Pure. */
function isAppOwnedChurn(p) {
  if (typeof p !== 'string' || p === '') return false;
  // Normalise Windows-style separators defensively; git porcelain emits '/'.
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.includes(OPS_ROOT_SEGMENT);
}

/**
 * Remove app-owned churn from a dirty-path list.
 *
 * Preserves the caller's null contract: `null` means "git status itself was
 * unavailable", which is NOT the same fact as "the job left nothing", and
 * every caller already branches on it.
 */
function stripAppOwnedChurn(paths) {
  if (paths === null || paths === undefined) return paths;
  if (!Array.isArray(paths)) return paths;
  return paths.filter((p) => !isAppOwnedChurn(p));
}

module.exports = { stripAppOwnedChurn, isAppOwnedChurn, OPS_ROOT_SEGMENT };
