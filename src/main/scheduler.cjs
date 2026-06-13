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
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { ipcMain } = require('electron');
const billing = require('./usage.cjs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const supervisor = require('./supervisor.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { readTail } = require('./lib/fileTail.cjs');
const { claudePidAlive, classifyRunOutcome } = require('./lib/reaperHelpers.cjs');
const { openLog, withChildAndLog } = require('./lib/childWithLog.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const prdParser = require('./scheduler/prdParser.cjs');
const { verifyRun } = require('./runVerify.cjs');
const logs = require('./logs.cjs');
const { schemas, validated } = require('./ipcSchemas.cjs');
const {
  POLL_INTERVAL_MS,
  USAGE_REFRESH_INTERVAL_MS,
  MAX_JOB_DURATION_MS,
} = require('./lib/schedulerConfig.cjs');
const { pickForProject, pickNextBatch, DEFAULT_PROJECT_CWD } = require('./lib/schedulerBatch.cjs');

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

// Appended to every scheduled job prompt so the queue can be RELIED ON to finish
// work to a consistent bar: review → security-review → verify → commit. Enforced
// centrally here (not per-PRD) so it applies to every current and future PRD.
// The commit step is also backstopped by the post-run commit guard below: a
// clean exit that leaves uncommitted changes is downgraded to needs_review.
const FINISH_PROTOCOL = `

---
# SCHEDULER FINISH PROTOCOL (mandatory — runs AFTER the work above)

Once every acceptance-criteria line above is satisfied, finish in this EXACT
sequence. Do not stop before the commit lands; committing is part of the job.

1. CODE REVIEW — run \`/code-review --fix\` on your changes and apply the fixes it
   surfaces (correctness first). For any finding you judge a false positive, say
   why in your result; do not silently skip it. If \`/code-review\` is not
   available in this environment, do an equivalent careful self-review instead.
2. SECURITY REVIEW — run \`/security-review\` and address every finding (or
   justify it). If unavailable, self-review the diff for injection, secrets,
   path traversal, and unsafe input handling.
3. VERIFY — run the project's OWN check commands (typecheck / lint / tests — the
   project's CLAUDE.md names them; infer from the repo if not) and make them
   pass. Do not assume npm; use whatever the target project uses.
4. COMMIT — stage and commit ALL changes with a clear conventional message:
   \`git add -A && git commit -m "<type>(<scope>): <summary>"\`.

A job that exits with uncommitted changes is treated as INCOMPLETE and flagged
for review. Do NOT add work beyond the acceptance criteria — this protocol is the
only post-AC work. If a review finding can't be fixed within scope, commit what
you have, describe the finding in the commit body, and note the follow-up in your
final result.`;

// Parse \`git status --porcelain\` output into a list of changed paths. Pure +
// exported for unit testing. Each porcelain line is "XY<space>PATH" (2 status
// chars + space), so the path starts at index 3; rename lines ("R  a -> b")
// keep the "a -> b" tail, which is fine for a human-facing dirty-file list.
function parsePorcelain(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3))
    .filter(Boolean);
}

// Return the list of uncommitted paths in cwd, or null when the guard does not
// apply (cwd is not a git work tree, git is missing, or the call errors). Never
// throws — a guard failure must not fail an otherwise-successful job.
function uncommittedChanges(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(null); return; }
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; } // not a repo / git missing → skip
        resolve(parsePorcelain(stdout));
      },
    );
  });
}

// Return the current HEAD commit sha in cwd, or null on any error. Used by the
// commit-guard to detect whether the job self-committed during its run (HEAD
// moved) — in which case leftover working-tree dirt is presumptively from a
// concurrent external writer, not the job's unsaved deliverable. Never throws.
function gitHead(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(null); return; }
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', 'HEAD'],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => { resolve(err ? null : String(stdout || '').trim() || null); },
    );
  });
}

const ROOT = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans');
const PRDS_DIR = path.join(ROOT, 'prds');
const RUNS_DIR = path.join(ROOT, 'runs');
const PRDS_ARCHIVE_DIR = path.join(ROOT, 'prds-archived');
const QUEUE_PATH = path.join(ROOT, 'queue.json');
const SCHEDULER_STATE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-state.json');
const HEARTBEAT_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log');
const HEARTBEAT_MAX_BYTES = 1024 * 1024;
// DEFAULT_PROJECT_CWD imported from lib/schedulerBatch.cjs (single source of truth).

const ENV_CAP = process.env.SM_SCHEDULER_MAX_CONCURRENCY
  ? Math.max(1, Math.min(20, parseInt(process.env.SM_SCHEDULER_MAX_CONCURRENCY, 10) || 3))
  : null;

// Each headless claude -p process can grow past 1 GB; require 1.5 GB headroom
// per running+pending slot to avoid OOM (incident 2026-06-10).
const MIN_FREE_MB_PER_JOB = 1500;

const DEFAULT_CONFIG = {
  offsetMinutes: 15,
  concurrencyCap: ENV_CAP ?? 3,
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

// ---------- memory gate ----------

/**
 * Returns available system memory in MB.  Reads /proc/meminfo on Linux; fails
 * open (returns Infinity) on darwin or on any parse/read error so the gate
 * never blocks scheduling on unsupported platforms.
 */
function getAvailableMemMb() {
  if (process.platform !== 'linux') return Infinity;
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!m) return Infinity;
    return Math.floor(parseInt(m[1], 10) / 1024);
  } catch {
    return Infinity;
  }
}

/**
 * Pure helper: clamp a batch down so launching `toLaunch` more jobs doesn't
 * drop available memory below MIN_FREE_MB_PER_JOB per active slot.
 * Exported for unit tests.
 */
