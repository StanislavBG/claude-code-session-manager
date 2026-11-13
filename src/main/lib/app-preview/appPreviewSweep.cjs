'use strict';

// appPreviewSweep.cjs — find and kill "Run preview" dev-server processes by
// their environment markers, not by process group.
//
// Why: dev servers often move children into their own session (concurrently,
// tsx watch, vite under pnpm), so a process-group kill misses them — the same
// leak scheduler/jobLeftovers.cjs documents for jobs. Every preview process
// inherits SM_PROC_ROLE=preview, SM_PREVIEW_EPIC_ID and SM_PREVIEW_OWNER_PID
// from appPreviewManager, and a setsid child keeps its environment, so /proc
// environ is the identity. Linux only; elsewhere every function is a no-op.

const fs = require('node:fs');
const path = require('node:path');
const { pidAlive: defaultPidAlive } = require('../process/pidAlive.cjs');

const ROLE_MARKER = 'SM_PROC_ROLE=preview';
const EPIC_MARKER = 'SM_PREVIEW_EPIC_ID=';
const OWNER_MARKER = 'SM_PREVIEW_OWNER_PID=';

/**
 * @returns {{ pid: number, epicId: string, ownerPid: number|null }[]}
 */
function scanPreviewProcesses({ fsImpl = fs, procRoot = process.env.SM_PROC_ROOT || '/proc', platform = process.platform } = {}) {
  if (platform !== 'linux') return [];
  let names;
  try {
    names = fsImpl.readdirSync(procRoot);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const n = String(name);
    if (!/^\d+$/.test(n)) continue;
    let env;
    try {
      env = String(fsImpl.readFileSync(path.join(procRoot, n, 'environ'), 'utf8')).split('\0');
    } catch { continue; }
    if (!env.includes(ROLE_MARKER)) continue;
    const epicEntry = env.find((e) => e.startsWith(EPIC_MARKER));
    const epicId = epicEntry ? epicEntry.slice(EPIC_MARKER.length) : '';
    if (!epicId) continue;
    const ownerEntry = env.find((e) => e.startsWith(OWNER_MARKER));
    const owner = ownerEntry ? Number(ownerEntry.slice(OWNER_MARKER.length)) : NaN;
    out.push({ pid: Number(n), epicId, ownerPid: Number.isInteger(owner) && owner > 0 ? owner : null });
  }
  return out;
}

function signalAll(pids, kill) {
  let count = 0;
  for (const pid of pids) {
    try {
      kill(pid, 'SIGKILL');
      count += 1;
    } catch { /* already gone or not ours */ }
  }
  return count;
}

/** SIGKILL every preview process of `epicId` (never this process). Returns the count signalled. */
function killPreviewProcesses(epicId, opts = {}) {
  try {
    if (typeof epicId !== 'string' || epicId === '') return 0;
    const kill = opts.kill || process.kill.bind(process);
    const selfPid = opts.selfPid || process.pid;
    const pids = scanPreviewProcesses(opts)
      .filter((p) => p.epicId === epicId && p.pid !== selfPid)
      .map((p) => p.pid);
    return signalAll(pids, kill);
  } catch {
    return 0;
  }
}

/** SIGKILL preview processes whose owning app is gone (boot sweep). Returns the count signalled. */
function sweepOrphanedPreviews(opts = {}) {
  try {
    const kill = opts.kill || process.kill.bind(process);
    const pidAlive = opts.pidAlive || defaultPidAlive;
    const selfPid = opts.selfPid || process.pid;
    const pids = scanPreviewProcesses(opts)
      .filter((p) => p.pid !== selfPid && p.ownerPid !== selfPid && !pidAlive(p.ownerPid))
      .map((p) => p.pid);
    return signalAll(pids, kill);
  } catch {
    return 0;
  }
}

module.exports = { scanPreviewProcesses, killPreviewProcesses, sweepOrphanedPreviews };
