/**
 * supervisor.cjs — every 15 min, probes each running scheduled job to detect
 * jobs wedged on an unsatisfiable poll-loop (the fizzpop pattern).
 *
 * When stuck, SIGTERMs only the offending child bash so the parent claude -p
 * Sonnet agent sees the failed tool result and can recover. Never kills the
 * agent itself unless the job has zero child processes and is > 60 min stale.
 *
 * Linux only (v1). On darwin, startSupervisor logs a warning and returns.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { ipcMain } = require('electron');

const HOME = os.homedir();
const SUPERVISOR_LOG_PATH = path.join(HOME, '.claude', 'session-manager', 'supervisor.log');
const SUPERVISOR_LOG_MAX_BYTES = 1024 * 1024;
const RUNS_DIR = path.join(HOME, '.claude', 'session-manager', 'scheduled-plans', 'runs');

// In-flight probe slugs — prevents duplicate probes across ticks.
const inFlightProbes = new Set();

let supervisorInterval = null;
let _readQueue = null;
let _mutate = null;

// ─── /proc helpers (Linux-only) ────────────────────────────────────────────

/**
 * Walk PPID chain upward (bounded to 32 hops) to test whether `pid` is a
 * descendant of `ancestorPid`. Returns false if /proc is unavailable.
 */
function isDescendantOf(pid, ancestorPid) {
  let cur = pid;
  for (let i = 0; i < 32; i++) {
    if (cur === ancestorPid) return true;
    if (cur <= 1) return false;
    let ppid;
    try {
      const stat = fs.readFileSync(`/proc/${cur}/stat`, 'utf8');
      // comm may contain spaces; split on the last ')' to get past it.
      const closeParen = stat.lastIndexOf(')');
      const tail = stat.slice(closeParen + 2).split(' ');
      ppid = parseInt(tail[1], 10); // tail[0]=state, tail[1]=ppid
    } catch {
      return false;
    }
    if (!Number.isFinite(ppid) || ppid <= 0) return false;
    cur = ppid;
  }
  return false;
}

function getPstree(pid) {
  try {
    return execFileSync('pstree', ['-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return buildProcTreeFallback(pid);
  }
}

function buildProcTreeFallback(rootPid) {
  try {
    const entries = fs.readdirSync('/proc');
    const descendants = [];
    for (const e of entries) {
      const p = parseInt(e, 10);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (isDescendantOf(p, rootPid)) descendants.push(p);
    }
    return `(fallback) ${rootPid}: [${descendants.join(', ')}]`;
  } catch {
    return `(pstree unavailable; rootPid=${rootPid})`;
  }
}

function getChildBashCmdlines(jobPid) {
  const result = [];
  try {
    const entries = fs.readdirSync('/proc');
    for (const e of entries) {
      const pid = parseInt(e, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const m = stat.match(/^\d+ \(([^)]+)\)/);
        if (!m || m[1] !== 'bash') continue;
        if (!isDescendantOf(pid, jobPid)) continue;
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        result.push(`pid=${pid}: ${cmdline.replace(/\0/g, '|')}`);
      } catch { /* process may have exited */ }
    }
  } catch { /* /proc unavailable */ }
  return result.join('\n') || '(none found)';
}

// ─── Log tail helpers ───────────────────────────────────────────────────────

function readTailBytes(filePath, bytes) {
  try {
    const stat = fs.statSync(filePath);
    const n = Math.min(stat.size, bytes);
    if (n <= 0) return '';
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, stat.size - n);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Skim the last 16 KB of a run log for the most recent assistant/user/result
 * event timestamp. Falls back to file mtime if no parseable timestamps found.
 */
function getLastActivityTs(logPath) {
  try {
    const stat = fs.statSync(logPath);
    const tail = readTailBytes(logPath, 16384);
    let maxTs = 0;
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // stream-json events: look for any timestamp field
        const ts = obj.timestamp
          ? new Date(obj.timestamp).getTime()
          : obj.ts
            ? (typeof obj.ts === 'number' ? obj.ts : new Date(obj.ts).getTime())
            : 0;
        if (ts > 0 && ts > maxTs) maxTs = ts;
        // Also accept events with message.created_at (Anthropic API format)
        if (obj.message?.created_at) {
          const t = typeof obj.message.created_at === 'number'
            ? obj.message.created_at * 1000
            : new Date(obj.message.created_at).getTime();
          if (t > maxTs) maxTs = t;
        }
      } catch { /* not JSON or no timestamp */ }
    }
    return maxTs || stat.mtimeMs;
  } catch {
    return 0;
  }
}

