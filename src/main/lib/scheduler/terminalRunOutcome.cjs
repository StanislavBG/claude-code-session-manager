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
  'pass_no_commit_prior_run_verified',
  'pass_no_commit_artifact_verified',
]);

// Bounds the scan: only the newest few run dirs are stat'd per slug, never
// the full runs/ directory (which can hold thousands of entries).
const MAX_DIRS_SCANNED = 5;

// runsDir -> { dirFiles: Map<dirName, Set<slug>> } — slugs whose
// <slug>.meta.json exists in that run dir. Dirs older than IMMUTABLE_AFTER_MS
// are listed once and cached for good; younger ones are re-listed each call.
const indexes = new Map();
const IMMUTABLE_AFTER_MS = 24 * 60 * 60 * 1000;
const META_SUFFIX = '.meta.json';

/** Run-dir name (ISO with ':'/'.' -> '-') to epoch ms, or NaN. */
function runDirTime(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

function isYoung(name, now) {
  const t = runDirTime(name);
  return Number.isNaN(t) || now - t < IMMUTABLE_AFTER_MS;
}

function refreshIndex(runsDir, fsImpl) {
  const names = fsImpl.readdirSync(runsDir); // throws -> caller returns null
  if (!Array.isArray(names)) return new Map();
  let idx = indexes.get(runsDir);
  if (!idx) {
    idx = { dirFiles: new Map() };
    indexes.set(runsDir, idx);
  }
  const present = new Set(names);
  for (const cached of idx.dirFiles.keys()) {
    if (!present.has(cached)) idx.dirFiles.delete(cached);
  }
  const now = Date.now();
  for (const name of names) {
    if (idx.dirFiles.has(name) && !isYoung(name, now)) continue;
    const slugs = new Set();
    try {
      for (const f of fsImpl.readdirSync(path.join(runsDir, name))) {
        if (typeof f === 'string' && f.endsWith(META_SUFFIX)) slugs.add(f.slice(0, -META_SUFFIX.length));
      }
    } catch {
      // unlistable dir (e.g. a stray file) — treat as having no runs
    }
    idx.dirFiles.set(name, slugs);
  }
  return idx.dirFiles;
}

function matchingDirs(slug, runsDir, fsImpl) {
  const dirFiles = refreshIndex(runsDir, fsImpl);
  const out = [];
  for (const [name, slugs] of dirFiles) if (slugs.has(slug)) out.push(name);
  return out;
}

function __resetRunIndexForTests() {
  indexes.clear();
}

/**
 * Returns { status: 'completed'|'failed', runId, finishedAt } for the newest
 * run directory containing a `<slug>.meta.json`, or null if none is found or
 * any fs/JSON error occurs (fail-safe: caller falls back to resurrecting the
 * slug, unchanged current behavior).
 */
function latestTerminalOutcomeForSlug(slug, { runsDir, fsImpl = fs } = {}) {
  if (!slug || !runsDir) return null;
  let matches;
  try {
    matches = matchingDirs(slug, runsDir, fsImpl);
  } catch {
    return null;
  }
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
      // An unreadable/half-written sidecar in THIS dir says nothing about the
      // older ones — fall through to the next-newest candidate rather than
      // abandoning the scan. Returning null here made the caller treat the
      // slug as having no terminal run at all, which resurrects and re-runs
      // an already-completed PRD (the anti-resurrection guard silently
      // switching itself off on the one input it exists to survive). This is
      // also what makes MAX_DIRS_SCANNED mean what its name says: before,
      // every branch below returned on the FIRST candidate, so the newest dir
      // was the only one ever consulted.
      continue;
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
      // Same reasoning as the meta read above: a run whose verdicts sidecar
      // never landed (killed between the two writes) must not erase an older,
      // complete terminal record for this slug.
      continue;
    }

    if (COMPLETED_EQUIVALENT_VERDICTS.has(verdicts.verdict)) {
      return { status: 'completed', runId: dir, finishedAt };
    }
    return { status: 'failed', runId: dir, finishedAt };
  }
  return null;
}

module.exports = { latestTerminalOutcomeForSlug, __resetRunIndexForTests, COMPLETED_EQUIVALENT_VERDICTS, MAX_DIRS_SCANNED };
