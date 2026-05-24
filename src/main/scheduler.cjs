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
const { randomUUID } = require('node:crypto');
const { ipcMain } = require('electron');
const billing = require('./usage.cjs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const supervisor = require('./supervisor.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { readTail } = require('./lib/fileTail.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const prdParser = require('./scheduler/prdParser.cjs');
const logs = require('./logs.cjs');
const { schemas } = require('./ipcSchemas.cjs');
const {
  POLL_INTERVAL_MS,
  USAGE_REFRESH_INTERVAL_MS,
  MAX_JOB_DURATION_MS,
} = require('./lib/schedulerConfig.cjs');

const MAX_INVESTIGATION_DURATION_MS = 30 * 60_000;

// After the agent emits a `result` event in its JSONL stream, the parent
// `claude -p` process should exit promptly. Real-world failure (2026-05-10
// cellar-publish): an agent emitted result=success, then spawned unbounded
// `until $(curl ...)` background bashes that kept the parent alive for 22
// minutes until manual intervention. The post-result watchdog catches this:
// if the process is still alive POST_RESULT_GRACE_MS after result, SIGTERM
// the whole process group; if still alive POST_RESULT_KILL_MS after SIGTERM,
// SIGKILL. The original `result.subtype` is preserved and used to map the
// kill exit code back to 0 so legit work isn't mismarked as failed.
const POST_RESULT_GRACE_MS = 90_000;
const POST_RESULT_KILL_MS = 30_000;
const RESULT_TAIL_POLL_MS = 5_000;
const RESULT_TAIL_BYTES = 8 * 1024;

// Idle-output watchdog: if the log file mtime stops advancing for this long
// while the process is still alive, the agent is hung mid-work (network
// stall, infinite tool loop, compaction wedge). User rule: anything not
// making progress for 20 minutes is presumed stuck. SIGTERM the process
// group, then SIGKILL after POST_RESULT_KILL_MS. The scheduler logs this
// distinctly from MAX_JOB_DURATION_MS so post-mortems can tell them apart.
const IDLE_OUTPUT_KILL_MS = 20 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

const ROOT = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans');
const PRDS_DIR = path.join(ROOT, 'prds');
const RUNS_DIR = path.join(ROOT, 'runs');
const PRDS_ARCHIVE_DIR = path.join(ROOT, 'prds-archived');
const QUEUE_PATH = path.join(ROOT, 'queue.json');
const SCHEDULER_STATE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-state.json');
const HEARTBEAT_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log');
const HEARTBEAT_MAX_BYTES = 1024 * 1024;
const DEFAULT_PROJECT_CWD = path.join(os.homedir(), 'Projects', 'session-manager');

const ENV_CAP = process.env.SM_SCHEDULER_MAX_CONCURRENCY
  ? Math.max(1, Math.min(20, parseInt(process.env.SM_SCHEDULER_MAX_CONCURRENCY, 10) || 4))
  : null;

const DEFAULT_CONFIG = {
  offsetMinutes: 15,
  concurrencyCap: ENV_CAP ?? 4,
  defaultCwd: DEFAULT_PROJECT_CWD,
  // 'when-available' = poll usage and fire whenever utilization < threshold.
  // 'on-reset'        = fire offsetMinutes after the next 5h reset (legacy).
  // 'manual'          = only fire on explicit Run now click.
  firePolicy: 'when-available',
  // For 'when-available'. Fire only when five_hour utilization < this percent.
  utilizationThreshold: 90,
  schemaVersion: 1,
  supervisor: {
    enabled: true,
    intervalMinutes: 15,
    maxConcurrentProbes: 2,
    probeStaleThresholdMinutes: 10,
  },
};

// ---------- fs helpers ----------

/**
 * Resolve PRDS_DIR/<slug>.md and enforce path containment. Returns the
 * absolute path on success, null on slug-escape attempts. The zod schema
 * for slugs already blocks `..` because the SLUG_RE excludes `/`, but
 * defense-in-depth: a second containment check after path.resolve costs
 * nothing and catches future regex laxity.
 */
function safeSlugPath(slug) {
  const resolved = path.resolve(path.join(PRDS_DIR, `${slug}.md`));
  if (!resolved.startsWith(PRDS_DIR + path.sep)) return null;
  return resolved;
}

function ensureDirs() {
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

// Atomic JSON write helpers delegate to config.cjs's shared implementation.
// Sync variant is required for the executeJob exit handler (Promise resolver
// callback that must flush meta.json before resolving) — replacing with async
// would deadlock the exit path.
const config = require('./config.cjs');
const atomicWriteJsonSync = (p, data) => config.writeJsonSync(p, data);
const atomicWriteJson = (p, data) => config.writeJson(p, data);

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
  // Sync write: called from many sync hot paths (clearPause, pollLoop catch
  // block) and the sidecar is tiny (<1 KB). Converting to async here would
  // require threading awaits through pause/resume bookkeeping for negligible
  // benefit — the file is well under one page.
  try {
    atomicWriteJsonSync(SCHEDULER_STATE_PATH, {
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

// Sync queue read — passed to the supervisor module (which calls it from
// supervisorTick / applyAction with no await) and the heartbeat interval.
// IPC handlers and mutate() use readQueue (async) below.
function readQueueSync() {
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

// Async queue read — used on all IPC hot paths. Reading queue.json sync was
// blocking the main thread inside ipcMain.handle callbacks; awaiting fsp.readFile
// hands control back to the renderer while the kernel paginates the file.
async function readQueue() {
  try {
    const raw = await fsp.readFile(QUEUE_PATH, 'utf8');
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

async function writeQueue(state) {
  ensureDirs();
  await atomicWriteJson(QUEUE_PATH, state);
}

// ---------- serialized mutation queue ----------

// All read-modify-write operations on queue.json go through mutate() so
// concurrent job completions in a parallel wave cannot lose each other's
// status updates. mutateTail is always a resolved promise even when the
// preceding mutate threw, so the chain never deadlocks.
let mutateTail = Promise.resolve();

function mutate(fn) {
  const next = mutateTail.then(async () => {
    const state = await readQueue();
    const ret = await fn(state);
    await writeQueue(state);
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
// PRD parsing + dir-mtime cache live in scheduler/prdParser.cjs. Local wrappers
// preserve the existing call shape (callers don't need to thread PRDS_DIR).
const parsePrdRaw = prdParser.parsePrdRaw;
const parsePrd = prdParser.parsePrd;
async function listPrdFiles() {
  ensureDirs();
  return prdParser.listPrdFiles(PRDS_DIR);
}

/**
 * Best-effort kill of a child claude PID that the previous app instance spawned
 * but never reaped. Used by init() to clean up the orphan tree on boot.
 *
 * Safety:
 *   - PID-recycling: between app death and this call, another process may have
 *     reused the PID. We read /proc/<pid>/cmdline (Linux) or `ps -p` (macOS)
 *     and only SIGTERM if the cmdline starts with the claude bin path.
 *   - Detached process group: jobs are spawned with detached:true so we kill
 *     -pid (the group). If the group leader is already gone, that fails
 *     silently and we fall back to single-pid kill.
 *   - Returns synchronously after issuing SIGTERM; a 5s SIGKILL follow-up is
 *     scheduled via setTimeout to clean up any process ignoring SIGTERM.
 *
 * Returns: 'killed' (cmdline matched + signal sent), 'gone' (pid not alive),
 *          'mismatch' (pid alive but cmdline doesn't look like claude),
 *          'unknown' (couldn't read cmdline — leave the pid alone).
 */
function killOrphanClaudePid(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 1) return 'gone';
  try { process.kill(pid, 0); } catch { return 'gone'; }
  let cmdline = '';
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    try {
      const out = require('node:child_process').execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
      cmdline = out.trim();
    } catch { return 'unknown'; }
  }
  if (!/\bclaude\b/.test(cmdline)) return 'mismatch';
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch { /* race: died between checks */ } }
  setTimeout(() => {
    try { process.kill(pid, 0); } catch { return; /* already gone */ }
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* race */ } }
  }, 5000).unref?.();
  return 'killed';
}

/**
 * Validate that a string is safe to pass as a child_process.spawn argv element.
 *
 * Node.js rejects argv strings containing NUL bytes with a cryptic error:
 *   "The argument 'args[1]' must be a string without null bytes. Received '...'"
 *
 * The error message truncates the offending string at ~120 chars, so when it
 * surfaces in the queue.json `error` field the user has no way to find the
 * actual byte. The real incident (2026-05-21, PRD 03-doc-editor-foundation)
 * was a single NUL inside backtick code-fence in the PRD body. Total wall-clock
 * to diagnose: ~30min. This validator catches it pre-spawn and reports the
 * file + offset + surrounding context.
 *
 * Also flags other ASCII control bytes (< 0x20 except TAB/LF/CR), since they
 * are virtually always a typo or copy-paste artifact in a markdown PRD body
 * and may cause subtle issues in claude's prompt tokenizer.
 */
function validatePromptForSpawn(body, srcLabel) {
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) {
      const start = Math.max(0, i - 20);
      const end = Math.min(body.length, i + 20);
      const ctx = body.slice(start, end).replace(/[\x00-\x1F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      const hex = code.toString(16).padStart(2, '0');
      return {
        ok: false,
        error: `PRD body contains control char 0x${hex} at byte offset ${i} in ${srcLabel} (context: "${ctx}"). child_process.spawn would reject this with a truncated error message; remove the control char and re-queue.`,
      };
    }
  }
  return { ok: true };
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
async function reconcile(state) {
  const files = await listPrdFiles();
  const onDisk = new Map();
  for (const f of files) {
    try {
      // Per-file await: parsing is mtime-cached so steady-state hits zero
      // disk reads; on cold cache the awaits keep the main thread responsive.
      const p = await parsePrd(f);
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
let firstNon429FailureAt = null; // tracks only transient/config failures; 429s don't count toward network-pause threshold
let lastFailureKind = null; // 'transient' | 'meter_rate_limited' | 'auth' | null
let pauseClearedManuallyAt = null;

// ---------- timer ----------

let mainWindow = null;
let fireTimer = null;
let resumeTimer = null;
let pollLoopTimer = null;
let rescheduleInterval = null;
let heartbeatInterval = null;
// In-memory set of slugs currently spawned in this process. Prevents
// double-spawn when runDueJobs() is called while jobs are in flight.
const runningSet = new Set();
let cancelToken = { cancelled: false };

function attachWindow(w) { mainWindow = w; }

/**
 * Build the snapshot payload consumed by both the `schedule:state` IPC
 * handler and the `schedule:state` broadcast event. The IPC return adds a
 * `paths` map (renderer uses it for "open folder" actions); broadcast omits
 * it because subscribers don't need to re-derive paths on every tick.
 */
function buildScheduleStatePayload(state, { withPaths = false } = {}) {
  const payload = {
    config: state.config,
    jobs: state.jobs,
    scheduledFor: state.scheduledFor,
    lastRunAt: state.lastRunAt,
    nextReset: getNextResetCached(),
    paused: state.paused,
    utilization: cachedUtilization,
  };
  if (withPaths) {
    payload.paths = { root: ROOT, prds: PRDS_DIR, runs: RUNS_DIR, queue: QUEUE_PATH };
  }
  return payload;
}

async function broadcast() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = await readQueue();
  await reconcile(state);
  await writeQueue(state);
  sendIfAlive(mainWindow, 'schedule:state', buildScheduleStatePayload(state));
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
  const fireAt = await mutate(async (state) => {
    await reconcile(state);
    const fa = computeFireAt(state, nextResetIso);
    state.scheduledFor = fa ? new Date(fa).toISOString() : null;
    return fa;
  });
  await broadcast();
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
  await broadcast();
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
    // The user has just affirmed the queue should run — clear the failure
    // counters so the renderer doesn't keep nagging about stale poll fails.
    // The next poll will set them again if the condition still applies.
    consecutiveFailures = 0;
    backoffMs = 0;
    backoffNextAt = null;
    firstFailureAt = null;
    firstNon429FailureAt = null;
    lastFailureKind = null;
    persistSchedulerState();
  }
  if (wasPaused) await broadcast();
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
  const sessionId = randomUUID();

  const fd = fs.openSync(logPath, 'a');
  let fdClosed = false;
  const closeFd = () => { if (fdClosed) return; fdClosed = true; try { fs.closeSync(fd); } catch { /* */ } };
  // safeLog: no-op once the fd is closed, never throws on the watchdog timer
  // path. Pre-fix, a post-result/idle watchdog firing AFTER closeFd would
  // throw EBADF and crash the host. Every fs.writeSync(fd, …) below goes
  // through this helper.
  const safeLog = (msg) => {
    if (fdClosed) return;
    try { fs.writeSync(fd, msg); } catch { /* fd vanished mid-write */ }
  };

  safeLog(`[scheduler] starting ${job.slug} at ${new Date().toISOString()}\n[scheduler] cwd=${cwd}\n\n`);

  // Dead-cwd guard: verify the target directory exists and is traversable
  // before handing it to the child process.
  try { fs.accessSync(cwd, fs.constants.X_OK); }
  catch {
    const errMsg = `cwd no longer exists: ${cwd}`;
    safeLog(`[scheduler] ${errMsg}\n`);
    closeFd();
    // Sync write: this is an early-exit error path inside an async function,
    // so we could await, but using the sync variant keeps the error path
    // ordering identical to the spawn-failed branch below (also sync).
    atomicWriteJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs: 0 });
    return { exitCode: -1, durationMs: 0, error: errMsg, sessionId };
  }

  // Read full PRD body fresh from disk (queue stored only the preview).
  let prompt;
  const prdPath = path.join(PRDS_DIR, `${job.slug}.md`);
  try {
    const parsed = await parsePrd(prdPath);
    prompt = parsed.body;
  } catch (e) {
    safeLog(`[scheduler] failed to read PRD: ${e?.message}\n`);
    closeFd();
    return { exitCode: -1, durationMs: 0, error: e?.message };
  }

  const promptCheck = validatePromptForSpawn(prompt, prdPath);
  if (!promptCheck.ok) {
    safeLog(`[scheduler] ${promptCheck.error}\n`);
    closeFd();
    atomicWriteJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: promptCheck.error, startedAt, finishedAt: Date.now(), durationMs: 0 });
    return { exitCode: -1, durationMs: 0, error: promptCheck.error, sessionId };
  }

  return await new Promise((resolve) => {
    const claudeBin = resolveClaudeBin();
    // Strip Claude Code env and secrets that leak in when session-manager is
    // launched from a `claude` shell. CLAUDE_EFFORT=xhigh forces Opus and
    // overrides `--model sonnet`, so scheduled jobs burn Opus credits silently.
    const childEnv = cleanChildEnv();
    // Guard against synchronous spawn failures (EAGAIN, ENOMEM on fork).
    // Without this, the throw bubbles out of the Promise executor and the
    // outer await rejects — but the open fd is leaked.
    let child;
    try {
      child = spawn(claudeBin, [
        '-p', prompt,
        '--model', 'sonnet',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        '--session-id', sessionId,
      ], {
        cwd,
        env: childEnv,
        stdio: ['ignore', fd, fd],
        // detached:true puts the child in its own process group so we can kill
        // the entire descendant tree (including any stray background bashes the
        // agent spawned) with `process.kill(-pid)`. Without this, child.kill()
        // only kills the immediate `claude` process, leaving orphaned subprocs
        // that keep the parent alive (the 2026-05-10 cellar-publish hang).
        detached: true,
      });
    } catch (e) {
      const errMsg = `spawn failed: ${e?.message ?? String(e)}`;
      safeLog(`[scheduler] ${errMsg}\n`);
      closeFd();
      const durationMs = Date.now() - startedAt;
      // Sync write: inside the Promise executor, before resolve(). Awaiting
      // here would require restructuring the executor; the meta file is tiny
      // and this is an error path, not the IPC hot path.
      atomicWriteJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs });
      resolve({ exitCode: -1, durationMs, error: errMsg, sessionId });
      return;
    }

    safeLog(`[scheduler] spawned pid=${child.pid} sessionId=${sessionId} (process group)\n\n`);

    // Fire-and-forget pid persistence — best effort.
    if (onPid) onPid(child.pid, sessionId, cwd).catch(() => {});

    // Track whether the agent has emitted a `result` event in its JSONL stream.
    // null until seen; then one of "success" | "error_max_turns" | ... per the
    // claude harness's result subtype taxonomy.
    let agentResultSubtype = null;
    let postResultTimer = null;
    let postResultKillTimer = null;

    const killTree = (signal) => {
      // Kill the whole process group. Negative pid targets the group leader's
      // group (only works because we spawned with detached:true).
      try { process.kill(-child.pid, signal); return true; }
      catch {
        try { process.kill(child.pid, signal); return true; }
        catch { return false; /* already dead */ }
      }
    };

    // Tail the log for {"type":"result","subtype":"..."} events. When we see
    // one, start the post-result grace timer — the agent has declared done,
    // so the process should exit promptly. If not, something is hanging
    // (the cellar-publish failure mode).
    const resultTailer = setInterval(() => {
      if (agentResultSubtype) return; // already seen; tailer will be cleared below
      try {
        const stat = fs.statSync(logPath);
        if (stat.size === 0) return;
        const n = Math.min(stat.size, RESULT_TAIL_BYTES);
        const buf = Buffer.alloc(n);
        const fdR = fs.openSync(logPath, 'r');
        fs.readSync(fdR, buf, 0, n, stat.size - n);
        fs.closeSync(fdR);
        const m = buf.toString('utf8').match(/\{"type":"result","subtype":"([a-z_]+)"/);
        if (!m) return;
        agentResultSubtype = m[1];
        safeLog(`\n[scheduler] result event detected (subtype=${agentResultSubtype}); ` +
          `starting ${Math.round(POST_RESULT_GRACE_MS/1000)}s exit-grace timer\n`);
        clearInterval(resultTailer);
        postResultTimer = setTimeout(() => {
          safeLog(`\n[scheduler] post-result grace expired (${Math.round(POST_RESULT_GRACE_MS/1000)}s); ` +
            `child still alive — SIGTERM process group\n`);
          killTree('SIGTERM');
          postResultKillTimer = setTimeout(() => {
            safeLog(`\n[scheduler] still alive ${Math.round(POST_RESULT_KILL_MS/1000)}s after SIGTERM — SIGKILL\n`);
            killTree('SIGKILL');
          }, POST_RESULT_KILL_MS);
          if (postResultKillTimer.unref) postResultKillTimer.unref();
        }, POST_RESULT_GRACE_MS);
        if (postResultTimer.unref) postResultTimer.unref();
      } catch { /* log not readable yet; try again */ }
    }, RESULT_TAIL_POLL_MS);
    if (resultTailer.unref) resultTailer.unref();

    // Kill the child if it runs past the maximum allowed duration.
    const watchdog = setTimeout(() => {
      safeLog(`\n[scheduler] watchdog SIGKILL after ${MAX_JOB_DURATION_MS}ms\n`);
      killTree('SIGKILL');
    }, MAX_JOB_DURATION_MS);
    if (watchdog.unref) watchdog.unref();

    // Idle-output watchdog: poll log mtime every IDLE_CHECK_INTERVAL_MS; if
    // it hasn't advanced in IDLE_OUTPUT_KILL_MS, presume the agent is stuck
    // and SIGTERM the process group.
    let idleKillTimer = null;
    const idleChecker = setInterval(() => {
      try {
        const stat = fs.statSync(logPath);
        const idleMs = Date.now() - stat.mtimeMs;
        if (idleMs > IDLE_OUTPUT_KILL_MS) {
          safeLog(`\n[scheduler] idle-output watchdog: log mtime stalled ` +
            `${Math.round(idleMs/1000)}s (> ${Math.round(IDLE_OUTPUT_KILL_MS/1000)}s threshold) — SIGTERM process group\n`);
          clearInterval(idleChecker);
          killTree('SIGTERM');
          idleKillTimer = setTimeout(() => {
            safeLog(`\n[scheduler] idle watchdog: still alive ${Math.round(POST_RESULT_KILL_MS/1000)}s after SIGTERM — SIGKILL\n`);
            killTree('SIGKILL');
          }, POST_RESULT_KILL_MS);
          if (idleKillTimer.unref) idleKillTimer.unref();
        }
      } catch { /* log not statable; skip */ }
    }, IDLE_CHECK_INTERVAL_MS);
    if (idleChecker.unref) idleChecker.unref();

    const clearAllTimers = () => {
      clearTimeout(watchdog);
      clearInterval(resultTailer);
      clearInterval(idleChecker);
      if (postResultTimer) clearTimeout(postResultTimer);
      if (postResultKillTimer) clearTimeout(postResultKillTimer);
      if (idleKillTimer) clearTimeout(idleKillTimer);
    };

    child.on('error', (err) => {
      clearAllTimers();
      const durationMs = Date.now() - startedAt;
      safeLog(`\n[scheduler] error: ${err.message}\n`);
      closeFd();
      // Sync write: child event handler must flush meta before resolve().
      atomicWriteJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: err.message, startedAt, finishedAt: Date.now(), durationMs });
      resolve({ exitCode: -1, durationMs, error: err.message, sessionId });
    });

    child.on('exit', (code, signal) => {
      clearAllTimers();
      const durationMs = Date.now() - startedAt;
      // If we SIGTERM'd because of the post-result watchdog AND the agent had
      // emitted result=success, the work succeeded; only the cleanup hung.
      // Map the kill exit code to 0 so the job is marked completed, not failed.
      // Node's child.on('exit') reports either code (normal) or signal (killed);
      // when killed by signal, code is null. We also check 143 (128+SIGTERM)
      // and 137 (128+SIGKILL) in case the process exited via signal-as-code.
      let effectiveCode = code;
      const killedBySignal = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 143 || code === 137 || code === null;
      const mappedToSuccess = agentResultSubtype === 'success' && killedBySignal;
      if (mappedToSuccess) {
        effectiveCode = 0;
        safeLog(`\n[scheduler] mapping exit code=${code} signal=${signal} → 0 ` +
          `(result=success was emitted before kill)\n`);
      }
      safeLog(`\n[scheduler] exit code=${effectiveCode} (raw code=${code} signal=${signal}) ` +
        `duration=${Math.round(durationMs / 1000)}s\n`);
      closeFd();
      const rateLimited = effectiveCode !== 0 && detectRateLimitInLog(logPath);
      // Sync write: child 'exit' handler must flush meta before resolve()
      // so the spawnJob mutate() that follows sees the persisted exit code.
      atomicWriteJsonSync(metaPath, {
        slug: job.slug, cwd, sessionId, exitCode: effectiveCode, rateLimited,
        startedAt, finishedAt: Date.now(), durationMs,
        agentResultSubtype, mappedFromSignal: mappedToSuccess ? signal || `code=${code}` : null,
      });
      resolve({ exitCode: effectiveCode, durationMs, rateLimited, sessionId });
    });
  });
}

/**
 * Pick the next batch of jobs to spawn this tick.
 *
 * Rules:
 *   1. Find the lowest parallelGroup that has pending jobs not already in
 *      runningSet.
 *   2. If that group has jobs in runningSet (i.e., we're mid-group), backfill
 *      up to (cap - runningSet.size) more from the SAME group.
 *   3. If the current group has NO jobs in runningSet (new group), and there
 *      are still jobs from an earlier group in runningSet, do nothing — wait
 *      for the earlier group to drain before advancing.
 *   4. **Late-arrival**: if a lower-numbered (higher-priority) PRD reconciles
 *      AFTER a higher-numbered group was already picked, fire the late-arrival
 *      immediately in parallel with the active group rather than starving it
 *      until the active group drains. This handles the reconcile-race where
 *      a PRD file lands on disk between two pickNextBatch invocations.
 *   5. A singleton group (unique NN, no other jobs share it) runs alone;
 *      no bleed into adjacent groups.
 *
 * Returns array of job objects to spawn. O(N) where N = pending.length.
 */
function pickNextBatch(allJobs, running, cap) {
  const pending = allJobs.filter((j) => j.status === 'pending' && !running.has(j.slug));
  if (pending.length === 0) return [];

  // Lowest pending group (computed up-front so the failure gate can compare).
  const lowestPendingGroup = pending.reduce(
    (min, j) => Math.min(min, j.parallelGroup ?? 99),
    Infinity,
  );

  // Cross-group failure gate: refuse to advance past a group with failed jobs.
  // Without this, a failed foundation PRD (e.g. 03-doc-editor-foundation
  // crashed with a NUL-byte spawn error on 2026-05-21) doesn't stop later
  // groups (04, 05, 06...) from running and silently corrupting the project
  // state. The user can re-queue the failed job (pending) or archive it to
  // unblock the gate, but the default is to halt until the failure is
  // acknowledged.
  const blockingFailures = allJobs.filter((j) =>
    j.status === 'failed' && (j.parallelGroup ?? 99) < lowestPendingGroup,
  );
  if (blockingFailures.length > 0) {
    const slugs = blockingFailures.map((j) => j.slug).join(', ');
    console.log(`[scheduler] failure-gate: holding g${lowestPendingGroup} — ${blockingFailures.length} failed job(s) in earlier groups [${slugs}]. Reset to pending or archive to unblock.`);
    return [];
  }

  // Groups with at least one job in flight: either tracked in runningSet
  // (this process spawned it) or still marked 'running' in queue.json
  // (persisted from a previous session that hasn't been orphan-reset yet).
  const activeGroups = new Set();
  for (const slug of running) {
    const job = allJobs.find((j) => j.slug === slug);
    if (job) activeGroups.add(job.parallelGroup ?? 99);
  }
  for (const j of allJobs) {
    if (j.status === 'running' && !running.has(j.slug)) {
      activeGroups.add(j.parallelGroup ?? 99);
    }
  }
  // Total slots consumed: in-process spawns + queue.json running count.
  const queueRunningCount = allJobs.filter((j) => j.status === 'running').length;
  const effectiveRunning = Math.max(running.size, queueRunningCount);

  // (lowestPendingGroup was computed up-front for the failure-gate check.)

  if (activeGroups.size > 0) {
    const lowestActive = Math.min(...activeGroups);
    if (lowestPendingGroup > lowestActive) {
      // Earlier group still running — wait for it to drain before advancing.
      console.log(`[scheduler] concurrency: g${lowestActive} in flight, holding g${lowestPendingGroup}`);
      return [];
    }
    if (lowestPendingGroup < lowestActive) {
      // Late-arrival: a lower-numbered (higher-priority) PRD reconciled AFTER
      // a higher-numbered group was already picked. Without this branch the
      // pending PRD starves until the active group drains — the bug observed
      // on 2026-05-10 where 118-studio-add-wave2-games (g118) was held while
      // the g130 hardening trio ran. Honor priority: fire the late-arrival
      // now, in parallel with the active group. (Strict serial group
      // ordering still applies between groups that were both present at the
      // time of picking; this only handles the reconcile-race edge case.)
      const slots = cap - effectiveRunning;
      if (slots <= 0) {
        console.log(`[scheduler] concurrency: cap ${cap} reached (${effectiveRunning} running), no slots for late-arrival g${lowestPendingGroup}`);
        return [];
      }
      const batch = pending.filter((j) => (j.parallelGroup ?? 99) === lowestPendingGroup).slice(0, slots);
      console.log(`[scheduler] concurrency: firing late-arrival g${lowestPendingGroup} (${batch.length} job(s)) alongside active g${lowestActive}`);
      return batch;
    }
    // Backfill slots remaining in the current group.
    const slots = cap - effectiveRunning;
    if (slots <= 0) {
      console.log(`[scheduler] concurrency: cap ${cap} reached (${effectiveRunning} running), no slots`);
      return [];
    }
    const batch = pending.filter((j) => (j.parallelGroup ?? 99) === lowestActive).slice(0, slots);
    if (batch.length > 0) {
      console.log(`[scheduler] concurrency: backfilling ${batch.length} into g${lowestActive} (${effectiveRunning}/${cap} running)`);
    }
    return batch;
  }

  // No active group — start the next group fresh.
  const slots = cap - effectiveRunning;
  if (slots <= 0) {
    console.log(`[scheduler] concurrency: cap ${cap} reached (${effectiveRunning} running), no slots`);
    return [];
  }
  const batch = pending.filter((j) => (j.parallelGroup ?? 99) === lowestPendingGroup).slice(0, slots);
  console.log(`[scheduler] concurrency: starting g${lowestPendingGroup} with ${batch.length} job(s) (cap ${cap})`);
  return batch;
}

/**
 * Recognize fix-plan slugs (NN-fix-...) so we don't recurse on a fix-plan that
 * itself failed. The pattern matches the slug we generate in spawnInvestigation.
 */
function isFixPlanSlug(slug) {
  return /^\d+-fix-/.test(slug);
}

/**
 * Spawn an Opus investigation session for a failed job. The investigator's job
 * is to read the failure log + original PRD, identify the root cause, and write
 * a fix-plan PRD into prds/<NN>-fix-<base>.md. Reconcile picks it up; the next
 * Sonnet slot fires it. Investigations themselves are NOT queue entries — they
 * run out-of-band, so they don't consume the concurrency cap. They DO consume
 * tokens, which the when-available throttle will reflect on the next poll.
 *
 * Skipped if the failed job is itself a fix-plan (avoids infinite recursion).
 */
async function spawnInvestigation(failedJob, runDir) {
  if (isFixPlanSlug(failedJob.slug)) {
    console.log(`[scheduler] skip investigation: ${failedJob.slug} is itself a fix plan`);
    return;
  }

  const failedLogPath = path.join(runDir, `${failedJob.slug}.log`);
  const investigationLogPath = path.join(runDir, `${failedJob.slug}.investigation.log`);

  let originalBody = '';
  try {
    originalBody = (await parsePrd(path.join(PRDS_DIR, `${failedJob.slug}.md`))).body;
  } catch {
    originalBody = failedJob.bodyPreview || '(original PRD missing from disk)';
  }

  const logTail = readTail(failedLogPath, 16 * 1024) || '(failed to read log)';

  const baseSlug = failedJob.slug.replace(/^\d+-/, '');
  const group = failedJob.parallelGroup ?? 99;
  const fixSlug = `${String(group).padStart(2, '0')}-fix-${baseSlug}`;
  const fixPath = path.join(PRDS_DIR, `${fixSlug}.md`);

  if (fs.existsSync(fixPath)) {
    console.log(`[scheduler] skip investigation: fix plan already exists at ${fixPath}`);
    return;
  }

  // cwd fallback: if the failed job's cwd is missing on disk, the investigator
  // child would itself fail to spawn (ENOENT). Fall back to DEFAULT_PROJECT_CWD
  // so the investigation can still write a fix plan that updates the cwd or
  // re-creates the missing project directory.
  let cwd = failedJob.cwd || DEFAULT_PROJECT_CWD;
  try { fs.accessSync(cwd, fs.constants.X_OK); }
  catch {
    console.warn(`[scheduler] investigation cwd missing (${cwd}); falling back to ${DEFAULT_PROJECT_CWD}`);
    cwd = DEFAULT_PROJECT_CWD;
  }
  const prompt = `You are investigating a failed scheduled job in the session-manager queue. Your ONLY job is to write a fix-plan PRD file. Do NOT attempt the fix yourself.

# Failed job
- Slug: ${failedJob.slug}
- Title: ${failedJob.title}
- cwd: ${cwd}
- Exit code: ${failedJob.exitCode}
- Full failure log: ${failedLogPath}

# Original PRD body (this is what the job was trying to do)
\`\`\`
${originalBody}
\`\`\`

# Last ~16KB of the failure log (stream-json format from \`claude -p\`)
\`\`\`
${logTail}
\`\`\`

# Your task
1. Read the full failure log at ${failedLogPath} if the tail above isn't sufficient.
2. Read source files in ${cwd} as needed to understand the context.
3. Identify the root cause of the failure.
4. Write a NEW fix-plan PRD file at exactly this path:

   ${fixPath}

5. The frontmatter MUST be exactly this format (no extra keys):
   \`\`\`
   ---
   title: Fix: <short summary of the fix>
   cwd: ${cwd}
   parallelGroup: ${group}
   estimateMinutes: <your time estimate>
   ---
   \`\`\`
6. The PRD body MUST be self-contained — \`claude -p\` runs it on a fresh Sonnet session with NO conversation context. Include:
   - Root-cause analysis (what went wrong and why)
   - Concrete fix steps (specific files / commands / edits)
   - Verification command(s) the next agent should run to confirm the fix
   - Acceptance criteria

DO NOT attempt the fix. ONLY write the file. When the file exists, exit immediately.`;

  const fd = fs.openSync(investigationLogPath, 'a');
  let fdClosed = false;
  const closeFd = () => { if (fdClosed) return; fdClosed = true; try { fs.closeSync(fd); } catch { /* */ } };
  const safeLog = (msg) => { if (fdClosed) return; try { fs.writeSync(fd, msg); } catch { /* fd vanished mid-write */ } };
  const sessionId = randomUUID();
  safeLog(`[scheduler] investigation starting for ${failedJob.slug} at ${new Date().toISOString()}\n[scheduler] target fix PRD: ${fixPath}\n[scheduler] sessionId=${sessionId}\n\n`);

  const claudeBin = resolveClaudeBin();
  const childEnv = cleanChildEnv();
  const investigationPromptCheck = validatePromptForSpawn(prompt, `<investigation prompt for ${failedJob.slug}>`);
  if (!investigationPromptCheck.ok) {
    safeLog(`\n[scheduler] ${investigationPromptCheck.error}\n`);
    closeFd();
    return;
  }
  let child;
  try {
    child = spawn(claudeBin, [
      '-p', prompt,
      '--model', 'opus',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', sessionId,
    ], {
      cwd,
      env: childEnv,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    safeLog(`\n[scheduler] investigation spawn failed: ${e?.message ?? e}\n`);
    closeFd();
    return;
  }

  safeLog(`[scheduler] investigation pid=${child.pid}\n\n`);

  const watchdog = setTimeout(() => {
    safeLog(`\n[scheduler] investigation watchdog SIGKILL after ${MAX_INVESTIGATION_DURATION_MS}ms\n`);
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }, MAX_INVESTIGATION_DURATION_MS);
  if (watchdog.unref) watchdog.unref();

  child.on('error', (err) => {
    clearTimeout(watchdog);
    safeLog(`\n[scheduler] investigation error: ${err.message}\n`);
    closeFd();
  });

  child.on('exit', (code) => {
    clearTimeout(watchdog);
    safeLog(`\n[scheduler] investigation exit code=${code}\n`);
    closeFd();
    if (fs.existsSync(fixPath)) {
      console.log(`[scheduler] investigation produced fix plan: ${fixSlug}`);
    } else {
      console.log(`[scheduler] investigation finished WITHOUT producing fix plan (slug=${failedJob.slug}, code=${code})`);
    }
    // Trigger a tick so the new fix plan is reconciled into the queue and fired.
    tickQueue().catch(() => {});
  });
}

async function spawnJob(job, runId, runDir, defaultCwd) {
  runningSet.add(job.slug);
  try {
    await mutate((s) => {
      const idx = s.jobs.findIndex((x) => x.slug === job.slug);
      if (idx >= 0) {
        s.jobs[idx].status = 'running';
        s.jobs[idx].runId = runId;
        s.jobs[idx].startedAt = new Date().toISOString();
      }
    });
    await broadcast();

    const res = await executeJob(job, runDir, defaultCwd, async (pid, sessionId, cwd) => {
      await mutate((s) => {
        const idx = s.jobs.findIndex((x) => x.slug === job.slug);
        if (idx >= 0) {
          s.jobs[idx].sessionId = sessionId;
          s.jobs[idx].runtime = { pid, runId, startedAt: s.jobs[idx].startedAt, sessionId, cwd };
        }
      });
      await broadcast();
    });

    if (res.rateLimited) {
      const resetIso = await refreshNextReset().catch(() => cachedNextReset);
      await setPaused('rate_limit', resetIso);
    }

    let actuallyFailed = false;
    let failedJobSnapshot = null;
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
          if (s.jobs[i2].status === 'failed') {
            actuallyFailed = true;
            failedJobSnapshot = { ...s.jobs[i2] };
          }
        }
      }
    });
    await broadcast();

    if (actuallyFailed && failedJobSnapshot) {
      // Transient-failure detector: SIGTERM/SIGKILL within 30s = almost
      // always external kill (user-initiated app restart, OOM-kill, manual
      // process kill). The PRD itself didn't fail; the run was interrupted
      // before it could do meaningful work. Spawning an Opus investigator on
      // these is wasted tokens AND pollutes the queue with redundant fix-PRDs
      // (real example 2026-05-21: 07-agent-view-robot-rename-lasttool got
      // SIGTERMed at 10s by an app restart, the rename had already been done
      // anyway, and the auto-generated fix-PRD just sat in queue.json as
      // noise). Auto-retry up to 2x before falling through to investigation.
      const ec = failedJobSnapshot.exitCode;
      const transient = (ec === 143 || ec === 137) && res.durationMs < 30_000;
      const retries = failedJobSnapshot.transientRetries ?? 0;
      if (transient && retries < 2) {
        console.log(`[scheduler] transient failure (exit=${ec} dur=${res.durationMs}ms) — auto-retry ${retries + 1}/2 for ${job.slug}`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            resetJobFields(s.jobs[i], null);
            s.jobs[i].transientRetries = retries + 1;
          }
        });
        await broadcast();
      } else {
        spawnInvestigation(failedJobSnapshot, runDir).catch((e) => {
          console.error('[scheduler] spawnInvestigation error', job.slug, e);
        });
      }
    }
  } catch (e) {
    console.error('[scheduler] spawnJob error', job.slug, e);
  } finally {
    runningSet.delete(job.slug);
    // Each job completion is a signal to advance the queue.
    tickQueue().catch(() => {});
  }
}