// ─── Supervisor log ─────────────────────────────────────────────────────────

function appendSupervisorLog(entry) {
  try {
    let size = 0;
    try { size = fs.statSync(SUPERVISOR_LOG_PATH).size; } catch { /* new file */ }
    if (size >= SUPERVISOR_LOG_MAX_BYTES) {
      const rotated = SUPERVISOR_LOG_PATH + '.1';
      try { fs.unlinkSync(rotated); } catch { /* */ }
      try { fs.renameSync(SUPERVISOR_LOG_PATH, rotated); } catch { /* */ }
    }
    fs.appendFileSync(SUPERVISOR_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* disk full / EROFS — silently drop */ }
}

function readSupervisorLog(n) {
  try {
    const text = fs.readFileSync(SUPERVISOR_LOG_PATH, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    return lines.slice(-n).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

// ─── Claude binary resolution ────────────────────────────────────────────────

let claudeBinCached = null;
function resolveClaudeBin() {
  if (claudeBinCached) return claudeBinCached;
  const candidates = [
    path.join(HOME, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); claudeBinCached = c; return c; } catch { /* */ }
  }
  claudeBinCached = 'claude';
  return claudeBinCached;
}

// ─── Probe ──────────────────────────────────────────────────────────────────

function buildProbePrompt({ slug, cwd, startedAt, ageMinutes, lastActivityAge, jobPid, pstreeOutput, childBashCmdlines, logTail }) {
  return `You are a process supervisor. A scheduled \`claude -p\` Sonnet agent
appears to have stopped making progress. Decide whether it is wedged
on a child subprocess and, if so, which subprocess to kill.

Job slug: ${slug}
Job cwd: ${cwd}
Started: ${startedAt}  (${ageMinutes} min ago)
Last JSONL event: ${lastActivityAge} min ago

Process tree (pstree -p ${jobPid}):
${pstreeOutput}

Child bash command lines (cmdline of every descendant bash, NUL-separated args):
${childBashCmdlines}

Last 4 KB of the JSONL run log:
${logTail}

Return EXACTLY ONE JSON object on a single line, no prose:
{"verdict":"ok"|"stuck","action":"none"|"kill-bash"|"kill-agent","targetPid":<integer or null>,"reason":"<one sentence>"}

Decision rules:
- "ok"/none if the agent is mid-tool-use and the last event is < 10 min old, or if it is in a bounded retry loop with a clear termination condition (e.g. \`for i in $(seq 1 60)\` is acceptable; \`until <unbounded check>\` is suspicious).
- "stuck"/kill-bash if you can identify a single descendant bash polling on an unsatisfiable condition (e.g. \`until $(curl ... uptime) -lt $PREV; do sleep ...; done\` where the live value will never drop). Set targetPid to that bash PID.
- "stuck"/kill-agent only if the agent itself is wedged (no child processes, no recent log events, > 60 min stale). Set targetPid to the claude root pid.`;
}

function runProbe(claudeBin, prompt) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeBin, [
        '-p', prompt,
        '--model', 'claude-opus-4-7',
        '--no-session-persistence',
        '--output-format', 'json',
        '--max-budget-usd', '0.10',
        '--dangerously-skip-permissions',
        '--allowedTools', 'Bash',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('[supervisor] probe spawn failed:', e?.message);
      resolve({ verdict: 'ok', action: 'none', targetPid: null, reason: `spawn failed: ${e?.message}`, costUsd: null });
      return;
    }

    const stdoutChunks = [];
    child.stdout.on('data', (b) => stdoutChunks.push(b));
    child.stderr.on('data', () => { /* discard */ });

    child.on('error', (e) => {
      console.error('[supervisor] probe process error:', e?.message);
      resolve({ verdict: 'ok', action: 'none', targetPid: null, reason: `probe error: ${e?.message}`, costUsd: null });
    });

    child.on('exit', () => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      let costUsd = null;
      let verdictObj = null;

      // --output-format json emits a single JSON result object.
      // The `result` field contains the assistant's raw text response.
      for (const line of stdout.split('\n').reverse()) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (typeof obj.total_cost_usd === 'number') costUsd = obj.total_cost_usd;
          // Extract verdict from the result text field (assistant's response).
          if (obj.result && typeof obj.result === 'string') {
            const m = obj.result.match(/\{[^{}]+\}/);
            if (m) {
              try { verdictObj = JSON.parse(m[0]); } catch { /* */ }
            }
          }
        } catch { /* not JSON */ }
        if (verdictObj) break;
      }

      if (!verdictObj || !verdictObj.verdict) {
        // Non-JSON or unparseable — fail-safe: treat as ok.
        const raw = stdout.slice(0, 1024);
        console.warn('[supervisor] probe non-parseable output (treating as ok):', raw);
        resolve({ verdict: 'ok', action: 'none', targetPid: null, reason: 'probe returned non-parseable output', costUsd });
        return;
      }

      resolve({
        verdict: verdictObj.verdict === 'stuck' ? 'stuck' : 'ok',
        action: ['none', 'kill-bash', 'kill-agent'].includes(verdictObj.action) ? verdictObj.action : 'none',
        targetPid: typeof verdictObj.targetPid === 'number' ? verdictObj.targetPid : null,
        reason: typeof verdictObj.reason === 'string' ? verdictObj.reason.slice(0, 500) : '',
        costUsd,
      });
    });
  });
}

