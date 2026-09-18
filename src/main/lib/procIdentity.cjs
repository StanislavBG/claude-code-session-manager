/**
 * procIdentity.cjs — fail-closed process identity, so a recycled pid can
 * never be mistaken for the process that originally held it.
 *
 * identity(pid) reads /proc/<pid>/stat field 22 (starttime) — located AFTER
 * the last ')', because `comm` (field 2) can itself contain spaces or
 * parens — plus /proc/<pid>/cmdline. On a platform with no /proc (macOS),
 * falls back to `ps -o lstart=,command=` (lstart has only second
 * granularity, which is the known limit of that path).
 *
 * isDifferentProcess(recorded, live) is the ONLY decision function callers
 * should use, and it is deliberately fail-closed in the SAFE direction: it
 * returns true — "safe to treat the recorded holder as gone" — ONLY when
 * BOTH sides are a complete identity AND they differ. An unreadable /proc
 * entry, a missing live probe, or a legacy record with no identity fields at
 * all all read as "not different" — i.e. today's pid-only behaviour, never a
 * false positive that could wrongly break a live lock or veto a real kill.
 *
 * SM_PROC_ROOT overrides the /proc root — tests only, so stat/cmdline
 * fixtures can be written under a temp dir instead of touching real /proc.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function procRoot() {
  return process.env.SM_PROC_ROOT || '/proc';
}

function hasProc() {
  try {
    return fs.existsSync(procRoot());
  } catch {
    return false;
  }
}

/** Field 22 (starttime) sits AFTER the last ')' — comm can hold spaces/parens. */
function parseStatStartTicks(raw) {
  const lastParen = raw.lastIndexOf(')');
  if (lastParen === -1) return null;
  const rest = raw.slice(lastParen + 1).trim();
  if (!rest) return null;
  const fields = rest.split(/\s+/);
  // `rest[0]` is field 3 (state); field N sits at index (N - 3), so field 22
  // (starttime) is index 19.
  const startTicksStr = fields[19];
  if (startTicksStr === undefined) return null;
  const startTicks = Number(startTicksStr);
  return Number.isFinite(startTicks) ? startTicks : null;
}

function readCmdlineFile(pid) {
  const raw = fs.readFileSync(path.join(procRoot(), String(pid), 'cmdline'), 'utf8');
  const cmd = raw.replace(/\0+$/, '').split('\0').join(' ').trim();
  return cmd.length > 0 ? cmd : null;
}

function identityFromProc(pid) {
  let startTicks = null;
  let cmdline = null;
  try {
    const raw = fs.readFileSync(path.join(procRoot(), String(pid), 'stat'), 'utf8');
    startTicks = parseStatStartTicks(raw);
  } catch { /* unreadable stat (dead pid, hidepid, race) — leave null */ }
  try {
    cmdline = readCmdlineFile(pid);
  } catch { /* unreadable cmdline — leave null */ }
  return { pid, startTicks, cmdline, complete: startTicks !== null && cmdline !== null };
}

function parseLstart(lstart) {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(lstart.trim());
  if (!m) return null;
  const monthIdx = MONTHS.indexOf(m[1]);
  if (monthIdx === -1) return null;
  const ms = Date.UTC(Number(m[6]), monthIdx, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(ms) ? ms : null;
}

function identityFromPs(pid) {
  let out;
  try {
    out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' });
  } catch {
    return { pid, startTicks: null, cmdline: null, complete: false };
  }
  const trimmed = out.replace(/\n$/, '');
  const m = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s(.*)$/.exec(trimmed);
  if (!m) return { pid, startTicks: null, cmdline: null, complete: false };
  const startTicks = parseLstart(m[1]);
  const cmdline = m[2].trim() || null;
  return { pid, startTicks, cmdline, complete: startTicks !== null && cmdline !== null };
}

/** identity(pid) → {pid, startTicks, cmdline, complete}. Never throws. */
function identity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid, startTicks: null, cmdline: null, complete: false };
  }
  try {
    return hasProc() ? identityFromProc(pid) : identityFromPs(pid);
  } catch {
    return { pid, startTicks: null, cmdline: null, complete: false };
  }
}

/**
 * isDifferentProcess(recorded, live) — true ONLY when both sides are a
 * COMPLETE identity and differ. Every other case (missing side, incomplete
 * side, a legacy record with no identity fields) is "not different", i.e.
 * today's pid-only behaviour — the fail-closed default.
 */
function isDifferentProcess(recorded, live) {
  if (!recorded || !live) return false;
  if (!recorded.complete || !live.complete) return false;
  return recorded.pid !== live.pid
    || recorded.startTicks !== live.startTicks
    || recorded.cmdline !== live.cmdline;
}

module.exports = { identity, isDifferentProcess };
