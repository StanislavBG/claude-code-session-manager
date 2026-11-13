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
const { isNonClaudeAgentCli } = require('../agent-cli/agentCliEvents.cjs');

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
 * Default Epic lookup: the agentCli on the Epic's active-index row, else on its
 * status mirror (`<id>.json`, either `{session}`-wrapped or flat). null = Claude.
 */
function defaultAgentCliOf(cwd, epicId) {
  try {
    const { readActiveIndex } = require('./epicMint.cjs');
    const row = readActiveIndex(cwd).sessions[epicId];
    if (row && typeof row.agentCli === 'string') return row.agentCli;
  } catch { /* fall through */ }
  try {
    const { epicMirrorPath } = require('./epicStatusMirror.cjs');
    const m = JSON.parse(fs.readFileSync(epicMirrorPath(cwd, epicId), 'utf8'));
    const rec = m && m.session && typeof m.session === 'object' ? m.session : m;
    if (rec && typeof rec.agentCli === 'string') return rec.agentCli;
  } catch { /* absent */ }
  return null;
}

/**
 * archiveTranscript({cwd, epicId, claudeSessionId, agentCli?}, {resolvePath, agentCliOf}) -> pointer | null.
 * Reads the raw transcript main-side and writes the sidecar: the Claude JSONL for a
 * Claude Epic, the agent-CLI transcript (agentCliSessionStore.transcriptPathFor) for an
 * Epic with a non-Claude agentCli. null when the file is missing or empty (caller falls
 * back to durableTurns).
 */
function archiveTranscript(args, { resolvePath, agentCliOf } = {}) {
  const { cwd, epicId, claudeSessionId } = args || {};
  if (typeof cwd !== 'string' || !require('node:path').isAbsolute(cwd)) {
    throw new Error('archivedTranscript: cwd must be an absolute path');
  }
  assertSafeEpicId(epicId);
  if (typeof claudeSessionId !== 'string' || !claudeSessionId) return null;
  let agentCli = args && typeof args.agentCli === 'string' ? args.agentCli : null;
  if (!agentCli) {
    try { agentCli = (agentCliOf || defaultAgentCliOf)(cwd, epicId); } catch { agentCli = null; }
  }
  let file;
  try {
    file = isNonClaudeAgentCli(agentCli)
      ? require('../agent-cli/agentCliSessionStore.cjs').transcriptPathFor(claudeSessionId)
      : (resolvePath || ((c, s) => require('../../transcripts.cjs').transcriptPath(c, s)))(cwd, claudeSessionId);
  } catch {
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
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
