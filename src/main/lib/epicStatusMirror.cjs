'use strict';

/**
 * epicStatusMirror.cjs — mirrors an Epic's lifecycle `status` onto its own
 * durable file, `prompt-sessions/<epicId>.json`, every time a write path
 * changes that status in `active-index.json`.
 *
 * Why this exists: `active-index.json` is the ONLY place an Epic's status
 * lives today. A lost, clobbered, git-reverted, or worktree-snapshotted index
 * silently erases every open Epic it held, with no way to recover them —
 * `activeIndexRebuild.cjs`'s `rebuildActiveIndex` is that recovery path, and
 * it reconstructs rows from exactly the mirror this module writes. The
 * archive file `markCompleted()` already writes at completion (session/
 * events/transcript/archivedAt — see prompt-sessions/README.md) is the same
 * file this module targets; a live (proposed/active) Epic gets a sparse
 * mirror here instead, later overwritten wholesale by the real archive.
 *
 * Raw fs tmp+rename — NOT config.cjs's `writeJson` — so this module stays
 * requirable from epicMint.cjs, which is deliberately Electron-free (its own
 * header: "so the external watchdog scripts can require it"; config.cjs
 * requires 'electron' at module load). The write shape matches config.cjs's
 * writeJson exactly (`JSON.stringify(data, null, 2) + '\n'`, `<path>.tmp-
 * <pid>` then rename) so main-process callers (activeIndexMerge.cjs) and
 * epicMint.cjs never diverge in format despite using different write paths.
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertOpsWrite, opsPath } = require('./opsOwnership.cjs');

function epicMirrorPath(cwd, epicId) {
  return opsPath(cwd, 'prompt-sessions', `${epicId}.json`);
}

function readExistingMirror(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * mirrorEpicStatus(cwd, epicId, { session?, status?, archivedAt?, writer? })
 * — read-merge-write onto `prompt-sessions/<epicId>.json`, preserving
 * whatever else is already there (e.g. a full `PromptSessionArchive` written
 * by `markCompleted`, or a prior mirror).
 *
 * When `session` (the full PromptSession record) is given, it is spread onto
 * the file too — not just the four mirror fields — so a live (proposed/
 * active) Epic's file alone is enough for `activeIndexRebuild.cjs` to
 * reconstruct a complete `active-index.json` row, not just its status.
 * `status`/`archivedAt` may be passed independently of `session` (or to
 * override `session.status`) for callers that only know the status.
 *
 * Never throws on a read failure (a missing/corrupt existing file is treated
 * as "start fresh"); a write failure propagates, matching every other atomic
 * writer in this codebase (config.cjs's writeTextAtomic, epicMint.cjs's own
 * writeActiveIndex).
 */
function mirrorEpicStatus(cwd, epicId, { session = null, status = null, archivedAt = null, writer = 'epics' } = {}) {
  const resolvedStatus = status || (session && session.status) || null;
  if (!cwd || !epicId || !resolvedStatus) return;
  const file = epicMirrorPath(cwd, epicId);
  assertOpsWrite(file, writer);
  const existing = readExistingMirror(file);
  const merged = {
    ...existing,
    ...(session || {}),
    id: epicId,
    cwd,
    status: resolvedStatus,
    archivedAt: archivedAt ?? existing.archivedAt ?? null,
    indexedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * removeEpicMirror(cwd, epicId) — best-effort delete of the mirror file, used
 * only by epicMint.cjs's removeEpic() rollback (undoing a mint whose caller
 * failed to complete its own work). Never throws — a missing file is a no-op.
 */
function removeEpicMirror(cwd, epicId) {
  if (!cwd || !epicId) return;
  try {
    fs.unlinkSync(epicMirrorPath(cwd, epicId));
  } catch { /* never existed, or already gone */ }
}

module.exports = { mirrorEpicStatus, removeEpicMirror, epicMirrorPath };
