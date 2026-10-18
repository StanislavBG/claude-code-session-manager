'use strict';

/**
 * archivedTranscript.cjs — gzip sidecar store for the raw Claude JSONL that
 * archived Epic JSONs used to embed as a `transcript` string. The sidecar
 * lives at `prompt-sessions/transcripts-archive/<epicId>.jsonl.gz` (inside the
 * `prompt-sessions` namespace, so the `epics` owner already covers it) and the
 * caller keeps only the small pointer returned by writeSidecar.
 *
 * Electron-free at load (like epicStatusMirror.cjs); registerIpc takes ipcMain.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { assertOpsWrite, opsPath } = require('../opsOwnership.cjs');
const atomicFs = require('../util/atomicFs.cjs');

const SUBDIR = 'transcripts-archive';

function assertSafeEpicId(epicId) {
  if (typeof epicId !== 'string' || !epicId || epicId.includes('..') || /[\\/\0]/.test(epicId)) {
    throw new Error(`archivedTranscript: invalid epicId "${epicId}"`);
  }
}

function sidecarPath(cwd, epicId) {
  assertSafeEpicId(epicId);
  return opsPath(cwd, 'prompt-sessions', SUBDIR, `${epicId}.jsonl.gz`);
}

const sha256Of = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * writeSidecar(cwd, epicId, text) -> {path, bytes, gzBytes, sha256}.
 * Idempotent: if the existing sidecar already decompresses to the same text,
 * nothing is rewritten.
 */
function writeSidecar(cwd, epicId, text, { writer = 'epics' } = {}) {
  if (typeof text !== 'string') throw new Error('archivedTranscript: text must be a string');
  const file = sidecarPath(cwd, epicId);
  assertOpsWrite(file, writer);
  const sha256 = sha256Of(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  const existing = readSidecar(cwd, epicId);
  if (existing !== null && sha256Of(existing) === sha256) {
    return { path: file, bytes, gzBytes: fs.statSync(file).size, sha256 };
  }
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
  atomicFs.writeTextAtomicSync(file, gz);
  return { path: file, bytes, gzBytes: gz.length, sha256 };
}

/** readSidecar(cwd, epicId) -> string | null (null when absent or unreadable). */
function readSidecar(cwd, epicId) {
  const file = sidecarPath(cwd, epicId);
  try {
    return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * archiveTranscript({cwd, epicId, claudeSessionId}, {resolvePath}) -> pointer | null.
 * Reads the raw Claude JSONL main-side and writes the sidecar; null when the
 * JSONL is missing or empty (caller falls back to durableTurns).
 */
function archiveTranscript(args, { resolvePath } = {}) {
  const { cwd, epicId, claudeSessionId } = args || {};
  if (typeof cwd !== 'string' || !require('node:path').isAbsolute(cwd)) {
    throw new Error('archivedTranscript: cwd must be an absolute path');
  }
  assertSafeEpicId(epicId);
  if (typeof claudeSessionId !== 'string' || !claudeSessionId) return null;
  const resolve = resolvePath || ((c, s) => require('../../transcripts.cjs').transcriptPath(c, s));
  let text;
  try {
    text = fs.readFileSync(resolve(cwd, claudeSessionId), 'utf8');
  } catch {
    return null;
  }
  if (!text) return null;
  return writeSidecar(cwd, epicId, text);
}

function registerIpc(ipcMain, deps) {
  ipcMain.handle('promptSessions:archiveTranscript', async (_e, payload) => archiveTranscript(payload, deps));
}

module.exports = { writeSidecar, readSidecar, sidecarPath, archiveTranscript, registerIpc };
