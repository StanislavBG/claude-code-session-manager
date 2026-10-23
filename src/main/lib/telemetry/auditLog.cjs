/**
 * auditLog.cjs — append-only trace of every Epic/PRD creation, so a rogue or
 * unexpected Epic/PRD can always be traced back to its origin.
 *
 * Deliberately machine-level (~/.claude/session-manager/), not under any
 * project's session-manager-operations/ — this is a security trace, not app
 * state a project's single-writer law needs to arbitrate, and it must
 * survive even if the project's ops root doesn't exist yet.
 *
 * Rotation: on the first append in a new calendar month (UTC), or once the live file passes
 * 32 MB, the live file is renamed synchronously and then stream-gzipped (async) to audit-log-<YYYY-MM>.jsonl.gz beside it (YYYY-MM = the month of the
 * file's last write) and a fresh live file starts; the newest `auditLogMonths` rolled
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
const { pipeline } = require('node:stream/promises');

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

const DEFAULT_MAX_ROLLED = 6;

/** Rolled-file cap from ops-retention.json (one file read per rotation); 6 if unreadable. */
function maxRolled() {
  try {
    const n = require('../opsRetentionSettings.cjs').read().auditLogMonths;
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_ROLLED;
  } catch { return DEFAULT_MAX_ROLLED; }
}
const ROLLED_RE = /^audit-log-\d{4}-\d{2}\.jsonl\.gz$/;

function monthKey(d) { return d.toISOString().slice(0, 7); }

const MAX_LIVE_BYTES = 32 * 1024 * 1024;
let rollSeq = 0;
const inflight = new Set(); // renamed files currently being compressed
let chain = Promise.resolve();
const settling = new Set(); // promises of in-progress compressions

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function pruneRolled(dir) {
  const rolls = fs.readdirSync(dir).filter((f) => ROLLED_RE.test(f)).sort();
  for (const f of rolls.slice(0, Math.max(0, rolls.length - maxRolled()))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ }
  }
}

/** Stream-gzip `pending` onto the month archive (append: members concatenate), then unlink it. */
async function compressPending(pending, rolled, dir) {
  let before = 0;
  try { before = fs.statSync(rolled).size; } catch { /* new archive */ }
  try {
    await pipeline(fs.createReadStream(pending), zlib.createGzip(), fs.createWriteStream(rolled, { flags: 'a' }));
  } catch (e) {
    // Drop any partial gzip member so the archive stays valid; the pending file is kept for retry.
    try { if (fs.existsSync(rolled)) fs.truncateSync(rolled, before); } catch { /* best-effort */ }
    throw e;
  }
  fs.unlinkSync(pending);
  try { pruneRolled(dir); } catch { /* best-effort */ }
}

function startCompress(pending, rolled, dir) {
  if (inflight.has(pending)) return;
  inflight.add(pending);
  // Serialized: two members appended to one archive concurrently would interleave.
  const p = chain.then(() => compressPending(pending, rolled, dir))
    .catch((e) => { console.error('[auditLog] roll compress failed; will retry', e?.message ?? String(e)); })
    .finally(() => { inflight.delete(pending); settling.delete(p); });
  chain = p;
  settling.add(p);
}

/** Resolves once every in-flight roll compression has finished (success or failure). Test seam. */
async function settleRolls() {
  while (settling.size) await Promise.all([...settling]);
}

/**
 * Roll the live file if its last write was in an earlier month than `now`, or it
 * exceeds `maxBytes`. The rename is synchronous; compression is async. Leftover
 * renamed files from a failed compress are retried here.
 */
function rotateIfNeeded(target, now, maxBytes) {
  let st;
  try { st = fs.statSync(target); } catch { return; }
  if (!st.isFile() || st.size === 0) return;
  const oldMonth = monthKey(st.mtime);
  if (oldMonth === monthKey(now) && st.size <= maxBytes) return;
  const dir = path.dirname(target);
  const base = path.basename(target, path.extname(target));
  const pending = path.join(dir, `${base}-${oldMonth}.jsonl.rolling-${Date.now().toString(36)}${(rollSeq++).toString(36)}`);
  fs.renameSync(target, pending);
  const pendingRe = new RegExp(`^${escapeRe(base)}-(\\d{4}-\\d{2})\\.jsonl\\.rolling-[a-z0-9]+$`);
  for (const f of fs.readdirSync(dir)) {
    const m = pendingRe.exec(f);
    if (m) startCompress(path.join(dir, f), path.join(dir, `${base}-${m[1]}.jsonl.gz`), dir);
  }
  try { pruneRolled(dir); } catch { /* best-effort */ }
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
      rotateIfNeeded(target, now, opts.maxBytes ?? MAX_LIVE_BYTES);
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

module.exports = { appendAuditEvent, settleRolls, MAX_LIVE_BYTES, auditLogPath, readTail };
