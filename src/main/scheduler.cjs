/**
 * scheduler.cjs — runs queued PRDs as headless `claude -p` jobs around
 * the next 5h token-window reset.
 *
 * Layout (under ~/.claude/session-manager/scheduled-plans/):
 *   prds/NN-slug.md      → user/Claude-authored PRD files (source of truth)
 *   queue.json           → scheduler state: schedule, runs, status per PRD
 *   runs/<ISO>/<slug>.log → captured stdout/stderr for one execution
 *   runs/<ISO>/<slug>.meta.json → per-job metadata (exit, duration, cwd)
 *
 * Time:
 *   - "Next reset" comes from /api/oauth/usage five_hour.resets_at
 *     (already exposed via billing.fetchUsage()).
 *   - Trigger fires at resets_at + offsetMinutes (default 15).
 *   - We schedule a single setTimeout for the next fire-time. On schedule
 *     change (queue updated, reset_at moves) we cancel + reschedule.
 *
 * Parallelism:
 *   - PRD filename `NN-slug.md` — `NN` is the parallel group. All PRDs in
 *     the same group launch simultaneously; the next group only starts
 *     after the previous group's jobs all settle.
 *   - User-set concurrency cap (default 5) is the within-group ceiling. If
 *     a group has more PRDs than the cap, the excess waits until a slot
 *     frees in that group.
 *
 * Execution:
 *   - `claude -p "<PRD body>" --model sonnet --dangerously-skip-permissions`
 *     per PRD. Backlog runs on Sonnet; interactive sessions stay on Opus.
 *   - Stdout/stderr → runs/<ts>/<slug>.log; meta json gets exit + duration.
 *   - PRD frontmatter `cwd` → child cwd. Default: PROJECT_CWD const below.
 *
 * Persistence:
 *   - queue.json is the system of record for scheduling. Edited atomically
 *     via fs.writeFileSync(tmp) + rename.
 *   - On startup, walk prds/, ensure every .md has a queue.json entry.
 *     Orphaned entries (.md gone) are pruned.
 *
 * Renderer events:
 *   - 'schedule:state' broadcasts the full state on any change. Keeps the
 *     panel UI dead simple — no diff machinery.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { ipcMain } = require('electron');
const billing = require('./usage.cjs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const {
  POLL_INTERVAL_MS,
  USAGE_REFRESH_INTERVAL_MS,
  MAX_JOB_DURATION_MS,
} = require('./lib/schedulerConfig.cjs');

const ROOT = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans');
const PRDS_DIR = path.join(ROOT, 'prds');
const RUNS_DIR = path.join(ROOT, 'runs');
const QUEUE_PATH = path.join(ROOT, 'queue.json');
const SCHEDULER_STATE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-state.json');
const HEARTBEAT_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log');
const HEARTBEAT_MAX_BYTES = 1024 * 1024;
const DEFAULT_PROJECT_CWD = path.join(os.homedir(), 'Projects', 'session-manager');

const DEFAULT_CONFIG = {
  // Legacy on/off retained for backwards compat; v0.5+ uses firePolicy.
  enabled: false,
  offsetMinutes: 15,
  concurrencyCap: 5,
  defaultCwd: DEFAULT_PROJECT_CWD,
  // 'when-available' = poll usage and fire whenever utilization < threshold.
  // 'on-reset'        = fire offsetMinutes after the next 5h reset (legacy).
  // 'manual'          = only fire on explicit Run now click.
  firePolicy: 'when-available',
  // For 'when-available'. Fire only when five_hour utilization < this percent.
  utilizationThreshold: 90,
  schemaVersion: 1,
};

// ---------- fs helpers ----------

function ensureDirs() {
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function atomicWriteJson(p, data) {
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// ---------- scheduler-state.json (sidecar) ----------

function loadSchedulerState() {
  try {
    const raw = fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8');
    const s = JSON.parse(raw);
    if (s.lastObservedReset) cachedNextReset = s.lastObservedReset;
    if (typeof s.consecutiveFailures === 'number') consecutiveFailures = s.consecutiveFailures;
    if (typeof s.backoffMs === 'number') backoffMs = s.backoffMs;
    if (typeof s.pauseClearedManuallyAt === 'number') pauseClearedManuallyAt = s.pauseClearedManuallyAt;
    if (typeof s.lastPollAt === 'number') lastPollAt = s.lastPollAt;
  } catch { /* first boot or corrupt — start fresh */ }
}

