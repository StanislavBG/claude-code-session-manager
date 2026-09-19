'use strict';

/**
 * ephemeralCwd.cjs — fail-closed predicate for "this cwd must never receive a
 * written ops-state tree."
 *
 * Verified live 2026-09-01: a worktree cwd slipped past project-discovery and
 * queueStore.writeSplit materialized a per-project scheduler shard INSIDE an
 * ephemeral epic/job worktree
 * (/tmp/session-manager-epic-worktrees/<id>/<epic>/session-manager-operations/
 * scheduler/state/queue.json, rewritten every reconcile pass) plus a stray
 * /tmp/session-manager-operations/logs/ tree. A worktree is torn down when its
 * Epic/job ends, so any state written there is silently destroyed — and while
 * it exists it duplicate-answers "does this project have jobs" for a cwd that
 * isn't really a distinct project.
 *
 * Three independent refusal conditions, any one is enough:
 *   - cwd IS os.tmpdir() itself (exact match — the bare-root case behind the
 *     stray /tmp/session-manager-operations/logs/ tree).
 *   - cwd resolves inside one of the two MANAGED worktree roots
 *     (gitWorktree.cjs's KIND_CONFIG job/epic roots under os.tmpdir()) — a
 *     prefix match here is safe because nothing but managed worktree
 *     checkouts is ever created under these two roots (same reasoning
 *     activeSessions.cjs's TMP_DROP_ROOTS already relies on).
 *   - cwd IS a linked git worktree's own root anywhere on disk —
 *     worktreeMainRootOf(cwd) resolves to a DIFFERENT path than cwd itself.
 *     (When cwd is itself an ordinary main-tree repo root, worktreeMainRootOf
 *     (cwd) resolves back to cwd unchanged, which is not a redirect and must
 *     not be refused.)
 *
 * Deliberately NOT a blanket "anywhere under os.tmpdir()" prefix match: this
 * codebase's own scheduler test suite routinely mkdtemp()s a fake project cwd
 * under os.tmpdir() (documented convention — see e.g.
 * scheduler-clear-queue-history.test.cjs's header comment), a legitimate,
 * unrelated use that a blanket match would wrongly refuse.
 */

const path = require('node:path');
const { classifyCwd } = require('./cwdClassify.cjs');

/**
 * isEphemeralCwd(cwd) → true when `cwd` must never have ops state written
 * into it (tmpdir-resident, or a linked git worktree root). Pure, synchronous,
 * never throws — an unresolvable or non-absolute cwd is treated as NOT
 * ephemeral so this predicate only ever adds refusals, never masks the
 * existing "cwd must be absolute" checks callers already perform. The
 * unprovable-worktree case is NOT ephemeral here: it is kind `unknown`, which
 * opsOwnership.assertOpsWrite refuses separately (writes only — dispatch and
 * reads stay open).
 */
function isEphemeralCwd(cwd) {
  if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const { kind } = classifyCwd(path.resolve(cwd));
  return kind === 'ephemeral' || kind === 'worktree';
}

module.exports = { isEphemeralCwd };
