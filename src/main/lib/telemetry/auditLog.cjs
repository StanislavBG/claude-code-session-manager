/**
 * auditLog.cjs — append-only trace of every Epic/PRD creation, so a rogue or
 * unexpected Epic/PRD can always be traced back to its origin.
 *
 * Deliberately machine-level (~/.claude/session-manager/), not under any
 * project's session-manager-operations/ — this is a security trace, not app
 * state a project's single-writer law needs to arbitrate, and it must
 * survive even if the project's ops root doesn't exist yet.
 *
 * Rotation: on the first append in a new calendar month (UTC) the live file is
 * gzipped to audit-log-<YYYY-MM>.jsonl.gz beside it (YYYY-MM = the month of the
 * file's last write) and a fresh live file starts; the newest MAX_ROLLED rolled
 * files are kept. The live file stays plain JSONL, so readers are unaffected.
 *
 * Best-effort only: a logging failure must never block the mint/create it is
 * observing (same posture as rcaReport.cjs / dodDrainHook.cjs).
 *
 * Plain Node module (no Electron deps) so scripts/mint-epic.cjs and
 * scripts/mint-epic.cjs (which runs outside Electron) can require it too.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { auditLogPath } = require('../scheduler/schedulerPaths.cjs');

/**
 * Best-effort identity of the process making this call — there is no
 * cryptographic caller identity available across the admin HTTP API (bearer
 * token proves "runs as this OS user", not "which agent/session"), so this
 * captures every breadcrumb that IS available: this process's pid/ppid, and
 * (when set) the claude session id chatRunner.cjs stamps on headless
 * `claude -p` children and passes down to MCP server children.
 */
function callerContext() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    claudeSessionId: process.env.SM_CHAT_SESSION_ID || null,
  };
}

const MAX_ROLLED = 6;
const ROLLED_RE = /^audit-log-\d{4}-\d{2}\.jsonl\.gz$/;

function monthKey(d) { return d.toISOString().slice(0, 7); }

/** Roll the live file if its last write was in an earlier month than `now`; prune old rolls. */
function rotateIfNewMonth(target, now) {
  let st;
  try { st = fs.statSync(target); } catch { return; }
  if (!st.isFile() || st.size === 0) return;
  const oldMonth = monthKey(st.mtime);
  if (oldMonth === monthKey(now)) return;
  const dir = path.dirname(target);
  const base = path.basename(target, path.extname(target));
  const rolled = path.join(dir, `${base}-${oldMonth}.jsonl.gz`);
  // appendFileSync: gzip members concatenate, so a pre-existing roll for that month is extended.
  fs.appendFileSync(rolled, zlib.gzipSync(fs.readFileSync(target)));
  fs.unlinkSync(target);
  const rolls = fs.readdirSync(dir).filter((f) => ROLLED_RE.test(f)).sort();
  for (const f of rolls.slice(0, Math.max(0, rolls.length - MAX_ROLLED))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ }
  }
}

/**
 * appendAuditEvent(kind, fields, opts?) — append one JSONL record. `kind` is a short
 * label ('epic_mint' | 'prd_create' | ...); `fields` is event-specific detail
 * (cwd, epicId, status, title, slug, etc). `opts.now` (Date) / `opts.target` are
 * test seams. Never throws; a rotation failure never drops the append.
 */
function appendAuditEvent(kind, fields = {}, opts = {}) {
  try {
    const now = opts.now ?? new Date();
    const record = {
      at: now.toISOString(),
      kind,
      ...fields,
      caller: callerContext(),
    };
    const target = opts.target ?? auditLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      rotateIfNewMonth(target, now);
    } catch (e) {
      console.error('[auditLog] rotation failed', e?.message ?? String(e));
    }
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`);
  } catch (e) {
    console.error('[auditLog] failed to append audit event', e?.message ?? String(e));
  }
}

/**
 * readTail(maxBytes, target?) → string[] — the complete JSONL lines within the
 * last `maxBytes` of the log, oldest first. O(maxBytes), never O(file): the
 * live log is a provenance record that rolls monthly but can still be large. A
 * line cut by the window's start is dropped. Missing/unreadable file → [].
 */
function readTail(maxBytes, target = auditLogPath()) {
  let fd;
  try {
    fd = fs.openSync(target, 'r');
    const { size } = fs.fstatSync(fd);
    const readSize = Math.min(Math.max(0, maxBytes), size);
    if (readSize === 0) return [];
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    const lines = buf.toString('utf8').split('\n');
    if (readSize < size) lines.shift(); // first element is a partial line
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* */ } }
  }
}

module.exports = { appendAuditEvent, auditLogPath, readTail };
