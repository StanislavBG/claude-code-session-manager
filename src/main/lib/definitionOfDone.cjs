'use strict';

/**
 * definitionOfDone.cjs — pure helpers for the definition-of-done drain gate.
 *
 * No scheduler imports; no side effects beyond fs reads in reportExists.
 * The scheduler wires these in (PRD 111).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Regex identifying meta/dod slugs that must NOT influence the batchKey.
// This is the load-bearing loop-avoidance filter: when the gate job itself
// completes, the real batchKey must remain unchanged so the drain branch stays
// a no-op (idempotent) instead of re-firing forever.
const DOD_SLUG_RE = /(^|-)dod(-|$)|definition-of-done/i;

const RUNS_DIR = path.join(
  os.homedir(),
  '.claude', 'session-manager', 'scheduled-plans', 'runs'
);

/**
 * Compute a stable short hash for a completed job-set.
 *
 * Complexity: O(n log n) for the sort over n completed jobs; n is small
 * (the scheduler queue, not user-scaled data).
 *
 * @param {Array<{slug: string, runId: string}>} jobs
 * @returns {string} 8-char hex prefix of SHA-1 over sorted identity strings
 */
function batchKey(jobs) {
  const identities = jobs
    .filter(j => !DOD_SLUG_RE.test(j.slug))
    .map(j => `${j.slug}@${j.runId}`)
    .sort();

  return crypto
    .createHash('sha1')
    .update(identities.join('\n'))
    .digest('hex')
    .slice(0, 8);
}

/**
 * Canonical path for a DoD report file in a new timestamped run directory.
 * Callers that write the report must create the directory themselves.
 *
 * NOTE: each call mints a fresh timestamp, so every call returns a DIFFERENT
 * path even for the same key. Call once, save the result, reuse it — do not
 * call twice expecting the same directory.
 *
 * @param {string} key  Output of batchKey()
 * @returns {string}    Absolute path under runs/<iso-ts>/definition-of-done-<key>.md
 */
function reportPathFor(key) {
  if (!/^[0-9a-f]+$/.test(key)) throw new Error(`invalid batchKey: ${key}`);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(RUNS_DIR, ts, `definition-of-done-${key}.md`);
}

/**
 * Return true if a DoD report for this batchKey already exists in any
 * run subdirectory. Scans runs/<ts>/ (shallow, one level).
 *
 * @param {string} key       Output of batchKey()
 * @param {string} [runsDir] Override for testing; defaults to RUNS_DIR
 * @returns {boolean}
 */
function reportExists(key, runsDir = RUNS_DIR) {
  if (!/^[0-9a-f]+$/.test(key)) throw new Error(`invalid batchKey: ${key}`);
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const target = `definition-of-done-${key}.md`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name, target);
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

module.exports = { batchKey, reportPathFor, reportExists };