function persistSchedulerState() {
  try {
    atomicWriteJson(SCHEDULER_STATE_PATH, {
      version: 1,
      lastObservedReset: cachedNextReset,
      lastResetObservedAt: cachedNextReset ? Date.now() : null,
      lastPollAt,
      consecutiveFailures,
      backoffMs,
      pausedReason: null,
      pausedSince: null,
      pauseClearedManuallyAt,
    });
  } catch (e) {
    console.warn('[scheduler] failed to persist scheduler state', e?.message);
  }
}

// ---------- heartbeat log ----------

function appendHeartbeat(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    let size = 0;
    try { size = fs.statSync(HEARTBEAT_PATH).size; } catch { /* new file */ }
    if (size >= HEARTBEAT_MAX_BYTES) {
      const rotated = HEARTBEAT_PATH + '.1';
      try { fs.unlinkSync(rotated); } catch { /* */ }
      try { fs.renameSync(HEARTBEAT_PATH, rotated); } catch { /* */ }
    }
    fs.appendFileSync(HEARTBEAT_PATH, line);
  } catch (e) {
    console.warn('[scheduler] heartbeat write failed', e?.message);
  }
}

function readQueue() {
  try {
    const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      config: { ...DEFAULT_CONFIG, ...(data.config || {}) },
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
      scheduledFor: data.scheduledFor ?? null,
      lastRunAt: data.lastRunAt ?? null,
      paused: data.paused ?? null,
    };
  } catch {
    return { config: { ...DEFAULT_CONFIG }, jobs: [], scheduledFor: null, lastRunAt: null, paused: null };
  }
}

function writeQueue(state) {
  ensureDirs();
  atomicWriteJson(QUEUE_PATH, state);
}

// ---------- serialized mutation queue ----------

// All read-modify-write operations on queue.json go through mutate() so
// concurrent job completions in a parallel wave cannot lose each other's
// status updates. mutateTail is always a resolved promise even when the
// preceding mutate threw, so the chain never deadlocks.
let mutateTail = Promise.resolve();

function mutate(fn) {
  const next = mutateTail.then(async () => {
    const state = readQueue();
    const ret = await fn(state);
    writeQueue(state);
    return ret;
  });
  mutateTail = next.catch(() => {}); // keep chain alive on errors
  return next;
}

// ---------- PRD parsing ----------

/**
 * Parse YAML-ish frontmatter — only the keys we use. We don't take a
 * yaml dep; the schema is small (title, cwd, estimateMinutes, parallelGroup)
 * and the format is documented in the user-facing README.
 */
function parsePrd(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const meta = { title: null, cwd: null, estimateMinutes: null, parallelGroup: null };
  let body = text;

  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      const fm = text.slice(4, end);
      body = text.slice(end + 4).replace(/^\n/, '');
      for (const line of fm.split('\n')) {
        const m = line.match(/^([a-zA-Z]+):\s*(.+?)\s*$/);
        if (!m) continue;
        const k = m[1];
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (k === 'title') meta.title = v;
        else if (k === 'cwd') meta.cwd = v;
        else if (k === 'estimateMinutes') meta.estimateMinutes = Number(v) || null;
        else if (k === 'parallelGroup') meta.parallelGroup = Number(v) || null;
      }
    }
  }

  const base = path.basename(filePath, '.md');
  const groupFromName = (() => {
    const m = base.match(/^(\d+)-/);
    return m ? Number(m[1]) : null;
  })();

  return {
    slug: base,
    path: filePath,
    title: meta.title || base,
    cwd: meta.cwd || null,
    estimateMinutes: meta.estimateMinutes,
    parallelGroup: meta.parallelGroup ?? groupFromName ?? 99,
    body: body.trim(),
  };
}

function listPrdFiles() {
  ensureDirs();
  return fs.readdirSync(PRDS_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => path.join(PRDS_DIR, f))
    .sort();
}

// ---------- queue reconciliation ----------

/**
 * Walk prds/, ensure every .md has a queue entry. Drop entries whose .md
 * is gone. Refresh title/cwd/parallelGroup from disk every reconcile so
 * editing the .md after queueing is honored.
 *
 * Status is preserved: pending stays pending, completed stays completed.
 * Newly-discovered PRDs land as `pending`.
 */
function reconcile(state) {
  const files = listPrdFiles();
  const onDisk = new Map();
  for (const f of files) {
    try {
      const p = parsePrd(f);
      onDisk.set(p.slug, p);
    } catch (e) {
      console.warn('[scheduler] failed to parse', f, e?.message);
    }
  }

  const next = [];
  const seen = new Set();
  for (const job of state.jobs) {
    const p = onDisk.get(job.slug);
    if (!p) continue;
    seen.add(job.slug);
    next.push({
      ...job,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      bodyPreview: p.body.split('\n').slice(0, 6).join('\n'),
    });
  }
  for (const [slug, p] of onDisk) {
    if (seen.has(slug)) continue;
    next.push({
      slug,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      bodyPreview: p.body.split('\n').slice(0, 6).join('\n'),
      status: 'pending',
      runId: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
    });
  }
  state.jobs = next.sort((a, b) => a.slug.localeCompare(b.slug));
  return state;
}

