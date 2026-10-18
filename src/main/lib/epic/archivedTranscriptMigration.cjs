'use strict';

/**
 * archivedTranscriptMigration.cjs — one-shot, idempotent, crash-safe move of the
 * embedded `transcript` string in archived Epic JSONs into the gzip sidecar
 * (archivedTranscript.cjs). Per file: write sidecar -> re-read + compare sha ->
 * only then atomically rewrite the JSON with `transcriptRef` and no `transcript`.
 * A crash or failure before the rewrite leaves the original JSON byte-identical.
 *
 * Never touches `active-index.json` or files whose status is 'active'.
 * Writes as the `epics` owner (the sidecar lives inside `prompt-sessions`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertOpsWrite, opsPath } = require('../opsOwnership.cjs');
const atomicFs = require('../util/atomicFs.cjs');
const archivedTranscript = require('./archivedTranscript.cjs');

const SKIP_FILES = new Set(['active-index.json']);

/**
 * migrateProject(projectRoot, {dryRun, limit, yieldFn, deps})
 *   -> Promise<{scanned, migrated, skipped, freedBytes, errors}>
 * `limit` caps files migrated (or failed) per call; dryRun counts what would
 * migrate without writing. `deps` lets tests inject the sidecar functions.
 */
async function migrateProject(projectRoot, { dryRun = false, limit = Infinity, yieldFn = null, deps = {} } = {}) {
  const writeSidecar = deps.writeSidecar || archivedTranscript.writeSidecar;
  const readSidecar = deps.readSidecar || archivedTranscript.readSidecar;
  const result = { scanned: 0, migrated: 0, skipped: 0, freedBytes: 0, errors: [] };
  const dir = opsPath(projectRoot, 'prompt-sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return result;
  }
  let attempted = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || SKIP_FILES.has(name)) continue;
    if (attempted >= limit) break;
    result.scanned += 1;
    const file = path.join(dir, name);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      // Cheap pre-check so files without a transcript are never JSON-parsed.
      if (!raw.includes('"transcript"')) { result.skipped += 1; continue; }
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || typeof doc.transcript !== 'string' || doc.status === 'active') {
        result.skipped += 1;
        continue;
      }
      attempted += 1;
      const epicId = name.slice(0, -'.json'.length);
      if (dryRun) {
        result.migrated += 1;
        result.freedBytes += Buffer.byteLength(doc.transcript, 'utf8');
        continue;
      }
      assertOpsWrite(file, 'epics');
      const ref = writeSidecar(projectRoot, epicId, doc.transcript);
      const back = readSidecar(projectRoot, epicId);
      if (typeof back !== 'string' || archivedTranscriptSha(back) !== ref.sha256) {
        throw new Error('sidecar sha mismatch');
      }
      const { transcript: _drop, ...rest } = doc;
      const next = { ...rest, transcriptRef: { path: ref.path, bytes: ref.bytes, gzBytes: ref.gzBytes, sha256: ref.sha256 } };
      atomicFs.writeJsonAtomicSync(file, next);
      result.migrated += 1;
      result.freedBytes += Math.max(0, Buffer.byteLength(raw, 'utf8') - fs.statSync(file).size);
    } catch (e) {
      result.errors.push({ file: name, error: e && e.message ? e.message : String(e) });
    }
    if (yieldFn) await yieldFn();
  }
  return result;
}

function archivedTranscriptSha(text) {
  return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { migrateProject };