// Serialized ticker: prevents two concurrent tickQueue() calls from racing
// on the same pending jobs. A simple promise tail suffices since pickNextBatch
// is synchronous and spawnJob is fire-and-forget.
let tickTail = Promise.resolve();

function tickQueue() {
  const next = tickTail.then(async () => {
    const state = await readQueue();
    if (state.paused) {
      console.log('[scheduler] tickQueue skipped: paused');
      return;
    }
    if (cancelToken.cancelled) return;

    await reconcile(state);
    const cap = ENV_CAP ?? state.config.concurrencyCap;
    const batch = pickNextBatch(state.jobs, runningSet, cap);
    if (batch.length === 0) return;

    await mutate((s) => { s.lastRunAt = new Date().toISOString(); });
    await broadcast();

    const { runId, dir: runDir } = pickRunDir();
    for (const job of batch) {
      if (cancelToken.cancelled) break;
      // spawnJob is fire-and-forget; it calls tickQueue() on completion.
      spawnJob(job, runId, runDir, state.config.defaultCwd).catch(() => {});
    }
  });
  tickTail = next.catch(() => {});
  return next;
}

async function runDueJobs() {
  const state = await readQueue();
  if (state.paused) {
    console.log('[scheduler] runDueJobs skipped: paused');
    return;
  }
  cancelToken = { cancelled: false };
  await tickQueue();
  // Clear the one-shot scheduledFor without waiting for jobs to settle.
  await mutate((s) => { s.scheduledFor = null; });
  await broadcast();
}