// ---------- next-reset detection ----------

let cachedNextReset = null; // bare ISO string or null
let cachedUtilization = null; // five_hour utilization %, 0–100, or null if unknown

/** Fetches latest usage from billing API. Throws on any error — callers handle it. */
async function refreshNextReset() {
  const r = await billing.fetchUsage();
  if (r.kind !== 'ok') throw new Error(`usage fetch failed (${r.kind}): ${r.message ?? ''}`);
  cachedNextReset = r.data?.usage?.five_hour?.resets_at ?? null;
  cachedUtilization = r.data?.usage?.five_hour?.utilization ?? cachedUtilization;
  return cachedNextReset;
}

function getNextResetCached() {
  return cachedNextReset;
}

// ---------- health / poll state ----------

let bootedAt = Date.now();
let lastPollAt = null;
let lastPollOk = false;
let consecutiveFailures = 0;
let backoffMs = 0;
let backoffNextAt = null;
let firstFailureAt = null;
let pauseClearedManuallyAt = null;

// ---------- timer ----------

let mainWindow = null;
let fireTimer = null;
let resumeTimer = null;
let pollLoopTimer = null;
let rescheduleInterval = null;
let heartbeatInterval = null;
let isExecuting = false;
let cancelToken = { cancelled: false };
let claudeBinPathCached = null;

function attachWindow(w) { mainWindow = w; }

function broadcast() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = readQueue();
  reconcile(state);
  writeQueue(state);
  mainWindow.webContents.send('schedule:state', {
    config: state.config,
    jobs: state.jobs,
    scheduledFor: state.scheduledFor,
    lastRunAt: state.lastRunAt,
    nextReset: getNextResetCached(),
    paused: state.paused,
    utilization: cachedUtilization,
  });
}

function clearFireTimer() {
  if (fireTimer) {
    clearTimeout(fireTimer);
    fireTimer = null;
  }
}

function computeFireAt(state, nextResetIso) {
  // Only the legacy 'on-reset' policy uses scheduled fire times. Other
  // policies fire either immediately on demand ('manual') or via the
  // when-available poll loop.
  if (state.config.firePolicy !== 'on-reset') return null;
  if (!nextResetIso) return null;
  const reset = new Date(nextResetIso).getTime();
  if (Number.isNaN(reset)) return null;
  return reset + (state.config.offsetMinutes * 60_000);
}

async function rescheduleTimer() {
  clearFireTimer();
  // Wrap in try/catch — on failure use the cached value so the on-reset
  // timer can still be armed from the last known reset.
  let nextResetIso;
  try {
    nextResetIso = await refreshNextReset();
  } catch {
    nextResetIso = cachedNextReset;
  }
  const fireAt = await mutate((state) => {
    reconcile(state);
    const fa = computeFireAt(state, nextResetIso);
    state.scheduledFor = fa ? new Date(fa).toISOString() : null;
    return fa;
  });
  broadcast();
  if (!fireAt) return;

  const delay = Math.max(1000, fireAt - Date.now());
  fireTimer = setTimeout(() => { runDueJobs().catch(() => {}); }, delay);
  console.log(`[scheduler] next fire in ${Math.round(delay / 1000)}s @ ${new Date(fireAt).toISOString()}`);
}

// ---------- pause / resume ----------

async function setPaused(reason, resumeAtIso) {
  // Honor manual-override cooldown: if the user cleared a pause within the
  // last 5 minutes, suppress auto-pause re-engagement on the same condition.
  if (pauseClearedManuallyAt && Date.now() - pauseClearedManuallyAt < 300_000) {
    console.log(`[scheduler] setPaused(${reason}) suppressed by manual override cooldown`);
    return;
  }

  // For 'network' with no explicit resumeAt, auto-resume after 30 minutes.
  let effectiveResumeAt = resumeAtIso;
  if (reason === 'network' && !resumeAtIso) {
    effectiveResumeAt = new Date(Date.now() + 30 * 60_000).toISOString();
  }

  await mutate((s) => {
    if (s.paused && s.paused.reason === reason) {
      if (effectiveResumeAt) s.paused.resumeAt = effectiveResumeAt;
    } else {
      s.paused = { reason, since: new Date().toISOString(), resumeAt: effectiveResumeAt || null };
    }
  });
  broadcast();
  cancelToken.cancelled = true;
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  if (!effectiveResumeAt) return;

  // Resume 30s after the reset to give the auth/billing endpoint time to flip.
  const delay = Math.max(30_000, new Date(effectiveResumeAt).getTime() - Date.now() + 30_000);
  if (delay > 0x7fffffff) {
    console.warn(`[scheduler] paused (${reason}); resumeAt too far for setTimeout (${delay}ms)`);
    return;
  }
  resumeTimer = setTimeout(async () => {
    await clearPause('resume-timer');
    runDueJobs().catch(() => {});
  }, delay);
  console.log(`[scheduler] paused (${reason}); auto-resume in ${Math.round(delay / 1000)}s`);
}

