'use strict';

/**
 * epicTranscriptRestore.cjs — guarantee the Claude CLI can find a completed Epic's transcript
 * from the cwd it will be resumed in.
 *
 * `claude --resume <id>` only finds `~/.claude/projects/<encodeCwd(spawn cwd)>/<id>.jsonl`.
 * Reopening a completed Epic must never fall back to a fresh `--session-id`: that silently
 * starts a context-less conversation (the reported "Resume starts a new session" bug). A
 * completed Epic's JSONL can sit under an old worktree encoding, or be gone entirely
 * (Claude Code's cleanupPeriodDays) while our gzip sidecar still holds it. This module copies
 * or restores it to the spawn cwd's encoding. It never overwrites a non-empty target and never
 * moves or deletes a source.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('../util/encodeCwd.cjs');
const atomicFs = require('../util/atomicFs.cjs');
const { resolveEpicTranscriptPath } = require('./epicTranscriptPath.cjs');
const { readSidecar } = require('./archivedTranscript.cjs');

const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const isValidSid = (sid) => typeof sid === 'string' && SID_RE.test(sid);

function isNonEmptyFile(p, deps) {
  try {
    const st = (deps.statSync || fs.statSync)(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function fileFor(dir, sid, deps) {
  return path.join(deps.homeDir || os.homedir(), '.claude', 'projects', encodeCwd(dir), `${sid}.jsonl`);
}

function sidecarText(cwd, epicId) {
  try {
    const t = readSidecar(cwd, epicId);
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Find the first source: reachable file, other JSONL, or sidecar. No writes. */
function locate({ cwd, epicId, sid, spawnCwd, deps }) {
  for (const dir of [...new Set([spawnCwd, cwd].filter(Boolean))]) {
    const p = fileFor(dir, sid, deps);
    if (isNonEmptyFile(p, deps)) return { kind: 'none', path: p };
  }
  let resolved = null;
  try {
    resolved = resolveEpicTranscriptPath({ cwd, claudeSessionId: sid, deps });
  } catch {
    resolved = null;
  }
  if (resolved && resolved.existsAnywhere && resolved.path && isNonEmptyFile(resolved.path, deps)) {
    return { kind: 'copied', path: resolved.path };
  }
  const text = sidecarText(cwd, epicId);
  if (text) return { kind: 'sidecar', text };
  return null;
}

/**
 * @param {{ cwd: string, epicId: string, claudeSessionId: string, deps?: object }} opts
 * @returns {boolean}
 */
function hasTranscriptSource({ cwd, epicId, claudeSessionId, spawnCwd, deps = {} } = {}) {
  if (!isValidSid(claudeSessionId) || !cwd) return false;
  return locate({ cwd, epicId, sid: claudeSessionId, spawnCwd: spawnCwd || cwd, deps }) !== null;
}

/**
 * @param {{ cwd: string, epicId: string, claudeSessionId: string, spawnCwd?: string, deps?: object }} opts
 * @returns {{ ok: true, path: string, restored: 'none'|'copied'|'sidecar' } | { ok: false, code: 'transcript_missing'|'invalid_session_id'|'restore_failed', message: string }}
 */
function ensureEpicTranscriptReachable({ cwd, epicId, claudeSessionId, spawnCwd, deps = {} } = {}) {
  if (!isValidSid(claudeSessionId)) {
    return { ok: false, code: 'invalid_session_id', message: 'Invalid Claude session id.' };
  }
  const sid = claudeSessionId;
  const target = fileFor(spawnCwd || cwd, sid, deps);
  const found = locate({ cwd, epicId, sid, spawnCwd, deps });
  if (!found) {
    return {
      ok: false,
      code: 'transcript_missing',
      message: `No saved transcript for session ${sid} — it cannot be resumed. Use "Duplicate as new session" to start a fresh one.`,
    };
  }
  if (found.kind === 'none') return { ok: true, path: found.path, restored: 'none' };
  try {
    const text = found.kind === 'copied' ? fs.readFileSync(found.path, 'utf8') : found.text;
    // Re-check right before writing: never overwrite a non-empty target.
    if (isNonEmptyFile(target, deps)) return { ok: true, path: target, restored: 'none' };
    atomicFs.writeTextAtomicSync(target, text, { mode: 0o600 });
    return { ok: true, path: target, restored: found.kind };
  } catch (err) {
    return { ok: false, code: 'restore_failed', message: `Could not restore transcript for session ${sid}: ${err && err.message ? err.message : err}` };
  }
}

module.exports = { hasTranscriptSource, ensureEpicTranscriptReachable };