function memoryLimitedBatchSize(availableMb, minPerJob, runningCount, batchLen) {
  if (availableMb === Infinity) return batchLen;
  let allowed = batchLen;
  while (allowed > 0 && availableMb < minPerJob * (runningCount + allowed)) {
    allowed--;
  }
  return allowed;
}

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
    config.writeJsonSync(SCHEDULER_STATE_PATH, {
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
  await config.writeJson(QUEUE_PATH, state);
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
// Last memory-gate observation; included in snapshot for renderer visibility.
let lastMemGate = null;

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
    pollHealth: {
      lastPollAt,
      lastPollOk,
      consecutiveFailures,
      lastFailureKind,
    },
    memGate: lastMemGate,
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
  delete job.verifierVerdict;
}

/** Scan the tail of a job's log for the canonical rate-limit signal. We look
 *  at the last 16 KB — final result event always lands at the end.
 *  Uses readTail() so no raw fd lifecycle is needed here. */
function detectRateLimitInLog(logPath) {
  try {
    const text = readTail(logPath, 16384);
    if (!text) return false;
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
 *
 * Uses withChildAndLog for the child lifecycle (fd open/close, watchdog timers).
 * Watchdogs are declared as an array; the result-tailer's exit-code mapping
 * (success+killedBySignal → 0) is scheduler-specific and lives in onExit.
 */
async function executeJob(job, runDir, defaultCwd, onPid) {
  const logPath = path.join(runDir, `${job.slug}.log`);
  const metaPath = path.join(runDir, `${job.slug}.meta.json`);
  const cwd = job.cwd || defaultCwd;
  const startedAt = Date.now();
  const sessionId = randomUUID();

  // Phase 1: open log fd so we can emit pre-spawn diagnostics (early-exit
  // error paths) before the child is created. withChildAndLog takes ownership
  // of fd/safeLog/closeFd from the point it is called.
  const { fd, safeLog, closeFd } = openLog(logPath);

  safeLog(`[scheduler] starting ${job.slug} at ${new Date().toISOString()}\n[scheduler] cwd=${cwd}\n\n`);

  // Dead-cwd guard: verify the target directory exists and is traversable
  // before handing it to the child process.
  try { fs.accessSync(cwd, fs.constants.X_OK); }
  catch {
    const errMsg = `cwd does not exist on this machine: ${cwd}`;
    safeLog(`[scheduler] ${errMsg}\n`);
    closeFd();
    // Sync write: this is an early-exit error path inside an async function,
    // so we could await, but using the sync variant keeps the error path
    // ordering identical to the spawn-failed branch below (also sync).
    config.writeJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs: 0 });
    return { exitCode: -1, durationMs: 0, error: errMsg, sessionId };
  }

  // Read full PRD body fresh from disk (queue stored only the preview).
  let prompt;
  const prdPath = path.join(PRDS_DIR, `${job.slug}.md`);
  try {
    const parsed = await parsePrd(prdPath);
    // Centrally enforce the review → security-review → verify → commit finish
    // sequence on every job, regardless of what the PRD body says.
    prompt = parsed.body + FINISH_PROTOCOL;
  } catch (e) {
    safeLog(`[scheduler] failed to read PRD: ${e?.message}\n`);
    closeFd();
    return { exitCode: -1, durationMs: 0, error: e?.message };
  }

  const promptCheck = validatePromptForSpawn(prompt, prdPath);
  if (!promptCheck.ok) {
    safeLog(`[scheduler] ${promptCheck.error}\n`);
    closeFd();
    config.writeJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: promptCheck.error, startedAt, finishedAt: Date.now(), durationMs: 0 });
    return { exitCode: -1, durationMs: 0, error: promptCheck.error, sessionId };
  }

  return await new Promise((resolve) => {
    const claudeBin = resolveClaudeBin();
    // Strip Claude Code env and secrets that leak in when session-manager is
    // launched from a `claude` shell. CLAUDE_EFFORT=xhigh forces Opus and
    // overrides `--model sonnet`, so scheduled jobs burn Opus credits silently.
    const childEnv = cleanChildEnv();

    // Track whether the agent has emitted a `result` event in its JSONL stream.
    // null until seen; then one of "success" | "error_max_turns" | … per the
    // claude harness's result subtype taxonomy.
    // Declared here (outer scope) so the onExit handler can reference it for
    // the success+killedBySignal → exitCode:0 mapping.
    let agentResultSubtype = null;

    // ---------- watchdog declarations ----------
    //
    // All three use fire-once-on-condition semantics (auto-clear on first fire).
    // Secondary timers created inside action() are registered via ctx.addTimer()
    // so they are cleared on child exit even if fired after the primary watchdog.

    // Result-tailer: scan the log tail for a {"type":"result"} event. On
    // detection, start a grace timer — the agent declared done, so it should
    // exit promptly. If it doesn't, SIGTERM the process group (the
    // cellar-publish failure mode: unbounded background bashes kept the parent
    // alive 22 min after the agent emitted result=success).
    // Note: killedByWatchdog is set inside the cascade timer, NOT when the
    // result is first detected, so a clean exit during the grace period leaves
    // killedByWatchdog null (not misattributed to this watchdog).
    const resultTailWatchdog = {
      label: 'result-tail',
      intervalMs: RESULT_TAIL_POLL_MS,
      shouldFire(ctx) {
        try {
          const tail = readTail(ctx.logPath, RESULT_TAIL_BYTES);
          if (!tail) return false;
          const m = tail.match(/\{"type":"result","subtype":"([a-z_]+)"/);
          if (!m) return false;
          agentResultSubtype = m[1];
          return true;
        } catch { return false; }
      },
      action(ctx) {
        ctx.safeLog(`\n[scheduler] result event detected (subtype=${agentResultSubtype}); ` +
          `starting ${Math.round(POST_RESULT_GRACE_MS/1000)}s exit-grace timer\n`);
        const postResultTimer = setTimeout(() => {
          ctx.safeLog(`\n[scheduler] post-result grace expired (${Math.round(POST_RESULT_GRACE_MS/1000)}s); ` +
            `child still alive — SIGTERM process group\n`);
          ctx.killedByWatchdog = 'result-tail';
          ctx.killTree('SIGTERM');
          const postResultKillTimer = setTimeout(() => {
            ctx.safeLog(`\n[scheduler] still alive ${Math.round(POST_RESULT_KILL_MS/1000)}s after SIGTERM — SIGKILL\n`);
            ctx.killTree('SIGKILL');
          }, POST_RESULT_KILL_MS);
          if (postResultKillTimer.unref) postResultKillTimer.unref();
          ctx.addTimer(postResultKillTimer);
        }, POST_RESULT_GRACE_MS);
        if (postResultTimer.unref) postResultTimer.unref();
        ctx.addTimer(postResultTimer);
      },
    };

    // Deadman: kill the child unconditionally after MAX_JOB_DURATION_MS.
    // shouldFire: () => true means the interval fires once at intervalMs then
    // auto-clears (fire-once-on-condition with a condition that's always true).
    const deadmanWatchdog = {
      label: 'deadman',
      intervalMs: MAX_JOB_DURATION_MS,
      shouldFire: () => true,
      action(ctx) {
        ctx.safeLog(`\n[scheduler] watchdog SIGKILL after ${MAX_JOB_DURATION_MS}ms\n`);
        ctx.killedByWatchdog = 'deadman';
        ctx.killTree('SIGKILL');
      },
    };

    // Idle-output watchdog: if log mtime stalls for IDLE_OUTPUT_KILL_MS the
    // agent is presumed stuck (network stall, infinite tool loop, compaction
    // wedge). SIGTERM the group, SIGKILL after POST_RESULT_KILL_MS.
    const idleTailWatchdog = {
      label: 'idle-tail',
      intervalMs: IDLE_CHECK_INTERVAL_MS,
      shouldFire(ctx) {
        try {
          const stat = fs.statSync(ctx.logPath);
          return Date.now() - stat.mtimeMs > IDLE_OUTPUT_KILL_MS;
        } catch { return false; }
      },
      action(ctx) {
        let idleMs = 0;
        try { idleMs = Date.now() - fs.statSync(ctx.logPath).mtimeMs; } catch { /* */ }
        ctx.safeLog(`\n[scheduler] idle-output watchdog: log mtime stalled ` +
          `${Math.round(idleMs/1000)}s (> ${Math.round(IDLE_OUTPUT_KILL_MS/1000)}s threshold) — SIGTERM process group\n`);
        ctx.killedByWatchdog = 'idle-tail';
        ctx.killTree('SIGTERM');
        const idleKillTimer = setTimeout(() => {
          ctx.safeLog(`\n[scheduler] idle watchdog: still alive ${Math.round(POST_RESULT_KILL_MS/1000)}s after SIGTERM — SIGKILL\n`);
          ctx.killTree('SIGKILL');
        }, POST_RESULT_KILL_MS);
        if (idleKillTimer.unref) idleKillTimer.unref();
        ctx.addTimer(idleKillTimer);
      },
    };

    // ---------- spawn ----------

    const { child } = withChildAndLog({
      fd,
      logPath,
      safeLog,
      closeFd,
      spawn: {
        command: claudeBin,
        args: [
          '-p', prompt,
          '--model', 'sonnet',
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          '--session-id', sessionId,
        ],
        options: {
          cwd,
          env: childEnv,
          // detached:true puts the child in its own process group so we can kill
          // the entire descendant tree (including any stray background bashes the
          // agent spawned) with `process.kill(-pid)`. Without this, child.kill()
          // only kills the immediate `claude` process, leaving orphaned subprocs
          // that keep the parent alive (the 2026-05-10 cellar-publish hang).
          detached: true,
        },
      },
      watchdogs: [resultTailWatchdog, deadmanWatchdog, idleTailWatchdog],
      onExit({ exitCode, signal, killedByWatchdog: _kbw, error, spawnFailed, safeLog: sl }) {
        const durationMs = Date.now() - startedAt;

        if (error) {
          // Covers both synchronous spawn failure and child 'error' events.
          const errMsg = spawnFailed
            ? `spawn failed: ${error?.message ?? String(error)}`
            : error.message;
          sl(`\n[scheduler] ${errMsg}\n`);
          // Sync write: inside a Promise executor callback; must flush meta
          // before resolve() so the spawnJob mutate() that follows sees it.
          config.writeJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs });
          resolve({ exitCode: -1, durationMs, error: errMsg, sessionId });
          return;
        }

        // If we killed the child (via any watchdog or externally) AND the agent
        // had already emitted result=success, the work succeeded; only the
        // cleanup hung. Map the kill exit code to 0 so the job is marked
        // completed, not failed.
        // Node's child.on('exit') reports either code (normal) or signal (killed);
        // when killed by signal, code is null. We also check 143 (128+SIGTERM)
        // and 137 (128+SIGKILL) in case the process exited via signal-as-code.
        let effectiveCode = exitCode;
        const killedBySignal = signal === 'SIGTERM' || signal === 'SIGKILL' || exitCode === 143 || exitCode === 137 || exitCode === null;
        const mappedToSuccess = agentResultSubtype === 'success' && killedBySignal;
        if (mappedToSuccess) {
          effectiveCode = 0;
          sl(`\n[scheduler] mapping exit code=${exitCode} signal=${signal} → 0 ` +
            `(result=success was emitted before kill)\n`);
        }
        sl(`\n[scheduler] exit code=${effectiveCode} (raw code=${exitCode} signal=${signal}) ` +
          `duration=${Math.round(durationMs / 1000)}s\n`);
        const rateLimited = effectiveCode !== 0 && detectRateLimitInLog(logPath);
        // Sync write: child 'exit' handler must flush meta before resolve()
        // so the spawnJob mutate() that follows sees the persisted exit code.
        config.writeJsonSync(metaPath, {
          slug: job.slug, cwd, sessionId, exitCode: effectiveCode, rateLimited,
          startedAt, finishedAt: Date.now(), durationMs,
          agentResultSubtype, mappedFromSignal: mappedToSuccess ? signal || `code=${exitCode}` : null,
        });
        resolve({ exitCode: effectiveCode, durationMs, rateLimited, sessionId });
      },
    });

    if (child) {
      safeLog(`[scheduler] spawned pid=${child.pid} sessionId=${sessionId} (process group)\n\n`);
      // Fire-and-forget pid persistence — best effort.
      if (onPid) onPid(child.pid, sessionId, cwd).catch(() => {});
    }
  });
}