async function clearPause(source) {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  const wasPaused = await mutate((s) => {
    if (!s.paused) return false;
    console.log(`[scheduler] clearPause (${source || 'manual'})`);
    s.paused = null;
    return true;
  });
  // Track manual clears for the auto-pause cooldown.
  if (source === 'manual' || source === 'run-now') {
    pauseClearedManuallyAt = Date.now();
    persistSchedulerState();
  }
  if (wasPaused) broadcast();
}

/** Mutate a job in place to "pending" with cleared run metadata. */
function resetJobFields(job, errorMsg) {
  job.status = 'pending';
  job.runId = null;
  job.startedAt = null;
  job.finishedAt = null;
  job.exitCode = null;
  job.error = errorMsg ?? null;
  delete job.runtime;
}

/** Scan the tail of a job's log for the canonical rate-limit signal. We look
 *  at the last 16 KB — final result event always lands at the end. */
function detectRateLimitInLog(logPath) {
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - 16384);
    const len = stat.size - start;
    if (len <= 0) return false;
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    return /"rateLimitType":"five_hour"/.test(text)
      || /"api_error_status":429/.test(text)
      || /You'?ve hit your limit/.test(text);
  } catch {
    return false;
  }
}

// ---------- claude binary ----------

function resolveClaudeBin() {
  if (claudeBinPathCached) return claudeBinPathCached;
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); claudeBinPathCached = c; return c; } catch { /* */ }
  }
  // Last resort: rely on PATH lookup at spawn time.
  claudeBinPathCached = 'claude';
  return claudeBinPathCached;
}

// ---------- execution ----------

function pickRunDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RUNS_DIR, ts);
  fs.mkdirSync(dir, { recursive: true });
  return { runId: ts, dir };
}

/**
 * Execute a single PRD job. Writes stdout/stderr to a log file and a meta
 * JSON sidecar. Accepts an optional onPid(pid) callback called synchronously
 * after spawn so callers can persist the pid before the job finishes.
 */