// ─── Apply action ────────────────────────────────────────────────────────────

function applyAction(action, targetPid, jobSlug) {
  if (action === 'none') return;

  // Retrieve the job's root PID from the live queue for descendant verification.
  const state = _readQueue ? _readQueue() : null;
  const job = state ? state.jobs.find((j) => j.slug === jobSlug) : null;
  const jobRootPid = job?.runtime?.pid ?? null;

  const selfPid = process.pid;

  if (action === 'kill-bash') {
    if (!targetPid) {
      console.warn('[supervisor] kill-bash: no targetPid for', jobSlug);
      return;
    }
    if (targetPid === selfPid) {
      console.warn('[supervisor] kill-bash: refused to kill self (slug=%s)', jobSlug);
      return;
    }
    // Verify targetPid is a descendant of the job's root process.
    if (jobRootPid && !isDescendantOf(targetPid, jobRootPid)) {
      console.warn('[supervisor] kill-bash: targetPid=%d is not a descendant of job root pid=%d (slug=%s)', targetPid, jobRootPid, jobSlug);
      return;
    }
    console.log(`[supervisor] kill-bash SIGTERM pid=${targetPid} (${jobSlug})`);
    try {
      process.kill(targetPid, 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') console.warn('[supervisor] kill-bash SIGTERM failed', targetPid, e?.message);
      return;
    }
    setTimeout(() => {
      try {
        process.kill(targetPid, 0); // check alive
        process.kill(targetPid, 'SIGKILL');
        console.log(`[supervisor] kill-bash SIGKILL (still alive after 2s) pid=${targetPid} (${jobSlug})`);
      } catch { /* already dead */ }
    }, 2000);

  } else if (action === 'kill-agent') {
    const pid = targetPid || jobRootPid;
    if (!pid) {
      console.warn('[supervisor] kill-agent: no pid for', jobSlug);
      return;
    }
    if (pid === selfPid) {
      console.warn('[supervisor] kill-agent: refused to kill self (slug=%s)', jobSlug);
      return;
    }
    console.log(`[supervisor] kill-agent SIGTERM pid=${pid} (${jobSlug})`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') console.warn('[supervisor] kill-agent SIGTERM failed', pid, e?.message);
      return;
    }
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
        console.log(`[supervisor] kill-agent SIGKILL (still alive after 2s) pid=${pid} (${jobSlug})`);
      } catch { /* already dead */ }
    }, 2000);
  }
}

// ─── Probe a single job ──────────────────────────────────────────────────────

