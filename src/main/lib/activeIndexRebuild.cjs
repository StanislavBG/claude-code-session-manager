'use strict';

/**
 * activeIndexRebuild.cjs — reconstructs `active-index.json` from the
 * per-Epic status mirrors `epicStatusMirror.cjs` writes onto `prompt-
 * sessions/<epicId>.json`. This is the recovery path for the incident the
 * mirror exists to survive: a lost, clobbered, git-reverted, or
 * worktree-snapshotted index that would otherwise silently erase every open
 * Epic it held with no way to get them back.
 *
 * Rebuild NEVER mints — SINGLE-CREATOR LAW (epicMint.cjs) is untouched
 * because no new Epic id is ever created here, only rows for ids that
 * already have a mirrored file re-materialized. It also never resurrects a
 * tombstoned or archived Epic (see the two "never resurrect" guards below) —
 * a human's delete/complete decision always wins.
 */

const fs = require('node:fs');
const path = require('node:path');
const { activeIndexPath, readActiveIndex, writeActiveIndex, withPathLock } = require('./epicMint.cjs');

function promptSessionsDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions');
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function listMirrorFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.json') && f !== 'active-index.json');
}

/**
 * rebuildActiveIndex(cwd, { dryRun? }) → { rows, skipped, reasons }
 *
 * `rows` — reconstructed PromptSession objects, one per mirrored file that
 *   is a live (proposed/active), non-tombstoned, non-archived Epic. These
 *   become the new `sessions` map (dryRun: false is the default — pass
 *   `{ dryRun: true }` to preview without writing).
 * `skipped` — file names not turned into a row.
 * `reasons` — `{ [fileName]: humanReadableReason }`, one entry per skipped
 *   file. A file is never guessed at: no mirrored `status` is a skip, not a
 *   fabricated 'unknown' row (see scripts/mirror-epic-status.cjs for the
 *   only place that vocabulary is deliberately introduced, for the
 *   migration's own back-fill bookkeeping).
 *
 * `events` and `tombstones` from the existing on-disk index (if any) are
 * carried through completely untouched — this function only ever
 * reconstructs `sessions`.
 */
function rebuildActiveIndex(cwd, { dryRun = false } = {}) {
  if (!cwd || typeof cwd !== 'string') throw new Error('rebuildActiveIndex: cwd is required');
  cwd = path.resolve(cwd);
  return withPathLock(activeIndexPath(cwd), () => {
    const dir = promptSessionsDir(cwd);
    const existing = readActiveIndex(cwd);
    const tombstones = existing.tombstones || {};
    const files = listMirrorFiles(dir);

    const rows = [];
    const skipped = [];
    const reasons = {};

    for (const file of files) {
      const id = file.slice(0, -'.json'.length);
      const full = path.join(dir, file);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (e) {
        skipped.push(file);
        reasons[file] = `unreadable: ${e.message}`;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        skipped.push(file);
        reasons[file] = 'unreadable: not a JSON object';
        continue;
      }
      // Never resurrected — a tombstoned id stays out even if its file says
      // 'active' (see activeIndexMerge.cjs's header on why tombstones are
      // never auto-cleared).
      if (hasOwn(tombstones, id)) {
        skipped.push(file);
        reasons[file] = 'tombstoned — never resurrected by a rebuild';
        continue;
      }
      if (!parsed.status) {
        skipped.push(file);
        reasons[file] = 'no status mirror on this file — never guessed at';
        continue;
      }
      // A completed archive (markCompleted's PromptSessionArchive, or any
      // mirror written after archival) is never restored as a live row.
      if (parsed.archivedAt) {
        skipped.push(file);
        reasons[file] = 'archivedAt is set — completed Epic, not a live row';
        continue;
      }
      if (parsed.status !== 'proposed' && parsed.status !== 'active') {
        skipped.push(file);
        reasons[file] = `status '${parsed.status}' is not a live row`;
        continue;
      }
      // Drop mirror-only bookkeeping (`indexedAt`) — it is not part of the
      // PromptSession shape active-index.json's `sessions` map holds.
      const { indexedAt, archivedAt, ...row } = parsed;
      rows.push({ ...row, id, cwd: parsed.cwd || cwd });
    }

    if (!dryRun) {
      const sessions = {};
      for (const row of rows) sessions[row.id] = row;
      writeActiveIndex(cwd, {
        sessions,
        events: existing.events || {},
        tombstones,
      });
    }

    return { rows, skipped, reasons };
  });
}

module.exports = { rebuildActiveIndex };
