#!/usr/bin/env node
/**
 * sm-ps.cjs — "what is this process?" for Session Manager's process tree.
 *
 * Lists our renamed processes (comm from lib/smProcNames.cjs / lib/claudeBin.cjs),
 * every process carrying SM_PROC_ROLE in its environment, and all their
 * descendants — which includes the MCP servers `claude` spawns (node/python) that
 * we cannot rename. Those inherit our env, so /proc/<pid>/environ attributes them
 * (SM_PROC_ROLE, SM_SCHEDULER_JOB_SLUG, SM_CHAT_SESSION_ID, SM_PROJECT_ROOT).
 *
 *   node scripts/sm-ps.cjs [--json] [--proc-root <dir>]
 *
 * Linux /proc only. No /proc (macOS) or nothing found → empty result, exit 0.
 * environ is unreadable for other users' pids and pids can exit mid-scan: both
 * degrade to "process shown without attribution", never an error.
 * Cost: O(pids) small /proc reads; deliberately never touches ~/.claude/projects.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PROC_NAMES } = require('../src/main/lib/smProcNames.cjs');

const ROLE_VAR = 'SM_PROC_ROLE';
const ATTR_VARS = {
  role: ROLE_VAR,
  slug: 'SM_SCHEDULER_JOB_SLUG',
  chatSessionId: 'SM_CHAT_SESSION_ID',
  projectRoot: 'SM_PROJECT_ROOT',
};
const OWN_COMMS = new Set(Object.values(PROC_NAMES));

function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** comm and ppid from /proc/<pid>/stat; comm may hold spaces/parens, so split on the LAST ')'. */
function parseStat(raw) {
  if (!raw) return null;
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open === -1 || close === -1) return null;
  const rest = raw.slice(close + 1).trim().split(/\s+/); // [state, ppid, ...]
  const ppid = Number(rest[1]);
  return { comm: raw.slice(open + 1, close), ppid: Number.isFinite(ppid) ? ppid : 0 };
}

function parseEnviron(raw) {
  const out = {};
  if (!raw) return out;
  for (const kv of raw.split('\0')) {
    const eq = kv.indexOf('=');
    if (eq > 0) {
      const k = kv.slice(0, eq);
      if (Object.values(ATTR_VARS).includes(k)) out[k] = kv.slice(eq + 1);
    }
  }
  return out;
}

function scan(procRoot, selfPid) {
  let names;
  try { names = fs.readdirSync(procRoot); } catch { return []; }
  const procs = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid) continue;
    const dir = path.join(procRoot, name);
    const stat = parseStat(readOrNull(path.join(dir, 'stat')));
    if (!stat) continue; // exited mid-scan
    const cmd = (readOrNull(path.join(dir, 'cmdline')) || '').replace(/\0+$/, '').split('\0').join(' ').trim();
    const env = parseEnviron(readOrNull(path.join(dir, 'environ'))); // null → {} (EACCES/ENOENT/macOS)
    procs.set(pid, {
      pid,
      ppid: stat.ppid,
      comm: stat.comm,
      cmd,
      role: env[ATTR_VARS.role] || null,
      slug: env[ATTR_VARS.slug] || null,
      chatSessionId: env[ATTR_VARS.chatSessionId] || null,
      projectRoot: env[ATTR_VARS.projectRoot] || null,
    });
  }
  return [...procs.values()];
}

function isOurs(p) {
  return p.role !== null || OWN_COMMS.has(p.comm) || p.comm.startsWith('sm-claude-');
}

/** Ours + all descendants, pid-sorted. O(n). */
function sessionManagerProcesses(all) {
  const kids = new Map();
  for (const p of all) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const keep = new Map();
  const stack = all.filter(isOurs);
  while (stack.length) {
    const p = stack.pop();
    if (keep.has(p.pid)) continue;
    keep.set(p.pid, p);
    for (const c of kids.get(p.pid) || []) stack.push(c);
  }
  return [...keep.values()].sort((a, b) => a.pid - b.pid).map((p) => ({ ...p, attributed: p.role !== null }));
}

/** Env/cmdline values are attacker-influenced text; strip control bytes before a terminal sees them. */
const printable = (v) => String(v).replace(/[\x00-\x1f\x7f]/g, '?');

function renderText(list) {
  if (list.length === 0) return 'No Session Manager processes found.';
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const depth = (p) => { let d = 0; for (let q = byPid.get(p.ppid); q && d < 32; q = byPid.get(q.ppid)) d++; return d; };
  return list.map((p) => {
    const tags = [p.role && `role=${p.role}`, p.slug && `slug=${p.slug}`, p.chatSessionId && `chat=${p.chatSessionId}`, p.projectRoot && `project=${p.projectRoot}`].filter(Boolean);
    const attr = tags.length ? printable(tags.join(' ')) : '(no attribution)';
    return `${'  '.repeat(depth(p))}${p.pid} ${printable(p.comm)}  ${attr}\n${'  '.repeat(depth(p))}    ${printable(p.cmd.slice(0, 160))}`;
  }).join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const i = argv.indexOf('--proc-root');
  const procRoot = i !== -1 && argv[i + 1] ? argv[i + 1] : '/proc';
  const list = sessionManagerProcesses(scan(procRoot, process.pid));
  process.stdout.write((json ? JSON.stringify({ processes: list }, null, 2) : renderText(list)) + '\n');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { scan, sessionManagerProcesses, parseStat, parseEnviron };
