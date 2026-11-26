'use strict';

/**
 * peerChatSession.cjs — given the accepted socket of a loopback HTTP request,
 * find the client process and read SM_CHAT_SESSION_ID / SM_PROJECT_ROOT from
 * its environment (or its nearest ancestor's; up to 6 hops). Lets a press made
 * from an SM chat (agent curl from its Bash tool) record the asking Epic.
 *
 * Read-only, same-uid processes only. Never logs or returns the environment —
 * only the two variables. Never throws or rejects; null on any miss.
 * Linux: /proc. darwin: lsof + ps (execFile, no shell). Others: null.
 */

const nodeFs = require('fs');
const childProcess = require('child_process');

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_HOPS = 6;
const DEADLINE_MS = 1500;

function pickVars(envMap) {
  const id = envMap.SM_CHAT_SESSION_ID;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const root = envMap.SM_PROJECT_ROOT;
  return { chatSessionId: id, projectRoot: typeof root === 'string' && root ? root : null };
}

function parseEnviron(buf) {
  const out = {};
  for (const part of String(buf).split('\0')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i);
    if (k === 'SM_CHAT_SESSION_ID' || k === 'SM_PROJECT_ROOT') out[k] = part.slice(i + 1);
  }
  return out;
}

// ── Linux ──────────────────────────────────────────────────────────────────

function findInode(fs, clientLocalPort, serverPort) {
  const lp = clientLocalPort.toString(16).toUpperCase().padStart(4, '0');
  const rp = serverPort.toString(16).toUpperCase().padStart(4, '0');
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of String(text).split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      const l = (c[1] || '').split(':')[1];
      const r = (c[2] || '').split(':')[1];
      if (l && r && l.toUpperCase() === lp && r.toUpperCase() === rp && c[9] && c[9] !== '0') return c[9];
    }
  }
  return null;
}

function findPidByInode(fs, inode, uid, deadline, now) {
  const want = `socket:[${inode}]`;
  let pids;
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return null; }
  for (const pid of pids) {
    if (now() > deadline) return null;
    try {
      if (uid != null && fs.statSync(`/proc/${pid}`).uid !== uid) continue;
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === want) return Number(pid);
        } catch { /* fd vanished / EACCES */ }
      }
    } catch { /* EACCES / gone */ }
  }
  return null;
}

function linuxResolve(socket, deps, deadline, now) {
  const fs = deps.fs || nodeFs;
  const uid = deps.getuid ? deps.getuid() : (typeof process.getuid === 'function' ? process.getuid() : null);
  const inode = findInode(fs, socket.remotePort, socket.localPort);
  if (!inode) return null;
  let pid = findPidByInode(fs, inode, uid, deadline, now);
  for (let hop = 0; pid && hop <= MAX_HOPS && now() <= deadline; hop++) {
    try {
      const found = pickVars(parseEnviron(fs.readFileSync(`/proc/${pid}/environ`, 'latin1')));
      if (found) return found;
    } catch { /* unreadable */ }
    let ppid = 0;
    try {
      const stat = String(fs.readFileSync(`/proc/${pid}/stat`, 'latin1'));
      ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { return null; }
    if (!Number.isInteger(ppid) || ppid <= 1) return null;
    pid = ppid;
  }
  return null;
}

// ── darwin ─────────────────────────────────────────────────────────────────

function run(execFile, file, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

async function darwinResolve(socket, deps, deadline, now) {
  const execFile = deps.execFile || childProcess.execFile;
  const left = () => Math.max(100, Math.min(1000, deadline - now()));
  const out = await run(execFile, 'lsof', ['-nP', `-iTCP:${socket.remotePort}`, '-sTCP:ESTABLISHED', '-Fp'], left());
  if (!out) return null;
  const self = process.pid;
  const pids = out.split('\n').filter((l) => /^p\d+$/.test(l)).map((l) => Number(l.slice(1))).filter((p) => p !== self);
  for (let pid of pids.slice(0, 4)) {
    for (let hop = 0; hop <= MAX_HOPS && now() < deadline; hop++) {
      const cmd = await run(execFile, 'ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], left());
      if (cmd) {
        const env = {};
        const id = / SM_CHAT_SESSION_ID=(\S+)/.exec(cmd);
        const root = / SM_PROJECT_ROOT=(\S+)/.exec(cmd);
        if (id) env.SM_CHAT_SESSION_ID = id[1];
        if (root) env.SM_PROJECT_ROOT = root[1];
        const found = pickVars(env);
        if (found) return found;
      }
      const pp = await run(execFile, 'ps', ['-o', 'ppid=', '-p', String(pid)], left());
      const ppid = Number(String(pp || '').trim());
      if (!Number.isInteger(ppid) || ppid <= 1) break;
      pid = ppid;
    }
  }
  return null;
}

/**
 * @param {{ remotePort?: number, localPort?: number }} socket
 * @param {{ fs?: any, execFile?: any, getuid?: () => number, platform?: string, now?: () => number }} [deps]
 * @returns {Promise<{ chatSessionId: string, projectRoot: string|null } | null>}
 */
async function resolvePeerChatSession(socket, deps = {}) {
  try {
    if (!socket || !Number.isInteger(socket.remotePort) || !Number.isInteger(socket.localPort)) return null;
    const now = deps.now || Date.now;
    const deadline = now() + DEADLINE_MS;
    const platform = deps.platform || process.platform;
    if (platform === 'linux') return linuxResolve(socket, deps, deadline, now) || null;
    if (platform === 'darwin') {
      let timer;
      const cap = new Promise((r) => { timer = setTimeout(() => r(null), DEADLINE_MS); });
      try {
        return (await Promise.race([darwinResolve(socket, deps, deadline, now), cap])) || null;
      } finally { clearTimeout(timer); }
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { resolvePeerChatSession };