async function probeJob(job, lastActivityAge) {
  const slug = job.slug;
  inFlightProbes.add(slug);
  try {
    const jobPid = job.runtime.pid;
    const cwd = job.cwd || HOME;
    const startedAt = job.startedAt || new Date().toISOString();
    const ageMinutes = Math.floor((Date.now() - Date.parse(startedAt)) / 60_000);
    const runId = job.runtime?.runId;
    const logPath = runId ? path.join(RUNS_DIR, runId, `${slug}.log`) : null;

    const pstreeOutput = getPstree(jobPid);
    const childBashCmdlines = getChildBashCmdlines(jobPid);
    const logTail = logPath ? readTailBytes(logPath, 4096) : '(no log path)';

    const prompt = buildProbePrompt({
      slug, cwd, startedAt, ageMinutes, lastActivityAge,
      jobPid, pstreeOutput, childBashCmdlines, logTail,
    });

    const claudeBin = resolveClaudeBin();
    const result = await runProbe(claudeBin, prompt);

    appendSupervisorLog({
      ts: Date.now(),
      jobSlug: slug,
      lastActivityAgeMin: lastActivityAge,
      verdict: result.verdict,
      action: result.action,
      targetPid: result.targetPid,
      reason: result.reason,
      costUsd: result.costUsd,
    });

    console.log(`[supervisor] probe result: slug=${slug} verdict=${result.verdict} action=${result.action} reason=${result.reason}`);

    if (result.action !== 'none') {
      applyAction(result.action, result.targetPid, slug);
    }
  } catch (e) {
    console.error('[supervisor] probeJob error', slug, e?.message);
  } finally {
    inFlightProbes.delete(slug);
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

async function supervisorTick() {
  if (!_readQueue) return;
  const state = _readQueue();
  const cfg = state.config?.supervisor ?? {};
  if (cfg.enabled === false) return;

  const maxConcurrent = cfg.maxConcurrentProbes ?? 2;
  const staleThresholdMs = (cfg.probeStaleThresholdMinutes ?? 10) * 60_000;

  const runningJobs = state.jobs.filter((j) => j.status === 'running' && j.runtime?.pid);
  if (runningJobs.length === 0) return;

  const candidates = [];
  for (const job of runningJobs) {
    if (inFlightProbes.has(job.slug)) continue;
    const runId = job.runtime?.runId;
    const logPath = runId ? path.join(RUNS_DIR, runId, `${job.slug}.log`) : null;
    if (!logPath) continue;
    const lastActivity = getLastActivityTs(logPath);
    const ageMs = Date.now() - lastActivity;
    if (ageMs >= staleThresholdMs) {
      candidates.push({ job, lastActivityAge: Math.floor(ageMs / 60_000) });
    }
  }

  const slots = maxConcurrent - inFlightProbes.size;
  if (slots <= 0) return;

  const toProbe = candidates.slice(0, slots);
  for (const { job, lastActivityAge } of toProbe) {
    if (inFlightProbes.size >= maxConcurrent) break;
    probeJob(job, lastActivityAge).catch((e) => {
      console.error('[supervisor] unhandled probe error', job.slug, e);
    });
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function startSupervisor({ readQueue, mutate }) {
  if (process.platform !== 'linux') {
    console.log('[supervisor] non-Linux platform detected; supervisor is a no-op for v1');
    return;
  }
  if (process.env.SM_SUPERVISOR_DISABLE === '1') {
    console.log('[supervisor] disabled via SM_SUPERVISOR_DISABLE=1');
    return;
  }

  _readQueue = readQueue;
  _mutate = mutate;

  stopSupervisor(); // idempotent: clear any existing interval

  const state = readQueue();
  const cfg = state.config?.supervisor ?? {};
  const intervalMs = Math.max(5, Math.min(60, cfg.intervalMinutes ?? 15)) * 60_000;

  supervisorInterval = setInterval(() => {
    supervisorTick().catch((e) => console.error('[supervisor] tick error', e));
  }, intervalMs);
  if (supervisorInterval.unref) supervisorInterval.unref();

  console.log(`[supervisor] started, interval=${intervalMs / 60_000}min`);
}

function stopSupervisor() {
  if (supervisorInterval) {
    clearInterval(supervisorInterval);
    supervisorInterval = null;
  }
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function registerHandlers() {
  // supervisor:tick-now — debug only, used by e2e tests
  ipcMain.handle('supervisor:tick-now', async () => {
    await supervisorTick();
    return { ok: true };
  });

  // supervisor:get-log — returns last 50 entries descending by ts
  ipcMain.handle('supervisor:get-log', async () => {
    return readSupervisorLog(50);
  });
}

module.exports = {
  startSupervisor,
  stopSupervisor,
  supervisorTick,
  applyAction,
  registerHandlers,
};