// ---------- when-available launch logic ----------

async function maybeLaunchWhenAvailable(state) {
  if (state.config.firePolicy !== 'when-available') return;
  if (state.paused) return;
  const pending = state.jobs.filter((j) => j.status === 'pending' && !runningSet.has(j.slug));
  if (pending.length === 0) return;
  if (cachedUtilization === null || cachedUtilization === undefined) return;
  if (cachedUtilization >= state.config.utilizationThreshold) {
    await broadcast();
    return;
  }
  console.log(`[scheduler] when-available: util=${cachedUtilization}%, ${pending.length} pending, ${runningSet.size} running — ticking`);
  tickQueue().catch((e) => console.error('[scheduler] tickQueue error', e));
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
      firstNon429FailureAt = null;
      lastFailureKind = null;
      lastPollAt = Date.now();
      lastPollOk = true;
      persistSchedulerState();

      // If a 'network' pause resolved, clear it now that we have a good reading.
      const cur = await readQueue();
      if (cur.paused?.reason === 'network') {
        await clearPause('network-recovered');
      }
      // If 'reset_failure' was set and we now have a valid reset, clear it.
      if (cur.paused?.reason === 'reset_failure' && cachedNextReset) {
        await clearPause('reset-recovered');
      }

      await maybeLaunchWhenAvailable(cur);
      await broadcast();
    } else if (r.kind === 'meter_rate_limited') {
      // Billing meter is itself being rate-limited. Treat as "utilization unknown but safe":
      // fire available jobs anyway at utilization=0 rather than pausing the queue.
      lastPollAt = Date.now();
      lastPollOk = false;
      consecutiveFailures++;
      lastFailureKind = 'meter_rate_limited';
      // Don't update firstNon429FailureAt — 429s don't count toward the 30-min network-pause threshold.
      cachedUtilization = 0; // assume safe; fire any pending work
      console.log(`[scheduler] billing meter rate-limited (HTTP 429) — firing on heuristic (failure #${consecutiveFailures})`);
      const cur = await readQueue();
      await maybeLaunchWhenAvailable(cur);
      await broadcast();
    } else {
      lastPollAt = Date.now();
      lastPollOk = false;
      consecutiveFailures++;
      if (!firstFailureAt) firstFailureAt = Date.now();

      if (r.kind === 'auth') {
        lastFailureKind = 'auth';
        console.error(`[scheduler] auth failure (HTTP ${r.httpStatus}): ${r.message}`);
        await setPaused('auth', null);
      } else {
        // transient or config — apply exponential backoff and count toward 30-min threshold.
        lastFailureKind = 'transient';
        if (!firstNon429FailureAt) firstNon429FailureAt = Date.now();
        backoffMs = backoffMs ? Math.min(backoffMs * 2, 480_000) : 30_000;
        const totalNon429FailureMs = Date.now() - firstNon429FailureAt;
        console.log(`[scheduler] transient failure #${consecutiveFailures}: ${r.kind} ${r.message ?? ''}; retry in ${backoffMs / 1000}s`);

        // After 30 minutes of consecutive non-429 failures, set 'network' pause.
        if (totalNon429FailureMs > 30 * 60_000) {
          const cur2 = await readQueue();
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
    lastFailureKind = 'transient';
    if (!firstFailureAt) firstFailureAt = Date.now();
    if (!firstNon429FailureAt) firstNon429FailureAt = Date.now();
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
  supervisor.registerHandlers();

  ipcMain.handle('schedule:state', async () => {
    const state = await readQueue();
    await reconcile(state);
    await writeQueue(state);
    return buildScheduleStatePayload(state, { withPaths: true });
  });

  ipcMain.handle('schedule:health', async () => {
    const state = await readQueue();
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
      lastFailureKind,
      backoffNextAt,
      nextResetCached: cachedNextReset,
      pausedSince: state.paused ? Date.parse(state.paused.since) : null,
      pauseReason: state.paused?.reason ?? null,
      runningJobs,
    };
  });

  ipcMain.handle('schedule:force-tick', async () => {
    // Bypass the billing-poll gate entirely — fire pending jobs immediately regardless of meter state.
    // Clears any existing pause first (same semantics as run-now).
    await clearPause('run-now');
    runDueJobs().catch((e) => logs.writeLine({ level: 'error', scope: 'scheduler', message: 'runDueJobs error (force-tick)', meta: { error: e?.message } }));
    return { ok: true };
  });

  ipcMain.handle('schedule:set-config', async (_e, partial) => {
    let validated;
    try {
      validated = schemas.setConfigSchema.parse(partial || {});
    } catch (e) {
      return { ok: false, error: e?.message ?? 'invalid config' };
    }
    const config = await mutate((state) => {
      const { supervisor: supPartial, ...rest } = validated;
      state.config = { ...state.config, ...rest };
      if (supPartial !== undefined) {
        state.config.supervisor = { ...(state.config.supervisor ?? {}), ...supPartial };
      }
      return state.config;
    });
    await rescheduleTimer();
    return { ok: true, config };
  });

  ipcMain.handle('schedule:reset-job', async (_e, payload) => {
    let slug;
    try {
      ({ slug } = schemas.scheduleSlug.parse(payload));
    } catch (e) {
      return { ok: false, error: 'invalid slug' };
    }
    if (!safeSlugPath(slug)) return { ok: false, error: 'invalid slug' };
    const found = await mutate((state) => {
      const idx = state.jobs.findIndex((j) => j.slug === slug);
      if (idx < 0) return false;
      resetJobFields(state.jobs[idx]);
      return true;
    });
    if (!found) return { ok: false, error: 'not found' };
    await broadcast();
    return { ok: true };
  });

  ipcMain.handle('schedule:run-now', async () => {
    // Manual run-now overrides any auto-pause. Clear it first.
    await clearPause('run-now');
    runDueJobs().catch((e) => logs.writeLine({ level: 'error', scope: 'scheduler', message: 'runDueJobs error (run-now)', meta: { error: e?.message } }));
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

  // Re-scan prds/ folder and merge into queue.json. The `schedule:state`
  // handler already reconciles on read, but this gives the renderer an
  // explicit refresh path that also broadcasts so all views update.
  ipcMain.handle('schedule:rescan', async () => {
    await mutate(async (state) => {
      await reconcile(state);
      return null;
    });
    await broadcast();
    return { ok: true };
  });

  // Archive every non-running PRD and drop its entry from queue.json.
  // Running entries are kept (would orphan an in-flight job). PRD files are
  // moved (not deleted) to prds-archived/<ISO>/ so the user can recover them.
  // Path containment is enforced — only files inside PRDS_DIR are moved.
  ipcMain.handle('schedule:clear-queue', async () => {
    ensureDirs();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = path.join(PRDS_ARCHIVE_DIR, ts);
    const state = await readQueue();
    const victims = state.jobs.filter((j) => j.status !== 'running');
    if (victims.length === 0) {
      return { ok: true, archived: 0, archivedTo: null };
    }
    await fsp.mkdir(archiveDir, { recursive: true });
    let archived = 0;
    for (const job of victims) {
      const src = path.resolve(path.join(PRDS_DIR, `${job.slug}.md`));
      if (!src.startsWith(PRDS_DIR + path.sep)) continue;
      const dst = path.join(archiveDir, `${job.slug}.md`);
      try {
        await fsp.rename(src, dst);
        archived++;
      } catch (e) {
        // ENOENT: the .md is already gone (reconcile would drop it on next
        // read anyway). Either way, fall through and remove from queue.
        if (e?.code !== 'ENOENT') {
          logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'clear-queue: rename failed', meta: { slug: job.slug, error: e?.message } });
        }
      }
    }
    await mutate(async (s) => {
      const victimSlugs = new Set(victims.map((j) => j.slug));
      s.jobs = s.jobs.filter((j) => !victimSlugs.has(j.slug));
      await reconcile(s);
      return null;
    });
    await broadcast();
    return { ok: true, archived, archivedTo: archiveDir };
  });

  ipcMain.handle('schedule:open-folder', async () => {
    const { shell } = require('electron');
    await shell.openPath(ROOT);
    return { ok: true };
  });

  ipcMain.handle('schedule:read-prd', async (_e, payload) => {
    let slug;
    try {
      ({ slug } = schemas.scheduleSlug.parse(payload));
    } catch {
      return { ok: false, error: 'invalid slug' };
    }
    const filePath = safeSlugPath(slug);
    if (!filePath) return { ok: false, error: 'invalid slug' };
    try {
      const text = await fsp.readFile(filePath, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  });

  ipcMain.handle('schedule:read-log', async (_e, payload) => {
    let slug, runId;
    try {
      ({ slug, runId } = schemas.scheduleReadLog.parse(payload));
    } catch {
      return { ok: false, error: 'invalid slug or runId' };
    }
    // Defense-in-depth: re-check containment after path.resolve even though
    // SLUG_RE / RUN_ID_RE already forbid path separators.
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

  ipcMain.handle('schedule:write-prd', async (_e, payload) => {
    let parsed;
    try { parsed = schemas.scheduleWritePrd.parse(payload); }
    catch (e) { return { ok: false, error: e?.message ?? 'invalid payload' }; }
    const resolved = safeSlugPath(parsed.slug);
    if (!resolved) return { ok: false, error: 'invalid slug' };
    try {
      await config.writeTextAtomic(resolved, parsed.body);
    } catch (e) {
      return { ok: false, error: e?.message ?? 'write failed' };
    }
    try {
      const stat = await fsp.stat(resolved);
      return { ok: true, bytesWritten: stat.size };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'stat failed' };
    }
  });

  ipcMain.handle('schedule:list-prds', async () => {
    ensureDirs();
    let entries;
    try {
      entries = await fsp.readdir(PRDS_DIR);
    } catch (e) {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'list-prds: readdir failed', meta: { error: e?.message } });
      return [];
    }
    const out = [];
    for (const name of entries) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const filePath = path.join(PRDS_DIR, name);
      try {
        const parsed = await parsePrd(filePath);
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
        logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'list-prds: skipping unparseable file', meta: { name, error: e?.message } });
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
  // 'failed', AND kill its detached claude child if still alive. Without the
  // kill step the child keeps running as a zombie writing to the project on
  // its own schedule, which is exactly what happened on 2026-05-21 (PID 78230
  // writing PRD 05's output while the scheduler thought the job was orphaned).
  await mutate((state) => {
    for (const j of state.jobs) {
      if (j.status === 'running') {
        const pid = j.runtime?.pid;
        let killNote = '';
        if (pid) {
          const result = killOrphanClaudePid(pid);
          killNote = ` (orphan pid=${pid}: ${result})`;
          if (result === 'killed') {
            console.log(`[scheduler] boot: SIGTERM'd orphan claude pid=${pid} for ${j.slug}`);
          }
        }
        j.status = 'failed';
        j.error = `orphaned: app restarted while running${killNote}`;
        j.finishedAt = new Date().toISOString();
        delete j.runtime;
      }
    }
  });

  // If we boot up while paused with a resumeAt in the past, clear it. This
  // happens when the app was closed across the reset window.
  const boot = await readQueue();
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

  // Supervisor: probe running jobs for wedged poll-loops. Supervisor calls
  // its injected readQueue() synchronously from supervisorTick and applyAction,
  // so pass the sync variant; the 15-min probe cadence makes the blocking cost
  // negligible vs IPC handler latency.
  if (process.env.SM_SUPERVISOR_DISABLE !== '1') {
    supervisor.startSupervisor({ readQueue: readQueueSync });
  }

  // Heartbeat: once per minute, log queue state for 24h visibility.
  // setInterval callback is sync; readQueueSync stays sync to avoid awaiting
  // inside the timer body (and the 60s cadence makes the cost moot).
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    const s = readQueueSync();
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
      // Clear any paused-but-resumeAt-elapsed state immediately. Sync read:
      // the powerMonitor 'resume' callback fires rarely and isn't on the IPC
      // hot path; switching to async would require an IIFE wrapper for no gain.
      const wakeState = readQueueSync();
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
