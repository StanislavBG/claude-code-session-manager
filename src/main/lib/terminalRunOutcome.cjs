/**
 * terminalRunOutcome.cjs — history-independent fallback for detecting an
 * already-terminal (completed/failed) run for a PRD slug, by reading the
 * newest run directory's <slug>.meta.json + <slug>.verdicts.json sidecars
 * directly off disk instead of relying on history.jsonl (which may not
 * exist yet — see PRD 812-689-fix-fix-distribute-adminserver-routes).
 *
 * Pure-ish: takes an injectable runsDir + fsImpl so tests can point it at a
 * temp directory. Fails safe to null on any fs/JSON error so callers treat
 * "unknown" the same as "no history match" (resurrect as pending).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Completed-equivalent verdicts — a clean, exit-0 run with nothing left to fix. */
const COMPLETED_EQUIVALENT_VERDICTS = new Set([
  'clean',
  'pass_no_commit_target_verified',
  'pass_no_commit_already_shipped',
]);

// Bounds the scan: only the newest few run dirs are stat'd per slug, never
// the full runs/ directory (which can hold thousands of entries).
const MAX_DIRS_SCANNED = 5;

/**
 * Returns { status: 'completed'|'failed', runId, finishedAt } for the newest
 * run directory containing a `<slug>.meta.json`, or null if none is found or
 * any fs/JSON error occurs (fail-safe: caller falls back to resurrecting the
 * slug, unchanged current behavior).
 */
function latestTerminalOutcomeForSlug(slug, { runsDir, fsImpl = fs } = {}) {
  if (!slug || !runsDir) return null;
  let dirs;
  try {
    dirs = fsImpl.readdirSync(runsDir);
  } catch {
    return null;
  }
  if (!Array.isArray(dirs) || dirs.length === 0) return null;

  // Filter (cheap existence check) to dirs that actually have a run for this
  // slug, mirroring resolveRunId's existing pattern in scheduler.cjs — this
  // is a stat, not a read+parse.
  const matches = dirs.filter((d) => {
    try {
      return fsImpl.existsSync(path.join(runsDir, d, `${slug}.meta.json`));
    } catch {
      return false;
    }
  });
  if (!matches.length) return null;

  // Dir names are ISO timestamps with `:`/`.` replaced by `-` — lexical
  // descending sort is chronological descending. Only read+parse (the
  // expensive part) the newest few.
  matches.sort().reverse();
  const candidates = matches.slice(0, MAX_DIRS_SCANNED);

  for (const dir of candidates) {
    const metaPath = path.join(runsDir, dir, `${slug}.meta.json`);
    let meta;
    try {
      meta = JSON.parse(fsImpl.readFileSync(metaPath, 'utf8'));
    } catch {
      return null;
    }

    // meta.json's finishedAt is an epoch-ms number; callers (e.g. the
    // history-archive-candidate path, which feeds Date.parse) expect an ISO
    // string like queueHistory's finishedAt — normalize here.
    const finishedAt = typeof meta.finishedAt === 'number'
      ? new Date(meta.finishedAt).toISOString()
      : (meta.finishedAt ?? null);

    if (meta.exitCode !== 0) {
      return { status: 'failed', runId: dir, finishedAt };
    }

    const verdictsPath = path.join(runsDir, dir, `${slug}.verdicts.json`);
    let verdicts;
    try {
      verdicts = JSON.parse(fsImpl.readFileSync(verdictsPath, 'utf8'));
    } catch {
      return null;
    }

    if (COMPLETED_EQUIVALENT_VERDICTS.has(verdicts.verdict)) {
      return { status: 'completed', runId: dir, finishedAt };
    }
    return { status: 'failed', runId: dir, finishedAt };
  }
  return null;
}

module.exports = { latestTerminalOutcomeForSlug, COMPLETED_EQUIVALENT_VERDICTS, MAX_DIRS_SCANNED };