async function executeJob(job, runDir, defaultCwd, onPid) {
  const logPath = path.join(runDir, `${job.slug}.log`);
  const metaPath = path.join(runDir, `${job.slug}.meta.json`);
  const cwd = job.cwd || defaultCwd;
  const startedAt = Date.now();

  const fd = fs.openSync(logPath, 'a');
  let fdClosed = false;
  const closeFd = () => { if (fdClosed) return; fdClosed = true; fs.closeSync(fd); };

  fs.writeSync(fd, `[scheduler] starting ${job.slug} at ${new Date().toISOString()}\n[scheduler] cwd=${cwd}\n\n`);

  // Dead-cwd guard: verify the target directory exists and is traversable
  // before handing it to the child process.
  try { fs.accessSync(cwd, fs.constants.X_OK); }
  catch {
    const errMsg = `cwd no longer exists: ${cwd}`;
    fs.writeSync(fd, `[scheduler] ${errMsg}\n`);
    closeFd();
    atomicWriteJson(metaPath, { slug: job.slug, cwd, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs: 0 });
    return { exitCode: -1, durationMs: 0, error: errMsg };
  }

  // Read full PRD body fresh from disk (queue stored only the preview).
  let prompt;
  try {
    const parsed = parsePrd(path.join(PRDS_DIR, `${job.slug}.md`));
    prompt = parsed.body;
  } catch (e) {
    fs.writeSync(fd, `[scheduler] failed to read PRD: ${e?.message}\n`);
    closeFd();
    return { exitCode: -1, durationMs: 0, error: e?.message };
  }

  return await new Promise((resolve) => {
    const claudeBin = resolveClaudeBin();
    // Strip Claude Code env and secrets that leak in when session-manager is
    // launched from a `claude` shell. CLAUDE_EFFORT=xhigh forces Opus and
    // overrides `--model sonnet`, so scheduled jobs burn Opus credits silently.
    const childEnv = cleanChildEnv();
    const child = spawn(claudeBin, [
      '-p', prompt,
      '--model', 'sonnet',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
    ], {
      cwd,
      env: childEnv,
      stdio: ['ignore', fd, fd],
    });

    fs.writeSync(fd, `[scheduler] spawned pid=${child.pid}\n\n`);

    // Fire-and-forget pid persistence — best effort.
    if (onPid) onPid(child.pid).catch(() => {});

    // Kill the child if it runs past the maximum allowed duration.
    const watchdog = setTimeout(() => {
      fs.writeSync(fd, `\n[scheduler] watchdog SIGKILL after ${MAX_JOB_DURATION_MS}ms\n`);
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, MAX_JOB_DURATION_MS);
    if (watchdog.unref) watchdog.unref();

    child.on('error', (err) => {
      clearTimeout(watchdog);
      const durationMs = Date.now() - startedAt;
      fs.writeSync(fd, `\n[scheduler] error: ${err.message}\n`);
      closeFd();
      atomicWriteJson(metaPath, { slug: job.slug, cwd, exitCode: -1, error: err.message, startedAt, finishedAt: Date.now(), durationMs });
      resolve({ exitCode: -1, durationMs, error: err.message });
    });

    child.on('exit', (code) => {
      clearTimeout(watchdog);
      const durationMs = Date.now() - startedAt;
      fs.writeSync(fd, `\n[scheduler] exit code=${code} duration=${Math.round(durationMs / 1000)}s\n`);
      closeFd();
      const rateLimited = code !== 0 && detectRateLimitInLog(logPath);
      atomicWriteJson(metaPath, { slug: job.slug, cwd, exitCode: code, rateLimited, startedAt, finishedAt: Date.now(), durationMs });
      resolve({ exitCode: code, durationMs, rateLimited });
    });
  });
}

async function runDueJobs() {
  if (isExecuting) return;
  isExecuting = true;
  cancelToken = { cancelled: false };
  try {
    const state = readQueue();
    if (state.paused) {
      console.log('[scheduler] runDueJobs skipped: paused');
      return;
    }
    reconcile(state);
    const pending = state.jobs.filter((j) => j.status === 'pending');
    if (pending.length === 0) {
      return;
    }
    const { runId, dir: runDir } = pickRunDir();

    // Group by parallelGroup, ascending. Each group runs serially after the
    // previous group completes.
    const groups = new Map();
    for (const j of pending) {
      const g = j.parallelGroup ?? 99;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(j);
    }
    const groupKeys = Array.from(groups.keys()).sort((a, b) => a - b);

    await mutate((s) => { s.lastRunAt = new Date().toISOString(); });
    broadcast();

    for (const gk of groupKeys) {
      if (cancelToken.cancelled) break;
      const groupJobs = groups.get(gk);
      // Within a group: cap concurrency and run waves until all done.
      const cap = Math.max(1, Math.min(state.config.concurrencyCap, groupJobs.length));
      const queue = [...groupJobs];
      const inFlight = new Set();

      const launch = (job) => {
        const promise = (async () => {
          try {
            // Mark job running.
            await mutate((s) => {
              const idx = s.jobs.findIndex((x) => x.slug === job.slug);
              if (idx >= 0) {
                s.jobs[idx].status = 'running';
                s.jobs[idx].runId = runId;
                s.jobs[idx].startedAt = new Date().toISOString();
              }
            });
            broadcast();

            // Execute — onPid persists the child PID into the running state.
            const res = await executeJob(job, runDir, state.config.defaultCwd, async (pid) => {
              await mutate((s) => {
                const idx = s.jobs.findIndex((x) => x.slug === job.slug);
                if (idx >= 0) {
                  s.jobs[idx].runtime = { pid, runId, startedAt: s.jobs[idx].startedAt };
                }
              });
            });

            // Rate-limit: pause before writing terminal status so the status
            // mutate below can read the pause state.
            if (res.rateLimited) {
              const resetIso = await refreshNextReset().catch(() => cachedNextReset);
              await setPaused('rate_limit', resetIso);
            }

            // Write terminal status; strip runtime regardless of outcome.
            await mutate((s) => {
              const i2 = s.jobs.findIndex((x) => x.slug === job.slug);
              if (i2 >= 0) {
                const treatAsPending = res.rateLimited || (s.paused && s.paused.reason === 'rate_limit');
                if (treatAsPending) {
                  resetJobFields(s.jobs[i2], res.rateLimited ? 'paused: rate limit' : 'paused: queue halted');
                } else {
                  s.jobs[i2].status = res.exitCode === 0 ? 'completed' : 'failed';
                  s.jobs[i2].finishedAt = new Date().toISOString();
                  s.jobs[i2].exitCode = res.exitCode;
                  s.jobs[i2].error = res.error || null;
                  delete s.jobs[i2].runtime;
                }
              }
            });
            broadcast();
          } catch (e) {
            console.error('[scheduler] launch error', job.slug, e);
          }
        })();
        inFlight.add(promise);
        promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
      };

      // Prime up to cap
      while (queue.length && inFlight.size < cap && !cancelToken.cancelled) launch(queue.shift());
      // Drain. If cancelled mid-group, stop launching new jobs but let
      // already-launched ones settle (they're rate-limited too — short).
      while (inFlight.size > 0) {
        await Promise.race(inFlight);
        if (cancelToken.cancelled) {
          await Promise.allSettled([...inFlight]);
          break;
        }
        while (queue.length && inFlight.size < cap) launch(queue.shift());
      }
    }
  } finally {
    isExecuting = false;
    // No longer auto-disable after a run. The firePolicy now governs whether
    // the next batch fires automatically. Just clear the one-shot scheduledFor.
    await mutate((s) => { s.scheduledFor = null; });
    broadcast();
  }
}

// ---------- when-available launch logic ----------

async function maybeLaunchWhenAvailable(state) {
  if (state.config.firePolicy !== 'when-available') return;
  if (state.paused) return;
  if (isExecuting) return;
  const pending = state.jobs.filter((j) => j.status === 'pending');
  if (pending.length === 0) return;
  if (cachedUtilization === null || cachedUtilization === undefined) return;
  if (cachedUtilization >= state.config.utilizationThreshold) {
    broadcast();
    return;
  }
  console.log(`[scheduler] when-available: util=${cachedUtilization}%, ${pending.length} pending — firing`);
  runDueJobs().catch((e) => console.error('[scheduler] runDueJobs error', e));
}

// ---------- poll loop with exponential backoff ----------

async function pollLoop() {
  try {
    const r = await billing.fetchUsage();

    if (r.kind === 'ok') {
      cachedNextReset = r.data?.usage?.five_hour?.resets_at ?? cachedNextReset;
      cachedUtilization = r.data?.usage?.five_hour?.utilization ?? cachedUtilization;
      consecutiveFailures = 0;
      backoffMs = 0;
      backoffNextAt = null;
      firstFailureAt = null;
      lastPollAt = Date.now();
      lastPollOk = true;
      persistSchedulerState();

      // If a 'network' pause resolved, clear it now that we have a good reading.
      const cur = readQueue();
      if (cur.paused?.reason === 'network') {
        await clearPause('network-recovered');
      }
      // If 'reset_failure' was set and we now have a valid reset, clear it.
      if (cur.paused?.reason === 'reset_failure' && cachedNextReset) {
        await clearPause('reset-recovered');
      }

      await maybeLaunchWhenAvailable(cur);
      broadcast();
    } else {
      lastPollAt = Date.now();
      lastPollOk = false;
      consecutiveFailures++;
      if (!firstFailureAt) firstFailureAt = Date.now();

      if (r.kind === 'auth') {
        console.error(`[scheduler] auth failure (HTTP ${r.httpStatus}): ${r.message}`);
        await setPaused('auth', null);
      } else {
        // transient or config — apply exponential backoff.
        backoffMs = backoffMs ? Math.min(backoffMs * 2, 480_000) : 30_000;
        const totalFailureMs = Date.now() - firstFailureAt;
        console.log(`[scheduler] transient failure #${consecutiveFailures}: ${r.kind} ${r.message ?? ''}; retry in ${backoffMs / 1000}s`);

        // After 30 minutes of consecutive failures, set 'network' pause.
        if (totalFailureMs > 30 * 60_000) {
          const cur2 = readQueue();
          if (!cur2.paused || cur2.paused.reason === 'network') {
            await setPaused('network', null);
          }
        }
      }

      backoffNextAt = Date.now() + backoffMs;
      persistSchedulerState();
    }
  } catch (e) {
    // Unexpected error (e.g., IPC transport failure)
    lastPollAt = Date.now();
    lastPollOk = false;
    consecutiveFailures++;
    if (!firstFailureAt) firstFailureAt = Date.now();
    backoffMs = backoffMs ? Math.min(backoffMs * 2, 480_000) : 30_000;
    backoffNextAt = Date.now() + backoffMs;
    persistSchedulerState();
  } finally {
    const delay = backoffMs || POLL_INTERVAL_MS;
    pollLoopTimer = setTimeout(() => { pollLoop().catch(() => {}); }, delay);
    if (pollLoopTimer.unref) pollLoopTimer.unref();
  }
}

// ---------- IPC ----------

function registerScheduleHandlers() {
  ensureDirs();

  ipcMain.handle('schedule:state', async () => {
    const state = readQueue();
    reconcile(state);
    writeQueue(state);
    return {
      config: state.config,
      jobs: state.jobs,
      scheduledFor: state.scheduledFor,
      lastRunAt: state.lastRunAt,
      nextReset: getNextResetCached(),
      paused: state.paused,
      utilization: cachedUtilization,
      paths: { root: ROOT, prds: PRDS_DIR, runs: RUNS_DIR, queue: QUEUE_PATH },
    };
  });

  ipcMain.handle('schedule:health', async () => {
    const state = readQueue();
    const runningJobs = [];
    for (const j of state.jobs) {
      if (j.status === 'running' && j.runtime) {
        runningJobs.push({
          slug: j.slug,
          startedAt: j.startedAt ? Date.parse(j.startedAt) : 0,
          pid: j.runtime.pid ?? 0,
        });
      }
    }
    return {
      bootedAt,
      lastPollAt,
      lastPollOk,
      consecutiveFailures,
      backoffNextAt,
      nextResetCached: cachedNextReset,
      pausedSince: state.paused ? Date.parse(state.paused.since) : null,
      pauseReason: state.paused?.reason ?? null,
      runningJobs,
    };
  });

  ipcMain.handle('schedule:set-config', async (_e, partial) => {
    const { schemas: s } = require('./ipcSchemas.cjs');
    let validated;
    try {
      validated = s.setConfigSchema.parse(partial || {});
    } catch (e) {
      return { ok: false, error: e?.message ?? 'invalid config' };
    }
    const config = await mutate((state) => {
      state.config = { ...state.config, ...validated };
      return state.config;
    });
    await rescheduleTimer();
    return { ok: true, config };
  });

  ipcMain.handle('schedule:reset-job', async (_e, payload) => {
    const { schemas: s } = require('./ipcSchemas.cjs');
    let slug;
    try {
      ({ slug } = s.scheduleSlug.parse(payload));
    } catch (e) {
      return { ok: false, error: 'invalid slug' };
    }
    // Containment check after path.join.
    const resolved = path.resolve(path.join(PRDS_DIR, `${slug}.md`));
    if (!resolved.startsWith(PRDS_DIR + path.sep)) {
      return { ok: false, error: 'invalid slug' };
    }
    const found = await mutate((state) => {
      const idx = state.jobs.findIndex((j) => j.slug === slug);
      if (idx < 0) return false;
      resetJobFields(state.jobs[idx]);
      return true;
    });
    if (!found) return { ok: false, error: 'not found' };
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('schedule:run-now', async () => {
    // Manual run-now overrides any auto-pause. Clear it first.
    await clearPause('run-now');
    runDueJobs().catch((e) => console.error('[scheduler] runDueJobs error', e));
    return { ok: true };
  });

  ipcMain.handle('schedule:resume', async () => {
    await clearPause('manual');
    return { ok: true };
  });

  ipcMain.handle('schedule:refresh-reset', async () => {
    const at = await refreshNextReset().catch(() => cachedNextReset);
    await rescheduleTimer();
    return { ok: true, nextReset: at };
  });

  ipcMain.handle('schedule:open-folder', async () => {
    const { shell } = require('electron');
    await shell.openPath(ROOT);
    return { ok: true };
  });

  ipcMain.handle('schedule:read-prd', async (_e, payload) => {
    const { schemas: s } = require('./ipcSchemas.cjs');
    let slug;
    try {
      ({ slug } = s.scheduleSlug.parse(payload));
    } catch {
      return { ok: false, error: 'invalid slug' };
    }
    const filePath = path.resolve(path.join(PRDS_DIR, `${slug}.md`));
    if (!filePath.startsWith(PRDS_DIR + path.sep)) {
      return { ok: false, error: 'invalid slug' };
    }
    try {
      const text = await fsp.readFile(filePath, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  });

  ipcMain.handle('schedule:read-log', async (_e, payload) => {
    const { schemas: s } = require('./ipcSchemas.cjs');
    let slug, runId;
    try {
      ({ slug, runId } = s.scheduleReadLog.parse(payload));
    } catch {
      return { ok: false, error: 'invalid slug or runId' };
    }
    const logPath = path.resolve(path.join(RUNS_DIR, runId, `${slug}.log`));
    if (!logPath.startsWith(RUNS_DIR + path.sep)) {
      return { ok: false, error: 'invalid slug or runId' };
    }
    try {
      const text = await fsp.readFile(logPath, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  });

  const PRD_WRITE_MAX_BYTES = 256 * 1024;
  const SLUG_RE = /^[A-Za-z0-9._-]{1,128}$/;

  ipcMain.handle('schedule:write-prd', async (_e, { slug, body }) => {
    if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${slug}`);
    if (typeof body !== 'string') throw new Error('body must be string');
    if (Buffer.byteLength(body, 'utf8') > PRD_WRITE_MAX_BYTES) throw new Error('body too large');
    const file = path.join(PRDS_DIR, `${slug}.md`);
    const resolved = path.resolve(file);
    if (!resolved.startsWith(PRDS_DIR + path.sep)) throw new Error('path escape');
    const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o644 });
    await fsp.rename(tmp, resolved);
    const stat = await fsp.stat(resolved);
    return { ok: true, bytesWritten: stat.size };
  });

  ipcMain.handle('schedule:list-prds', async () => {
    ensureDirs();
    let entries;
    try {
      entries = await fsp.readdir(PRDS_DIR);
    } catch {
      return [];
    }
    const out = [];
    for (const name of entries) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const filePath = path.join(PRDS_DIR, name);
      try {
        const parsed = parsePrd(filePath);
        const stat = await fsp.stat(filePath);
        out.push({
          slug: parsed.slug,
          parallelGroup: parsed.parallelGroup,
          title: parsed.title,
          cwd: parsed.cwd || '',
          estimateMinutes: parsed.estimateMinutes,
          mtimeMs: stat.mtimeMs,
        });
      } catch (e) {
        console.warn('[scheduler] list-prds: skipping unparseable', name, e?.message);
      }
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }));
    return out;
  });
}

async function init() {
  ensureDirs();

  // Hydrate cached state from the sidecar before any scheduling decisions.
  loadSchedulerState();
  bootedAt = Date.now();

  // Boot reconciliation: mark any job that was 'running' when the app died as
  // 'failed'. mutate() creates queue.json from defaults if it doesn't exist.
  await mutate((state) => {
    for (const j of state.jobs) {
      if (j.status === 'running') {
        j.status = 'failed';
        j.error = 'orphaned: app restarted while running';
        j.finishedAt = new Date().toISOString();
        delete j.runtime;
      }
    }
  });

  // If we boot up while paused with a resumeAt in the past, clear it. This
  // happens when the app was closed across the reset window.
  const boot = readQueue();
  if (boot.paused && boot.paused.resumeAt && new Date(boot.paused.resumeAt).getTime() <= Date.now()) {
    await clearPause('boot-elapsed');
  } else if (boot.paused && boot.paused.resumeAt) {
    // Re-arm the resume timer (lost across restart).
    await setPaused(boot.paused.reason, boot.paused.resumeAt);
  }

  await rescheduleTimer();
  // Refresh next-reset every 10 minutes — billing window can shift if usage
  // resets early or the auth token rotates. Tracked so re-init doesn't leak.
  if (rescheduleInterval) clearInterval(rescheduleInterval);
  rescheduleInterval = setInterval(() => { rescheduleTimer().catch(() => {}); }, 10 * 60_000);

  // Self-rescheduling poll loop with exponential backoff. Replaces the
  // old fixed-interval pollTimer + initialPollTimeout.
  if (pollLoopTimer) clearTimeout(pollLoopTimer);
  // First tick fires after the standard warmup delay so billing is ready.
  pollLoopTimer = setTimeout(() => { pollLoop().catch(() => {}); }, USAGE_REFRESH_INTERVAL_MS);
  if (pollLoopTimer.unref) pollLoopTimer.unref();

  // Heartbeat: once per minute, log queue state for 24h visibility.
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    const s = readQueue();
    const counts = { pending: 0, running: 0, completed: 0, failed: 0 };
    for (const j of s.jobs) counts[j.status] = (counts[j.status] || 0) + 1;
    appendHeartbeat({
      ts: Date.now(),
      counts,
      paused: s.paused ? { reason: s.paused.reason, resumeAt: s.paused.resumeAt } : null,
      nextReset: cachedNextReset,
      utilization: cachedUtilization,
      consecutiveFailures,
    });
  }, 60_000);
  if (heartbeatInterval.unref) heartbeatInterval.unref();

  // Wake-from-sleep: immediately re-poll and re-evaluate the queue.
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', () => {
      console.log('[scheduler] system resumed; re-polling and re-evaluating queue');
      if (pollLoopTimer) { clearTimeout(pollLoopTimer); pollLoopTimer = null; }
      backoffMs = 0;
      backoffNextAt = null;
      // Clear any paused-but-resumeAt-elapsed state immediately.
      const wakeState = readQueue();
      if (wakeState.paused?.resumeAt && new Date(wakeState.paused.resumeAt).getTime() <= Date.now()) {
        clearPause('boot-elapsed').then(() => { runDueJobs().catch(() => {}); }).catch(() => {});
      }
      pollLoop().catch(() => {});
    });
  } catch (e) {
    console.warn('[scheduler] powerMonitor unavailable', e?.message);
  }
}

module.exports = { registerScheduleHandlers, attachWindow, init, ROOT, PRDS_DIR };