// pickNextBatch and pickForProject are defined in lib/schedulerBatch.cjs and
// required at the top of this file. Group-ordering gates are evaluated per
// project (keyed by cwd) so jobs in different repos run concurrently up to
// the cap; within one project, sequential-group semantics are preserved.

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

  // Phase 1: open log fd for pre-spawn diagnostics.
  const { fd, safeLog, closeFd } = openLog(investigationLogPath);
  const sessionId = randomUUID();
  safeLog(`[scheduler] investigation starting for ${failedJob.slug} at ${new Date().toISOString()}\n[scheduler] target fix PRD: ${fixPath}\n[scheduler] sessionId=${sessionId}\n\n`);

  const investigationPromptCheck = validatePromptForSpawn(prompt, `<investigation prompt for ${failedJob.slug}>`);
  if (!investigationPromptCheck.ok) {
    safeLog(`\n[scheduler] ${investigationPromptCheck.error}\n`);
    closeFd();
    return;
  }

  const claudeBin = resolveClaudeBin();
  const childEnv = cleanChildEnv();

  // Investigation needs only a deadman watchdog — no idle-tail or result-tail
  // since investigations are short-running Opus probes with a hard ceiling.
  const deadmanWatchdog = {
    label: 'deadman',
    intervalMs: MAX_INVESTIGATION_DURATION_MS,
    shouldFire: () => true,
    action(ctx) {
      ctx.safeLog(`\n[scheduler] investigation watchdog SIGKILL after ${MAX_INVESTIGATION_DURATION_MS}ms\n`);
      ctx.killedByWatchdog = 'deadman';
      ctx.killTree('SIGKILL');
    },
  };

  // Phase 2: spawn with lifecycle managed by withChildAndLog.
  const { child } = withChildAndLog({
    fd,
    logPath: investigationLogPath,
    safeLog,
    closeFd,
    spawn: {
      command: claudeBin,
      args: [
        '-p', prompt,
        '--model', 'opus',
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
        '--session-id', sessionId,
      ],
      options: { cwd, env: childEnv },
    },
    watchdogs: [deadmanWatchdog],
    onExit({ exitCode, error, spawnFailed, safeLog: sl }) {
      if (error) {
        const errMsg = spawnFailed
          ? `investigation spawn failed: ${error?.message ?? String(error)}`
          : `investigation error: ${error.message}`;
        sl(`\n[scheduler] ${errMsg}\n`);
        return;
      }
      sl(`\n[scheduler] investigation exit code=${exitCode}\n`);
      if (fs.existsSync(fixPath)) {
        console.log(`[scheduler] investigation produced fix plan: ${fixSlug}`);
      } else {
        console.log(`[scheduler] investigation finished WITHOUT producing fix plan (slug=${failedJob.slug}, code=${exitCode})`);
      }
      // Trigger a tick so the new fix plan is reconciled into the queue and fired.
      tickQueue().catch(() => {});
    },
  });

  if (child) {
    safeLog(`[scheduler] investigation pid=${child.pid}\n\n`);
  }
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

    // Commit-guard baseline: snapshot the working tree BEFORE the run so the
    // post-run check flags only paths THIS job left dirty, not pre-existing WIP.
    const guardCwd = job.cwd || defaultCwd;
    const guardBaseline = await uncommittedChanges(guardCwd);
    const guardHeadBefore = await gitHead(guardCwd);

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

    // Post-run verification: for exit=0 runs, scan the transcript and check
    // dependency prerequisites before stamping 'completed'. This catches the
    // false-positive class where an agent exits cleanly while leaving failures
    // in its tool output (see incidents: PRD 39, 44, 56 on 2026-05-23→24).
    // Called outside mutate() so the queue lock is not held during I/O.
    let verifyResult = null;
    if (res.exitCode === 0 && !res.rateLimited) {
      const prdPath = path.join(PRDS_DIR, `${job.slug}.md`);
      const stateForDeps = await readQueue();
      verifyResult = await verifyRun({
        runDir,
        prdPath,
        queueEntry: job,
        allJobs: stateForDeps.jobs,
      }).catch((e) => ({
        verdict: 'verify_unavailable',
        reason: `verifier threw: ${e?.message ?? String(e)}`,
        downgradeTo: 'needs_review',
      }));
      if (verifyResult.verdict !== 'clean') {
        console.log(
          `[scheduler] verifier: ${job.slug} verdict=${verifyResult.verdict}` +
          ` → ${verifyResult.downgradeTo ?? 'completed'}: ${verifyResult.reason}`,
        );
      }
    }

    // Commit guard: a clean exit that left NEW uncommitted changes means the
    // finish protocol's COMMIT step did not run. Surface it as needs_review
    // instead of letting it masquerade as 'completed' (the PRD 03/04
    // left-uncommitted incident). Two false-positive defenses:
    //   - baseline DELTA: only files dirtied during THIS run count, so
    //     pre-existing user WIP is excluded; and
    //   - sibling skip: if another job is concurrently writing the same repo,
    //     working-tree dirt can't be attributed to this job, so skip the guard.
    //   - self-commit skip: if HEAD moved during the run, the job committed its
    //     deliverable; leftover dirt is presumptively a concurrent external edit
    //     (e.g. an interactive session editing the same repo), not the job's
    //     unsaved work — so skip rather than false-flag a completed job.
    // Non-git cwds resolve to null and are skipped (the guard is best-effort).
    //
    // Runs even when a transcript-pattern verdict already fired: the commit-guard
    // is a MATERIALLY-CHECKABLE signal (real git state) and outranks pattern hits.
    // Skipped only when the job is about to re-fire (HALT / deps_unmet → pending),
    // where working-tree state is irrelevant. When both fire, the uncommitted
    // verdict owns the needs_review reason and the pattern hit is demoted to an
    // annotation, so a real "finish protocol incomplete" is distinguishable from
    // transcript noise in the queue (feedback 2026-06-10 addendum).
    const guardWillRefire = verifyResult && verifyResult.downgradeTo === 'pending';
    if (res.exitCode === 0 && !res.rateLimited && !guardWillRefire) {
      const after = await uncommittedChanges(guardCwd);
      if (after && after.length > 0) {
        const baseSet = new Set(guardBaseline || []);
        const newlyDirty = after.filter((p) => !baseSet.has(p));
        const guardState = await readQueue().catch(() => ({ jobs: [] }));
        const siblingRunning = (guardState.jobs || []).some(
          (j) => j.slug !== job.slug && j.status === 'running' && (j.cwd || defaultCwd) === guardCwd,
        );
        const guardHeadAfter = await gitHead(guardCwd);
        const jobSelfCommitted = guardHeadBefore && guardHeadAfter && guardHeadAfter !== guardHeadBefore;
        if (newlyDirty.length > 0 && !siblingRunning && !jobSelfCommitted) {
          const sample = newlyDirty.slice(0, 3).join(', ');
          // Carry any prior transcript verdict + its annotations forward as notes.
          const carried = [...(verifyResult?.annotations ?? [])];
          if (verifyResult && verifyResult.verdict !== 'clean') {
            carried.push({ verdict: verifyResult.verdict, reason: verifyResult.reason });
          }
          verifyResult = {
            verdict: 'uncommitted_changes',
            reason: `finish protocol incomplete: ${newlyDirty.length} uncommitted file(s) left in working tree (e.g. ${sample})`,
            downgradeTo: 'needs_review',
            annotations: carried.length ? carried : undefined,
          };
          console.log(`[scheduler] commit-guard: ${job.slug} left ${newlyDirty.length} files uncommitted → needs_review`);
        }
      }
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
          // Determine effective status, applying the verifier verdict for exit=0 runs.
          let effectiveStatus;
          if (res.exitCode !== 0) {
            effectiveStatus = 'failed';
          } else if (!verifyResult || verifyResult.verdict === 'clean') {
            effectiveStatus = 'completed';
          } else if (verifyResult.downgradeTo === 'pending') {
            // HALT or deps_unmet: reset to pending so the job re-fires.
            resetJobFields(s.jobs[i2], verifyResult.reason);
            return; // job already mutated by resetJobFields; skip the rest
          } else {
            // transcript_errors or verify_unavailable: escalate to needs_review.
            effectiveStatus = 'needs_review';
          }

          s.jobs[i2].status = effectiveStatus;
          s.jobs[i2].finishedAt = new Date().toISOString();
          s.jobs[i2].exitCode = res.exitCode;
          s.jobs[i2].error = effectiveStatus === 'needs_review'
            ? (verifyResult?.reason ?? null)
            : (res.error || null);
          // Persist the verifier's verdict string so the renderer can show it.
          if (verifyResult?.verdict && verifyResult.verdict !== 'clean') {
            s.jobs[i2].verifierVerdict = verifyResult.verdict;
          } else {
            delete s.jobs[i2].verifierVerdict;
          }
          // Non-blocking notes (e.g. a recovered missing-dependency probe, or a
          // pattern hit demoted because a materially-checkable verdict outranked
          // it) — surfaced even on completed jobs so the signal isn't lost.
          if (verifyResult?.annotations && verifyResult.annotations.length) {
            s.jobs[i2].verifierAnnotations = verifyResult.annotations.map(
              (a) => `${a.verdict}: ${a.reason}`,
            );
          } else {
            delete s.jobs[i2].verifierAnnotations;
          }
          delete s.jobs[i2].runtime;

          if (effectiveStatus === 'failed') {
            actuallyFailed = true;
            failedJobSnapshot = { ...s.jobs[i2] };
          }
          // Auto-promote: when a fix-* PRD completes successfully, the original
          // failed PRD's work is logically done. Flip its status to 'completed'
          // so the cross-group failure gate in pickNextBatch releases. Without
          // this, the queue stalls indefinitely behind a stale failure even
          // though the auto-recovery did its job.
          if (effectiveStatus === 'completed' && isFixPlanSlug(job.slug)) {
            const originalSlug = job.slug.replace(/^(\d+)-fix-/, '$1-');
            const orig = s.jobs.findIndex((x) => x.slug === originalSlug && x.status === 'failed');
            if (orig >= 0) {
              console.log(`[scheduler] auto-promote: ${originalSlug} (failed) → completed because ${job.slug} succeeded`);
              s.jobs[orig].status = 'completed';
              s.jobs[orig].exitCode = 0;
              s.jobs[orig].error = null;
              s.jobs[orig].completedBy = job.slug;
            }
          }
        }
      }
    });
    await broadcast();

    if (actuallyFailed && failedJobSnapshot) {
      // Transient-failure detector: SIGTERM/SIGKILL within 45s = almost
      // always external kill (user-initiated app restart, OOM-kill, manual
      // process kill, Electron HMR). The PRD itself didn't fail; the run was
      // interrupted before it could do meaningful work. Spawning an Opus
      // investigator on these is wasted tokens AND pollutes the queue with
      // redundant fix-PRDs (real example 2026-05-21: 07-agent-view-... got
      // SIGTERMed at 10s by an app restart, the rename had already been done
      // anyway). The 45s cutoff (was 30s) catches Electron-HMR borderline
      // cases like PRD 26 SIGTERM'd at 33s — that was 3s over the old cutoff
      // and fell through to a fix-PRD that just acknowledged the work was
      // already done. Auto-retry up to 2x before falling through to investigation.
      const ec = failedJobSnapshot.exitCode;
      const transient = (ec === 143 || ec === 137) && res.durationMs < 45_000;
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

    const availableMb = getAvailableMemMb();
    const allowed = memoryLimitedBatchSize(availableMb, MIN_FREE_MB_PER_JOB, runningSet.size, batch.length);
    if (allowed === 0) {
      const threshold = MIN_FREE_MB_PER_JOB * (runningSet.size + 1);
      console.log(`[scheduler] memory gate: available=${availableMb} MB < threshold=${threshold} MB — deferring ${batch.length} job(s)`);
      lastMemGate = { availableMb, threshold, deferred: true, at: new Date().toISOString() };
      return;
    }
    const gatedBatch = batch.slice(0, allowed);
    if (gatedBatch.length < batch.length) {
      console.log(`[scheduler] memory gate: available=${availableMb} MB — clamped batch ${batch.length} → ${gatedBatch.length}`);
      lastMemGate = { availableMb, threshold: MIN_FREE_MB_PER_JOB * (runningSet.size + gatedBatch.length), deferred: false, clamped: true, at: new Date().toISOString() };
    } else {
      // Ungated full batch: clear stale gate snapshot so status doesn't show
      // a stale deferral from a previous tick.
      lastMemGate = null;
    }

    await mutate((s) => { s.lastRunAt = new Date().toISOString(); });
    await broadcast();

    const { runId, dir: runDir } = pickRunDir();
    for (const job of gatedBatch) {
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

// ---------- dead-process reaper ----------

/**
 * Scan running jobs, identify those whose claude process is provably dead, and
 * finalize them to completed/failed by reading the run log. Called once per
 * poll cycle. Conservative: a job with no runtime.pid yet (spawn mid-flight)
 * is always skipped. A job whose pid is alive (claudePidAlive) is always skipped.
 * Exported so unit tests can invoke it directly.
 */
async function reapDeadRunningJobs() {
  try {
    if (runningSet.size === 0) return; // fast path: no in-flight jobs
    const state = await readQueue();
    const dead = [];
    for (const j of state.jobs) {
      if (j.status !== 'running') continue;
      const pid = j.runtime?.pid;
      if (!pid) continue; // spawn may be mid-flight; give it a cycle
      if (claudePidAlive(pid)) continue;
      const logPath = j.runId
        ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`)
        : null;
      const outcome = logPath ? classifyRunOutcome(logPath) : 'unknown';
      dead.push({ slug: j.slug, pid, outcome });
    }
    if (dead.length === 0) return;

    await mutate((s) => {
      for (const { slug, pid, outcome } of dead) {
        const idx = s.jobs.findIndex((x) => x.slug === slug);
        if (idx < 0 || s.jobs[idx].status !== 'running') continue; // race guard
        const success = outcome === 'success';
        s.jobs[idx].status = success ? 'completed' : 'failed';
        s.jobs[idx].exitCode = success ? 0 : (s.jobs[idx].exitCode ?? 1);
        s.jobs[idx].finishedAt = new Date().toISOString();
        s.jobs[idx].error = success ? null : `reaped: process gone, no success result in log (${outcome})`;
        delete s.jobs[idx].runtime;
        runningSet.delete(slug);
        console.log(`[scheduler] reaped dead job slug=${slug} pid=${pid} outcome=${outcome}`);
      }
    });

    await broadcast();
    tickQueue().catch(() => {});
  } catch (e) {
    console.warn('[scheduler] reapDeadRunningJobs error', e?.message);
  }
}

// ---------- poll loop with exponential backoff ----------

/**
 * Pure: given the current pause reason and whether a reset timestamp is cached,
 * return which clearPause source to pass after a successful billing poll, or null.
 * Exported for unit testing.
 */
function pollRecoveryClearSource(pauseReason, hasCachedReset) {
  if (pauseReason === 'network') return 'network-recovered';
  if (pauseReason === 'auth') return 'auth-recovered';
  if (pauseReason === 'reset_failure' && hasCachedReset) return 'reset-recovered';
  return null;
}

async function pollLoop() {
  try {
    await reapDeadRunningJobs().catch(() => {});
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

      // Clear any pause that was waiting for a successful billing read.
      const cur = await readQueue();
      const clearSrc = pollRecoveryClearSource(cur.paused?.reason ?? null, !!cachedNextReset);
      if (clearSrc) await clearPause(clearSrc);

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

// Pure helper: filter to completed/failed, sort newest-finished first, cap to
// limit clamped to [1, 500] (default 50). O(n log n) on queue size (small).
// Exported for unit testing.
function selectHistoryJobs(jobs, limit) {
  const cap = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 50));
  return (Array.isArray(jobs) ? jobs : [])
    .filter((j) => j && (j.status === 'completed' || j.status === 'failed'))
    .sort((a, b) => {
      const at = a.finishedAt ? Date.parse(a.finishedAt) : 0;
      const bt = b.finishedAt ? Date.parse(b.finishedAt) : 0;
      return bt - at;
    })
    .slice(0, cap);
}

// Transcript-scan verdicts that re-running verifyRun can re-evaluate. NOT
// 'uncommitted_changes' — that comes from the git commit-guard, which verifyRun
// does not inspect, so re-scanning it would always return 'clean' and wrongly
// heal a genuinely-unfinished job.
const RESCANNABLE_VERDICTS = new Set(['transcript_errors', 'verify_unavailable']);

/**
 * Pure predicate: is this job eligible for the boot re-verify self-heal? Only
 * needs_review jobs with a run log AND a transcript-scan verdict. Crucially
 * EXCLUDES 'uncommitted_changes' (git commit-guard) — verifyRun can't see git,
 * so re-scanning it would falsely heal an unfinished job. Exported for tests.
 */
function isRescanCandidate(job) {
  return !!job
    && job.status === 'needs_review'
    && !!job.runId
    && RESCANNABLE_VERDICTS.has(job.verifierVerdict);
}

/**
 * Self-healing pass over needs_review jobs. The verifier runs in-process, so a
 * fix to runVerify.cjs only takes effect for jobs verified AFTER an app
 * restart — jobs flagged by the old (buggy) verifier stay stuck in needs_review
 * forever. On boot we re-run the CURRENT verifier over every transcript-scan
 * needs_review job and auto-complete the ones that now pass clean, so verifier
 * improvements retroactively clear their own false positives (2026-06-10:
 * anchored ImportError detectors + harness-tool-error exemption healed 8 jobs).
 *
 * @returns {Promise<{rescanned:number, healed:string[]}>}
 */
async function reverifyNeedsReview() {
  const snap = await readQueue();
  const candidates = snap.jobs.filter(isRescanCandidate);
  const healed = [];
  for (const job of candidates) {
    const runDir = path.join(RUNS_DIR, job.runId);
    const prdPath = path.join(PRDS_DIR, `${job.slug}.md`);
    let v = null;
    try {
      v = await verifyRun({ runDir, prdPath, queueEntry: job, allJobs: snap.jobs });
    } catch { continue; } // unreadable log etc. — leave for human review
    if (v && v.verdict === 'clean') healed.push(job.slug);
  }
  if (healed.length) {
    const healSet = new Set(healed);
    await mutate((s) => {
      for (const j of s.jobs) {
        if (j.status === 'needs_review' && healSet.has(j.slug)) {
          j.status = 'completed';
          j.error = null;
          delete j.verifierVerdict;
        }
      }
    });
    console.log(`[scheduler] boot reverify: healed ${healed.length} stale needs_review → completed (${healed.join(', ')})`);
    await broadcast();
  }
  return { rescanned: candidates.length, healed };
}

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

  ipcMain.handle('schedule:reverify-needs-review', async () => {
    // Manual trigger for the boot self-heal pass — re-scan needs_review jobs
    // with the current verifier and auto-complete the ones that now pass clean.
    const result = await reverifyNeedsReview();
    return { ok: true, ...result };
  });

  ipcMain.handle('schedule:force-tick', async () => {
    // Bypass the billing-poll gate entirely — fire pending jobs immediately regardless of meter state.
    // Clears any existing pause first (same semantics as run-now).
    await clearPause('run-now');
    runDueJobs().catch((e) => logs.writeLine({ level: 'error', scope: 'scheduler', message: 'runDueJobs error (force-tick)', meta: { error: e?.message } }));
    return { ok: true };
  });

  // .default({}) so callers may omit the payload entirely (same as the old `partial || {}`).
  ipcMain.handle('schedule:set-config', validated(schemas.setConfigSchema.default({}), async (data) => {
    const config = await mutate((state) => {
      const { supervisor: supPartial, ...rest } = data;
      state.config = { ...state.config, ...rest };
      if (supPartial !== undefined) {
        state.config.supervisor = { ...(state.config.supervisor ?? {}), ...supPartial };
      }
      return state.config;
    });
    await rescheduleTimer();
    return { ok: true, config };
  }));

  ipcMain.handle('schedule:reset-job', validated(schemas.scheduleSlug, async ({ slug }) => {
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
  }));

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

  ipcMain.handle('schedule:read-prd', validated(schemas.scheduleSlug, async ({ slug }) => {
    const filePath = safeSlugPath(slug);
    if (!filePath) return { ok: false, error: 'invalid slug' };
    try {
      const text = await fsp.readFile(filePath, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  }));

  ipcMain.handle('schedule:read-log', validated(schemas.scheduleReadLog, async ({ slug, runId }) => {
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
  }));

  ipcMain.handle('schedule:write-prd', validated(schemas.scheduleWritePrd, async (data) => {
    const resolved = safeSlugPath(data.slug);
    if (!resolved) return { ok: false, error: 'invalid slug' };
    try {
      await config.writeTextAtomic(resolved, data.body);
    } catch (e) {
      return { ok: false, error: e?.message ?? 'write failed' };
    }
    try {
      const stat = await fsp.stat(resolved);
      return { ok: true, bytesWritten: stat.size };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'stat failed' };
    }
  }));

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

  // Return last N completed/failed jobs from queue.json, newest first.
  // Purely additive: no schema change, no archive-folder read needed.
  ipcMain.handle('schedule:get-history', async (_e, payload) => {
    const limit = (payload && typeof payload.limit === 'number') ? payload.limit : 50;
    try {
      const state = await readQueue();
      return { ok: true, jobs: selectHistoryJobs(state.jobs, limit) };
    } catch (e) {
      return { ok: false, jobs: [], error: e?.message ?? 'read failed' };
    }
  });
}

async function init() {
  ensureDirs();

  // Hydrate cached state from the sidecar before any scheduling decisions.
  loadSchedulerState();
  bootedAt = Date.now();

  // Boot reconciliation: finalize any job that was 'running' when the app died.
  // Check the run log first — a job that emitted result/success before the crash
  // should be marked 'completed', not 'failed', so it doesn't wedge the queue
  // via the failure-gate. Also kill any still-live orphan claude child to prevent
  // it from continuing to write to the project unsupervised (2026-05-21 incident).
  //
  // classifyRunOutcome calls readTail → fs.readFileSync (up to 64 KB per job).
  // Pre-compute all outcomes BEFORE entering the mutate lock so the blocking I/O
  // does not stall the event loop or hold the mutateTail chain during startup.
  const bootSnap = readQueueSync();
  const bootOutcomes = new Map();
  for (const j of bootSnap.jobs) {
    if (j.status !== 'running') continue;
    const logPath = j.runId ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`) : null;
    bootOutcomes.set(j.slug, logPath ? classifyRunOutcome(logPath) : 'unknown');
  }
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
        const outcome = bootOutcomes.get(j.slug) ?? 'unknown';
        const success = outcome === 'success';
        j.status = success ? 'completed' : 'failed';
        j.exitCode = success ? 0 : (j.exitCode ?? 1);
        j.error = success ? null : `orphaned: app restarted while running${killNote}`;
        j.finishedAt = new Date().toISOString();
        delete j.runtime;
        console.log(`[scheduler] boot reconcile: slug=${j.slug} outcome=${outcome} → ${j.status}`);
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

  // Self-heal stale needs_review flags using the current verifier (see
  // reverifyNeedsReview). Runs once on boot so a shipped verifier fix clears
  // its own historical false positives without manual retagging.
  await reverifyNeedsReview().catch((e) => {
    console.error(`[scheduler] boot reverify failed: ${e?.message ?? e}`);
  });

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

// remote — callable from webRemote.cjs without going through IPC.
const remote = {
  async getState() {
    const state = await readQueue();
    await reconcile(state);
    await writeQueue(state);
    return buildScheduleStatePayload(state, { withPaths: true });
  },

  async readPrd(slug) {
    const filePath = safeSlugPath(slug);
    if (!filePath) return { ok: false, error: 'invalid slug' };
    try {
      // realpath resolves symlinks; re-check boundary to block a rogue agent job
      // that places a symlink inside PRDS_DIR pointing outside the safe root.
      const real = await fsp.realpath(filePath);
      if (!real.startsWith(PRDS_DIR + path.sep)) {
        return { ok: false, error: 'invalid slug' };
      }
      const text = await fsp.readFile(real, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  },

  async readLog(slug, runId) {
    const logPath = path.resolve(path.join(RUNS_DIR, runId, `${slug}.log`));
    if (!logPath.startsWith(RUNS_DIR + path.sep)) {
      return { ok: false, error: 'invalid slug or runId' };
    }
    try {
      // realpath resolves symlinks; re-check boundary to block a rogue agent job
      // that places a symlink inside RUNS_DIR pointing outside the safe root.
      const real = await fsp.realpath(logPath);
      if (!real.startsWith(RUNS_DIR + path.sep)) {
        return { ok: false, error: 'invalid slug or runId' };
      }
      const text = await fsp.readFile(real, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  },

  async writePrd(slug, body) {
    const resolved = safeSlugPath(slug);
    if (!resolved) return { ok: false, error: 'invalid slug' };
    try {
      // Symlink defense, matching readPrd/readLog: safeSlugPath is lexical and
      // does NOT resolve symlinks, so a rogue job could plant prds/x.md → an
      // arbitrary $HOME path and have writeTextAtomic clobber it. Resolve the
      // real parent dir (the file itself may not exist yet) and re-assert
      // containment; also reject the target if it is already a symlink.
      const realParent = await fsp.realpath(path.dirname(resolved));
      if (realParent !== PRDS_DIR && !realParent.startsWith(PRDS_DIR + path.sep)) {
        return { ok: false, error: 'invalid slug' };
      }
      const existing = await fsp.lstat(resolved).catch(() => null);
      if (existing && existing.isSymbolicLink()) {
        return { ok: false, error: 'invalid slug' };
      }
      await config.writeTextAtomic(resolved, body);
      const stat = await fsp.stat(resolved);
      return { ok: true, bytesWritten: stat.size };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'write failed' };
    }
  },

  async resetJob(slug) {
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
  },

  async runNow() {
    await clearPause('run-now');
    runDueJobs().catch((e) => logs.writeLine({
      level: 'error', scope: 'scheduler',
      message: 'runDueJobs error (remote:run-now)', meta: { error: e?.message },
    }));
    return { ok: true };
  },

  async setConfig(partial) {
    const cfg = await mutate((state) => {
      const { supervisor: supPartial, ...rest } = partial;
      state.config = { ...state.config, ...rest };
      if (supPartial !== undefined) {
        state.config.supervisor = { ...(state.config.supervisor ?? {}), ...supPartial };
      }
      return state.config;
    });
    await rescheduleTimer();
    return { ok: true, config: cfg };
  },
};

module.exports = { registerScheduleHandlers, attachWindow, init, ROOT, PRDS_DIR, selectHistoryJobs, parsePorcelain, FINISH_PROTOCOL, remote, pickNextBatch, pickForProject, reapDeadRunningJobs, pollRecoveryClearSource, memoryLimitedBatchSize, reverifyNeedsReview, isRescanCandidate };
