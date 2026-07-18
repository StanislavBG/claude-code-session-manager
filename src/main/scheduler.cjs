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
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const supervisor = require('./supervisor.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { readTail } = require('./lib/fileTail.cjs');
const { claudePidAlive, classifyRunOutcome, ORPHAN_REQUEUE_CAP } = require('./lib/reaperHelpers.cjs');
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
const { runDefinitionOfDoneOnDrain } = require('./lib/dodDrainHook.cjs');

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

// Boot reconciliation: a job left 'running' by an app restart/crash whose log
// shows neither success nor a real failure result was merely interrupted — the
// host died, the PRD didn't. Re-queue it up to this many times before giving up
// and marking it failed, so a restart self-recovers instead of needing a manual
// flip + a wasted fix-plan investigation.
// Cap = 5: covers a self-development cycle that restarts the app up to 6 times
// total (1 original run + 5 requeues). Mirrors the spirit of the transient-retry
// path (live-kill, addressed in 4c5013c) but for boot reconciliation orphans.
// Raised from 2 → 5 to survive burst restart storms (feedback 2026-06-15-01).
// Value lives in reaperHelpers.cjs (imported above) so the external watchdog
// shares the exact same budget — both increment the same j.orphanRetries field.

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
5. VERDICT SENTINEL — as the LAST LINE of your final result text, emit exactly
   one of these two lines (no trailing text after it):
     SCHEDULER_VERDICT: PASS
     SCHEDULER_VERDICT: FAIL <one-line reason>
   Print PASS only when the AC gate is green AND the commit from step 4 landed.
   Print FAIL (and exit 1) if the AC gate was red or the commit could not land.
   NEVER print PASS on a red AC gate — a lying PASS turns the verifier from a
   false-failure catcher into a silent-failure shipper. A truthful PASS + a
   landed commit lets the verifier override incidental transcript noise (grep
   results containing "Error", a TDD red-test run early in the session, debug
   Tracebacks) so those do not false-trip a needs_review downgrade.

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

// Returns true if ≥1 commit landed on any ref (branch, remote-tracking branch,
// or tag) in cwd between startedAt and finishedAt (with 60s slack) — not just
// the currently checked-out branch. Used by the self-heal pass to derive
// committedDuringRun from the recorded run window — the live commit-guard uses
// gitHead() instead. Never throws; git-unavailable → false (no override, job
// stays as-is).
function committedInWindow(cwd, startedAt, finishedAt) {
  return new Promise((resolve) => {
    if (!cwd || !startedAt) { resolve(false); return; }
    const until = finishedAt
      ? new Date(Date.parse(finishedAt) + 60_000).toISOString()
      : new Date().toISOString();
    execFile(
      'git',
      ['-C', cwd, 'log', '--all', '--format=%H', `--since=${startedAt}`, `--until=${until}`],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => { resolve(!err && String(stdout || '').trim().length > 0); },
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

// Each headless claude -p job can shell out to tsc/vite/pytest and grow well
// past 1 GB at peak; reserve 2.5 GB per running+pending slot. Raised from 1.5 GB
// after the 2026-06-16 OOM: 3 concurrent cross-project jobs + their build
// subprocesses pushed a 24 GB host ~10 GB into swap and the OOM killer took
// Electron — every pty got SIGHUP (code=0 signal=1).
const MIN_FREE_MB_PER_JOB = 2500;

// Absolute headroom kept free for the Electron host (main + renderer + GPU) and
// the OS — NEVER lent to jobs. Without it the gate green-lights a job whenever
// MemAvailable is just above per-job need, starving the very process that owns
// the ptys; that's the one the OOM killer then reaps. Subtracted from
// MemAvailable before the per-job gate runs. See availableForJobs().
const RESERVED_HOST_MB = 3000;

// oom_score_adj applied to each spawned claude -p job (range -1000..1000;
// Electron inherits the default 0). A positive bias makes the kernel OOM killer
// prefer a disposable, restartable job over Electron — whose death SIGHUPs every
// pty and drops the sleep inhibitor. The job's build subprocesses (tsc/vite)
// inherit it, so the actual memory hogs are the preferred victims. The gate caps
// how many START; this decides who dies if a spike slips through anyway.
const OOM_SCORE_ADJ_JOB = 500;

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

/**
 * Memory available to LAUNCH jobs with: MemAvailable minus the host reserve,
 * floored at 0. Keeping the host reserve out of the job budget is what stops the
 * gate from green-lighting a job into an OOM that kills Electron. Fails open
 * (Infinity) on non-Linux where MemAvailable is unknown. Exported for tests.
 */
function availableForJobs(availableMb, reservedHostMb) {
  if (availableMb === Infinity) return Infinity;
  return Math.max(0, availableMb - reservedHostMb);
}

/**
 * Bias a spawned job's oom_score_adj up so the kernel OOM killer sacrifices the
 * (restartable) job before Electron. Raising a child's OWN score is privilege-
 * free; lowering Electron's would need CAP_SYS_RESOURCE. Linux-only, best-effort
 * — the job may have already exited (write ENOENTs), which is fine. See the
 * 2026-06-16 OOM-kills-Electron incident.
 */
function biasJobOomScore(pid) {
  if (process.platform !== 'linux' || !pid) return;
  try {
    fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(OOM_SCORE_ADJ_JOB));
  } catch {
    /* job already exited, or /proc unavailable — best-effort hardening only */
  }
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

// Bundled authoring guide seeded into the scheduler dir so the session-manager-dev
// plugin's /develop and /prd skills — which reference this stable `~`-absolute
// path — work on any user's machine, not just the author's.
const PRD_AUTHORING_TEMPLATE = path.join(__dirname, 'templates', 'PRD_AUTHORING.md');
const PRD_AUTHORING_DEST = path.join(ROOT, 'PRD_AUTHORING.md');

function ensureDirs() {
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  // Seed the authoring guide once; never clobber a user's edited copy.
  try {
    if (!fs.existsSync(PRD_AUTHORING_DEST) && fs.existsSync(PRD_AUTHORING_TEMPLATE)) {
      fs.copyFileSync(PRD_AUTHORING_TEMPLATE, PRD_AUTHORING_DEST);
    }
  } catch { /* non-fatal: the guide is a convenience, not load-bearing for a run */ }
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
 * Atomically mint a brand-new parallel-group NN for a PRD about to be
 * authored under PRDS_DIR. See prdParser.allocateParallelGroup for the
 * collision-proof mechanics. Callers wanting to join an EXISTING group
 * (deliberate parallel siblings) skip this and just reuse the NN prefix.
 */
async function allocateParallelGroup() {
  ensureDirs();
  return prdParser.allocateParallelGroup(PRDS_DIR);
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
    const entry = {
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
    };
    // Newly-discovered fix-plan PRD: stamp its investigationDepth relative to
    // the original job it heals, so selectAutoFixTargets/spawnInvestigation
    // can bound the fix-of-a-fix recursion (see MAX_INVESTIGATION_DEPTH).
    // Non-fix-plan jobs get no explicit field — they read as depth 1 via `?? 1`.
    if (isFixPlanSlug(slug)) {
      const parent = healTargetForFix(slug, state.jobs);
      entry.investigationDepth = parent ? (parent.investigationDepth ?? 1) + 1 : 2;
    }
    next.push(entry);
  }
  state.jobs = next.sort((a, b) => b.slug.localeCompare(a.slug));
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
// Auto-fix investigations spawn Opus `claude -p` OUTSIDE runningSet/pickNextBatch,
// so they must be capped independently or a boot with N needs_review jobs fans out
// N concurrent Opus processes — the >3-concurrent class that OOM-killed Electron.
// Over-cap requests are QUEUED (not dropped) and drained as slots free, so a failed
// PRD that never reaches 'needs_review' still eventually gets its fix-plan authored.
let investigationsInFlight = 0;
const MAX_CONCURRENT_INVESTIGATIONS = 1;
const deferredInvestigations = new Map(); // fixable-job slug -> { failedJob, runDir }

function drainDeferredInvestigation() {
  if (investigationsInFlight >= MAX_CONCURRENT_INVESTIGATIONS) return;
  const next = deferredInvestigations.entries().next();
  if (next.done) return;
  const [slug, ctx] = next.value;
  deferredInvestigations.delete(slug);
  spawnInvestigation(ctx.failedJob, ctx.runDir).catch((e) => {
    console.error('[scheduler] drained investigation error', slug, e);
  });
}
let cancelToken = { cancelled: false };
// Last memory-gate observation; included in snapshot for renderer visibility.
let lastMemGate = null;

/**
 * Pure: applies clearPause()'s effect on the tick cancel-token.
 *
 * ROOT CAUSE (2026-07-14 stall, PRD 543/544): setPaused() cancels the
 * in-flight tick batch by setting cancelToken.cancelled = true (e.g. when a
 * job's run is rate-limited). That flag was previously only ever reset back
 * to false inside runDueJobs() (used by the force-tick/run-now IPC handlers
 * and the resume-timer callback). clearPause() itself — the function the
 * poll-loop's auth/network auto-recovery and the manual "Resume" button
 * actually call — never reset it. So once ANY pause fired and was later
 * cleared through one of THOSE paths instead of runDueJobs(), cancelToken
 * .cancelled stayed permanently true, and tickQueue()'s very first guard
 * (`if (cancelToken.cancelled) return {fired:false, reason:'cancelled'}`)
 * silently short-circuited every future tick — from spawnJob's own
 * post-completion tick, from the when-available poll, and from the
 * dead-process reaper — forever, even though queue.json's `paused` field
 * was correctly null and every other gate (enabled, concurrency, memory)
 * said go. This explains the full incident: lastRunAt froze at the last
 * tick that got past the guard, new PRDs kept appearing as `pending`
 * because reconcile() also runs independently from the `schedule:state` IPC
 * read (unrelated to tickQueue), and only a manual force-tick (which goes
 * through runDueJobs()) could ever unwedge it.
 *
 * Exported so this regression is unit-testable without touching the real
 * scheduler's fs-backed queue.json.
 */
function applyPauseCleared(wasPaused, token) {
  if (wasPaused) token.cancelled = false;
  return token;
}

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
  // Un-cancel the tick guard on every recovery path, not just runDueJobs().
  applyPauseCleared(wasPaused, cancelToken);
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

/** Scan the tail of a job's log for a network-outage signal: the structured
 *  `terminal_reason":"api_error"` field alongside a network-class error
 *  string. This is NOT a real code defect — spawning an auto-fix
 *  investigation for it just burns a second run diagnosing an outage (PRD
 *  543's ENOTFOUND incident, 2026-07-14). Deliberately narrow: only fires on
 *  the structured terminal_reason field, never on ad-hoc "error" text that
 *  legitimately appears in TDD red-phase transcripts. */
function detectNetworkErrorInLog(logPath) {
  try {
    const text = readTail(logPath, 16384);
    if (!text) return false;
    if (!/"terminal_reason":"api_error"/.test(text)) return false;
    return /ENOTFOUND/.test(text)
      || /ECONNREFUSED/.test(text)
      || /ETIMEDOUT/.test(text)
      || /EAI_AGAIN/.test(text)
      || /network is unreachable/i.test(text);
  } catch {
    return false;
  }
}

// Bounded retry cap for transient (signal-kill or network-outage) failures.
// A small constant, not a config knob: the point is that it is impossible to
// loop unboundedly (queueOps.cjs lints for unbounded loops; see the fizzpop
// poll-hang in PRD_AUTHORING.md for why an unbounded retry is a real hazard).
const TRANSIENT_RETRY_CAP = 2;

/**
 * Classify a failed job's outcome as one of: retry it (transient, bounded),
 * fail it without auto-fix (transient but unsafe to retry, or the retry cap
 * is exhausted), or investigate it (a genuine code failure). Pure/no I/O so
 * the transient-vs-terminal boundary can be unit-tested directly rather than
 * only through a live spawnJob run.
 *
 * A 143/137 exit within the idle-watchdog window is a signal-kill transient
 * (external kill, not a real failure — see the call site's long-form
 * rationale). A `terminal_reason:"api_error"` + network-class error
 * (ENOTFOUND etc., detected by detectNetworkErrorInLog) is an outage
 * transient (PRD 543/545 incident) — same bounded-retry treatment, not a
 * second parallel classifier.
 */
function classifyFailureOutcome({ exitCode, networkError, durationMs, transientRetries, newlyDirtyCount }) {
  const signalTransient = (exitCode === 143 || exitCode === 137) && durationMs < IDLE_OUTPUT_KILL_MS;
  const networkTransient = networkError === true;
  const transient = signalTransient || networkTransient;
  if (!transient) return { action: 'investigate' };

  const transientKind = networkTransient ? 'network' : `exit=${exitCode}`;
  const retries = transientRetries ?? 0;
  // A transient failure can still leave partial work on disk (the 543
  // ENOTFOUND run wrote its renderer, then died before committing). Requeuing
  // over that dirt would either re-implement on top of it or conflict with
  // it — refuse and fail instead of silently re-running over orphaned edits.
  if (newlyDirtyCount > 0) {
    return { action: 'fail-dirty', transientKind, newlyDirtyCount };
  }
  if (retries >= TRANSIENT_RETRY_CAP) {
    return { action: 'fail-cap', transientKind, retries };
  }
  return { action: 'retry', transientKind, retries };
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
    // PATH must include Homebrew/user bins or the job's node/git children ENOENT
    // when Electron was launched from Finder/Dock on macOS (stripped PATH).
    const childEnv = cleanChildEnv({ PATH: pathWithUserBins() });

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
        const networkError = effectiveCode !== 0 && !rateLimited && detectNetworkErrorInLog(logPath);
        // Sync write: child 'exit' handler must flush meta before resolve()
        // so the spawnJob mutate() that follows sees the persisted exit code.
        config.writeJsonSync(metaPath, {
          slug: job.slug, cwd, sessionId, exitCode: effectiveCode, rateLimited, networkError,
          startedAt, finishedAt: Date.now(), durationMs,
          agentResultSubtype, mappedFromSignal: mappedToSuccess ? signal || `code=${exitCode}` : null,
        });
        resolve({ exitCode: effectiveCode, durationMs, rateLimited, networkError, sessionId });
      },
    });

    if (child) {
      safeLog(`[scheduler] spawned pid=${child.pid} sessionId=${sessionId} (process group)\n\n`);
      // Make this job the OOM killer's preferred victim over Electron.
      biasJobOomScore(child.pid);
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
 * Returns true for statuses that a fix-plan completion should promote
 * (clear) on the original job. Both 'failed' and 'needs_review' are
 * recoverable via a fix-plan; 'completed', 'running', 'pending' are not.
 */
function isPromotableOriginal(status) {
  return status === 'failed' || status === 'needs_review';
}

/**
 * Pure helper: given a completed fix-plan slug (e.g. '451-fix-foo'), find the
 * SPECIFIC promotable original job it heals. Matches on the full
 * numeric-prefixed slug ('451-foo'), not just the base ('foo') — two
 * needs_review jobs can share a base slug with different NN prefixes
 * (e.g. '451-foo' and '453-foo'), and a fix plan must only heal the
 * lineage whose NN it was authored against. Exported for tests.
 */
function healTargetForFix(fixSlug, jobs) {
  const originalSlug = fixSlug.replace(/^(\d+)-fix-/, '$1-');
  return jobs.find((x) => x.slug === originalSlug && isPromotableOriginal(x.status)) || null;
}

/**
 * Build the Opus investigation prompt. Pure/hermetic so its content can be
 * unit-tested (no spawn, no fs). Inputs are the already-resolved values that
 * spawnInvestigation computes.
 */
function buildInvestigationPrompt({ failedJob, cwd, failedLogPath, originalBody, logTail, fixPath, group }) {
  return `You are investigating a failed scheduled job in the session-manager queue. Your ONLY job is to write a fix-plan PRD file. Do NOT attempt the fix yourself.

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
   - Before writing the fix-plan PRD body, read
     \`plugins/session-manager-dev/skills/develop/standards.md\` (resolve it relative to the failed
     job's repo root — for session-manager-authored PRDs that is this cwd). Inline its
     \`## Execution discipline (headless runs)\` section VERBATIM into the new fix-plan PRD under an
     \`## Engineering standards\` heading, exactly as the \`/develop\` skill's Phase 1 does for normal
     PRDs. Reuse that convention — do not invent a second, paraphrased set of warnings. The headless
     Sonnet executor that runs your fix-plan sees no skills and no conversation, so inlining these
     rules verbatim is the only way they reach it.
   - Known failure class — "delegated instead of executed": if the failure log tail above shows the
     failed run invoked the \`Skill\` tool with a \`session-manager-dev:develop\` or
     \`session-manager-dev:process-feedback\` argument, and/or called \`ScheduleWakeup\`, and then exited
     0 without producing the diff/tests its PRD demanded, recognize this as a self-delegation failure.
     In that case LEAD the fix-plan PRD by quoting VERBATIM the canonical rule from standards.md's
     Execution discipline section — "You ARE the executor — never re-queue or self-schedule" — rather
     than authoring new prose. Instruct the fix-plan's executor plainly that a queued PRD is the task,
     not evidence of completion, and that the deliverable is the code diff.

DO NOT attempt the fix. ONLY write the file. When the file exists, exit immediately.`;
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
  if (isFixPlanBeyondDepthCap(failedJob.slug, failedJob.investigationDepth)) {
    console.log(`[scheduler] skip investigation: ${failedJob.slug} is a fix plan at/beyond depth cap (depth=${failedJob.investigationDepth ?? 'none'})`);
    return { deferred: false };
  }
  if (investigationsInFlight >= MAX_CONCURRENT_INVESTIGATIONS) {
    // Queue for retry when a slot frees rather than dropping — otherwise a failed
    // job (never 'needs_review', so reverifyNeedsReview won't retry it) would
    // silently never get an auto-authored fix-plan.
    if (!deferredInvestigations.has(failedJob.slug)) {
      deferredInvestigations.set(failedJob.slug, { failedJob, runDir });
      console.log(`[scheduler] investigation queued for ${failedJob.slug} (slot busy, ${deferredInvestigations.size} waiting)`);
    }
    return { deferred: true };
  }
  // Reserve the slot synchronously (before any await) so concurrent callers can't
  // both pass the cap check. Released in onExit, on any pre-spawn early return, or
  // on a synchronous throw (try/catch below) — and releasing hands the slot to a
  // queued investigation so none are stranded.
  investigationsInFlight++;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    investigationsInFlight--;
    drainDeferredInvestigation();
  };
  try {

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
    releaseSlot();
    return { deferred: false };
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
  const prompt = buildInvestigationPrompt({ failedJob, cwd, failedLogPath, originalBody, logTail, fixPath, group });

  // Phase 1: open log fd for pre-spawn diagnostics.
  const { fd, safeLog, closeFd } = openLog(investigationLogPath);
  const sessionId = randomUUID();
  safeLog(`[scheduler] investigation starting for ${failedJob.slug} at ${new Date().toISOString()}\n[scheduler] target fix PRD: ${fixPath}\n[scheduler] sessionId=${sessionId}\n\n`);

  const investigationPromptCheck = validatePromptForSpawn(prompt, `<investigation prompt for ${failedJob.slug}>`);
  if (!investigationPromptCheck.ok) {
    safeLog(`\n[scheduler] ${investigationPromptCheck.error}\n`);
    closeFd();
    releaseSlot();
    return { deferred: false };
  }

  const claudeBin = resolveClaudeBin();
  const childEnv = cleanChildEnv({ PATH: pathWithUserBins() }); // Homebrew/user bins for macOS

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
      releaseSlot();
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
        // Record the no-plan outcome so selectAutoFixTargets can offer one
        // bounded retry instead of permanently dead-ending behind the
        // 1-attempt cap (autoFixAttempted stays true).
        mutate((s) => {
          const j = s.jobs.find((x) => x.slug === failedJob.slug);
          if (j) j.autoFixOutcome = 'no-plan';
        }).catch(() => {});
      }
      // Trigger a tick so the new fix plan is reconciled into the queue and fired.
      tickQueue().catch(() => {});
    },
  });

  if (child) {
    safeLog(`[scheduler] investigation pid=${child.pid}\n\n`);
  }
  return { deferred: false };
  } catch (e) {
    // A synchronous throw before onExit is wired (e.g. resolveClaudeBin not found,
    // openLog failure, spawn setup) must not strand the reserved slot.
    releaseSlot();
    throw e;
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
      // Detect whether the job self-committed by comparing HEAD before/after.
      // Used by the sentinel override: SCHEDULER_VERDICT: PASS + a landed
      // commit together override incidental transcript noise verdicts.
      const headAtExit = await gitHead(guardCwd);
      const committedDuringRun = !!(guardHeadBefore && headAtExit && guardHeadBefore !== headAtExit);

      const prdPath = path.join(PRDS_DIR, `${job.slug}.md`);
      const stateForDeps = await readQueue();
      verifyResult = await verifyRun({
        runDir,
        prdPath,
        queueEntry: job,
        allJobs: stateForDeps.jobs,
        committedDuringRun,
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
    let needsInvestigationNow = false;
    let investigationJobSnapshot = null;
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
          } else if (effectiveStatus === 'needs_review') {
            // Same-tick auto-fix (feedback 2026-07-12): rather than waiting up to
            // 10 min for reverifyNeedsReview()'s periodic pass, check right here
            // whether this job qualifies for auto-fix (same eligibility rule
            // reverifyNeedsReview uses via selectAutoFixTargets) and, if so, spawn
            // the investigation immediately. Stamp autoFixAttempted BEFORE the
            // investigation fires (mirrors reverifyNeedsReview's auto-fix section)
            // so the periodic pass 10 min later sees it already attempted and
            // does not spawn a duplicate.
            const fixSlugExists = (slug) => fs.existsSync(path.join(PRDS_DIR, `${slug}.md`));
            if (
              process.env.SM_AUTOFIX_DISABLE !== '1' &&
              isEligibleForImmediateAutoFix(s.jobs[i2], s.jobs, fixSlugExists)
            ) {
              const isNoPlanRetry = s.jobs[i2].autoFixAttempted && s.jobs[i2].autoFixOutcome === 'no-plan';
              s.jobs[i2].autoFixAttempted = true;
              if (!s.jobs[i2].runId) s.jobs[i2].runId = runId;
              if (isNoPlanRetry) {
                s.jobs[i2].autoFixRetries = (s.jobs[i2].autoFixRetries ?? 0) + 1;
                delete s.jobs[i2].autoFixOutcome;
              }
              needsInvestigationNow = true;
              investigationJobSnapshot = { ...s.jobs[i2] };
            }
          }
          // Auto-promote: when a fix-* PRD completes successfully, the original
          // failed PRD's work is logically done. Flip its status to 'completed'
          // so the cross-group failure gate in pickNextBatch releases. Without
          // this, the queue stalls indefinitely behind a stale failure even
          // though the auto-recovery did its job.
          if (effectiveStatus === 'completed' && isFixPlanSlug(job.slug)) {
            const orig = healTargetForFix(job.slug, s.jobs);
            if (orig) {
              const priorStatus = orig.status;
              console.log(`[scheduler] auto-promote: ${orig.slug} (${priorStatus}) → completed because ${job.slug} succeeded`);
              orig.status = 'completed';
              orig.exitCode = 0;
              orig.error = null;
              orig.completedBy = job.slug;
              if (priorStatus === 'needs_review') {
                delete orig.verifierVerdict;
              }
            }
          }
        }
      }
    });
    await broadcast();

    if (actuallyFailed && failedJobSnapshot) {
      // Transient-failure detector. A 143/137 exit is ALWAYS a signal kill — the
      // agent never self-exits with those — so the only question is WHO killed it.
      // The scheduler's own intentional kills before the idle watchdog are the
      // result-tail post-success kill (which maps back to exit 0, so it never
      // reaches here) and the rare supervisor kill-agent. The idle-output
      // watchdog only fires at IDLE_OUTPUT_KILL_MS (20 min) of stalled output,
      // and the deadman at 4 h. THEREFORE any 143/137 with a run shorter than the
      // idle threshold is an EXTERNAL/transient kill — an app restart (incl. our
      // own self-restart on publish/HMR — see feedback 2026-06-15-01), an
      // OOM-kill, or a manual kill — not a real failure. Re-queue it (bounded)
      // instead of marking it failed + spawning a spurious fix-plan. (Was 45 s,
      // which wrongly hard-failed externally-killed jobs like 115 SIGTERM'd at
      // 67 s.) Genuine watchdog kills (idle ≥20 min, deadman 4 h) run longer than
      // the threshold and still fall through to investigation.
      const ec = failedJobSnapshot.exitCode;
      const retries = failedJobSnapshot.transientRetries ?? 0;
      // Only pay for the extra git status call when the failure is plausibly
      // transient — a real code failure never needs the dirty-tree check.
      const maybeTransient = (ec === 143 || ec === 137) || res.networkError === true;
      let newlyDirtyCount = 0;
      let dirtySample = '';
      if (maybeTransient) {
        const afterFailure = await uncommittedChanges(guardCwd);
        const baseSet = new Set(guardBaseline || []);
        const newlyDirty = (afterFailure || []).filter((p) => !baseSet.has(p));
        newlyDirtyCount = newlyDirty.length;
        dirtySample = newlyDirty.slice(0, 3).join(', ');
      }
      const decision = classifyFailureOutcome({
        exitCode: ec,
        networkError: res.networkError,
        durationMs: res.durationMs,
        transientRetries: retries,
        newlyDirtyCount,
      });

      if (decision.action === 'retry') {
        console.log(`[scheduler] transient failure (${decision.transientKind} dur=${res.durationMs}ms) — auto-retry ${decision.retries + 1}/${TRANSIENT_RETRY_CAP} for ${job.slug}`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            resetJobFields(s.jobs[i], null);
            s.jobs[i].transientRetries = decision.retries + 1;
          }
        });
        await broadcast();
      } else if (decision.action === 'fail-dirty') {
        console.log(`[scheduler] transient failure (${decision.transientKind}) for ${job.slug} left ${newlyDirtyCount} uncommitted file(s) (e.g. ${dirtySample}) — not auto-requeuing`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            s.jobs[i].status = 'failed';
            s.jobs[i].error = `transient failure (${decision.transientKind}) left ${newlyDirtyCount} uncommitted file(s) in working tree (e.g. ${dirtySample}) — not auto-requeued to avoid overwriting partial work; review and commit or discard manually`;
          }
        });
        await broadcast();
        // No auto-fix investigation: this isn't a code defect, and the
        // dirty tree needs a human, not a diagnosis run.
      } else if (decision.action === 'fail-cap') {
        // Retry cap exhausted: fail terminally, but a transient classification
        // never spawns an auto-fix investigation — there is no code defect to
        // diagnose, only a recurring outage.
        console.log(`[scheduler] transient failure (${decision.transientKind}) for ${job.slug} exhausted retry cap (${decision.retries}/${TRANSIENT_RETRY_CAP}) — failing without auto-fix`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            s.jobs[i].error = `transient failure (${decision.transientKind}) exhausted retry cap (${decision.retries}/${TRANSIENT_RETRY_CAP}) — marking failed without auto-fix investigation`;
          }
        });
        await broadcast();
      } else {
        spawnInvestigation(failedJobSnapshot, runDir).catch((e) => {
          console.error('[scheduler] spawnInvestigation error', job.slug, e);
        });
      }
    } else if (needsInvestigationNow && investigationJobSnapshot) {
      console.log(`[scheduler] needs_review ${job.slug} → immediate auto-fix investigation (not waiting for periodic reverify)`);
      spawnInvestigation(investigationJobSnapshot, runDir).catch((e) => {
        console.error('[scheduler] spawnInvestigation error', job.slug, e);
      });
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
      return { fired: false, reason: 'paused' };
    }
    if (cancelToken.cancelled) return { fired: false, reason: 'cancelled' };

    await reconcile(state);
    const cap = ENV_CAP ?? state.config.concurrencyCap;
    const { batch, reason: holdReason } = pickNextBatch(state.jobs, runningSet, cap);
    if (batch.length === 0) {
      // Queue drained — run the definition-of-done gate fire-and-forget.
      // Non-blocking: does not hold the mutate lock; errors are logged, not thrown.
      runDefinitionOfDoneOnDrain(state, { cancelToken }).catch((err) => {
        console.log(`[scheduler] dod-drain: ${err?.message ?? String(err)}`);
      });
      if (holdReason) return { fired: false, reason: 'held', detail: holdReason };
      // Distinguish "genuinely nothing to do" from "the batch was already
      // fired by a concurrent tickQueue() call" (e.g. the periodic
      // when-available poll winning a race against a manual force-tick —
      // pickNextBatch correctly returns reason:null in both cases since
      // neither is a hold; the caller-facing message needs to tell them
      // apart so "No pending jobs" doesn't read as wrong next to a job
      // that is visibly running).
      const runningCount = Math.max(
        runningSet.size,
        state.jobs.filter((j) => j.status === 'running').length,
      );
      if (runningCount > 0) {
        return { fired: false, reason: 'already-running', runningCount };
      }
      return { fired: false, reason: 'drained' };
    }

    const availableMb = getAvailableMemMb();
    // Reserve a fixed slice for the Electron host before the per-job gate, so a
    // job is never started into the host's own headroom (that path OOM-kills
    // Electron and SIGHUPs every pty — 2026-06-16 incident).
    const jobBudgetMb = availableForJobs(availableMb, RESERVED_HOST_MB);
    const allowed = memoryLimitedBatchSize(jobBudgetMb, MIN_FREE_MB_PER_JOB, runningSet.size, batch.length);
    if (allowed === 0) {
      const threshold = RESERVED_HOST_MB + MIN_FREE_MB_PER_JOB * (runningSet.size + 1);
      console.log(`[scheduler] memory gate: available=${availableMb} MB < threshold=${threshold} MB (host reserve ${RESERVED_HOST_MB} + ${MIN_FREE_MB_PER_JOB}/job × ${runningSet.size + 1}) — deferring ${batch.length} job(s)`);
      lastMemGate = { availableMb, threshold, deferred: true, at: new Date().toISOString() };
      return { fired: false, reason: 'memory-deferred', deferredCount: batch.length, availableMb, threshold };
    }
    const gatedBatch = batch.slice(0, allowed);
    if (gatedBatch.length < batch.length) {
      console.log(`[scheduler] memory gate: available=${availableMb} MB — clamped batch ${batch.length} → ${gatedBatch.length} (host reserve ${RESERVED_HOST_MB} + ${MIN_FREE_MB_PER_JOB}/job)`);
      lastMemGate = { availableMb, threshold: RESERVED_HOST_MB + MIN_FREE_MB_PER_JOB * (runningSet.size + gatedBatch.length), deferred: false, clamped: true, at: new Date().toISOString() };
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
    return { fired: true, count: gatedBatch.length, group: gatedBatch[0]?.parallelGroup };
  });
  tickTail = next.catch(() => {});
  return next;
}

// Translates a tickQueue()/runDueJobs() outcome descriptor into a renderer-facing
// ActionOutcome for the schedule:force-tick IPC handler.
function forceTickOutcome(result) {
  if (!result) return { ok: true, kind: 'info', message: 'No pending jobs' };
  if (result.fired) {
    const groupSuffix = result.group !== undefined ? ` (group g${result.group})` : '';
    return { ok: true, kind: 'info', message: `Fired ${result.count} job(s)${groupSuffix}` };
  }
  switch (result.reason) {
    case 'drained':
      return { ok: true, kind: 'info', message: 'No pending jobs' };
    case 'already-running':
      return { ok: true, kind: 'info', message: `Already running — ${result.runningCount} job(s) in flight` };
    case 'paused':
      return { ok: true, kind: 'warn', message: 'Scheduler is paused' };
    case 'cancelled':
      return { ok: true, kind: 'warn', message: 'Batch cancelled — try again' };
    case 'memory-deferred':
      return { ok: true, kind: 'warn', message: `Deferred ${result.deferredCount} job(s) — low memory (${result.availableMb} MB available, need ${result.threshold} MB)` };
    case 'held': {
      const detail = String(result.detail ?? '').replace(/^\[scheduler\]\s*[\w-]+\s*(?:\[[^\]]*\])?:\s*/, '');
      return { ok: true, kind: 'warn', message: detail || 'Batch held' };
    }
    default:
      return { ok: true, kind: 'info', message: 'No pending jobs' };
  }
}

async function runDueJobs() {
  const state = await readQueue();
  if (state.paused) {
    console.log('[scheduler] runDueJobs skipped: paused');
    return { fired: false, reason: 'paused' };
  }
  cancelToken = { cancelled: false };
  const result = await tickQueue();
  // Clear the one-shot scheduledFor without waiting for jobs to settle.
  await mutate((s) => { s.scheduledFor = null; });
  await broadcast();
  return result;
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

    // Enterprise auth (Bedrock / Vertex / API-key / corporate gateway): there is
    // no consumer 5-hour usage meter to poll. Don't hit an endpoint that will
    // 404/time-out and eventually pause the queue on 'network' — treat usage as
    // wide-open and fire on pending + memory alone. (Blackrock-style machines.)
    if (!billing.usageMeterApplicable()) {
      cachedUtilization = 0;
      consecutiveFailures = 0;
      backoffMs = 0;
      backoffNextAt = null;
      firstFailureAt = null;
      firstNon429FailureAt = null;
      lastFailureKind = null;
      lastPollAt = Date.now();
      lastPollOk = true;
      persistSchedulerState();
      let cur = await readQueue();
      // Clear a stale auth/network pause inherited from a prior consumer-auth
      // session so the queue isn't wedged. Never clears rate_limit/manual.
      if (cur.paused && (cur.paused.reason === 'auth' || cur.paused.reason === 'network')) {
        await clearPause('enterprise-auth');
        cur = await readQueue(); // re-read so the cleared pause is visible to launch THIS cycle
      }
      await maybeLaunchWhenAvailable(cur);
      await broadcast();
      return; // finally re-arms the timer
    }

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
      let cur = await readQueue();
      const clearSrc = pollRecoveryClearSource(cur.paused?.reason ?? null, !!cachedNextReset);
      if (clearSrc) {
        await clearPause(clearSrc);
        cur = await readQueue(); // re-read so the cleared pause launches work THIS cycle
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
// heal a genuinely-unfinished job. 'no_verdict_sentinel' is included because
// its raising condition (sentinel === null && !committedDuringRun) depends on
// commit-detection, which committedInWindow() can fix retroactively (e.g. the
// git-log --all scan added for missed non-HEAD commits) — rescanning lets a
// job whose commit is now correctly detected clear on its own instead of
// staying stuck in needs_review forever. 'pass_no_commit' is included because
// verifyRun now exempts fix-plan jobs (slug ^\d+-fix-) from that check — a
// fix-plan job flagged before that exemption shipped gets a genuinely
// different verdict on rescan (2026-07-12: false-positive cascade where
// investigation jobs correctly found "nothing to fix" but were flagged
// anyway). For non-fix-plan jobs the exemption never applies, so rescanning
// their pass_no_commit verdict is a harmless no-op (same facts, same verdict).
const RESCANNABLE_VERDICTS = new Set(['transcript_errors', 'verify_unavailable', 'no_verdict_sentinel', 'pass_no_commit']);

// Bounds fix-plan recursion: depth 1 = the original job, depth 2 = its fix
// (gets exactly one follow-up investigation if it also lands in
// needs_review), depth 3+ (a fix-of-a-fix-of-a-fix) is excluded. Shared by
// selectAutoFixTargets and spawnInvestigation so both call sites agree on
// one threshold.
const MAX_INVESTIGATION_DEPTH = 2;

/**
 * True when a fix-plan job's investigationDepth is at or past the recursion
 * cap and it must be excluded from auto-fix eligibility. A fix-plan job with
 * no recorded investigationDepth (a job already in the queue before this
 * depth tracking shipped) is treated as excluded too, preserving the
 * pre-existing blanket-exclusion behavior for legacy jobs — no retroactive
 * migration. Non-fix-plan slugs are never capped here. Exported for tests.
 */
function isFixPlanBeyondDepthCap(slug, investigationDepth) {
  if (!isFixPlanSlug(slug)) return false;
  if (investigationDepth == null) return true;
  return investigationDepth >= MAX_INVESTIGATION_DEPTH + 1;
}

/**
 * Backfill a job's missing runId by scanning RUNS_DIR for a run directory
 * whose contents reference this job's slug (a '<slug>.log' file inside it).
 * A needs_review job can lose its runId (e.g. an old queue-schema gap) and
 * become invisible to every auto-resolution path that requires job.runId
 * truthy. O(number of run dirs) — a single readdir + per-dir existsSync
 * check, no nested loop over user-scaled data. Dir names are ISO timestamps,
 * so lexical-descending sort picks the newest match. Exported for tests.
 */
function resolveRunId(job, { runsDir = RUNS_DIR } = {}) {
  if (!job || job.runId) return job?.runId || null;
  if (!job.slug) return null;
  let dirs;
  try {
    dirs = fs.readdirSync(runsDir);
  } catch {
    return null;
  }
  const matches = dirs.filter((d) => {
    try {
      return fs.existsSync(path.join(runsDir, d, `${job.slug}.log`));
    } catch {
      return false;
    }
  });
  if (!matches.length) return null;
  matches.sort().reverse();
  return matches[0];
}

/**
 * Pure predicate: a needs_review job with no runId and no backfillable run
 * directory can never self-heal or get an auto-fix investigation — it must
 * be surfaced for a human rather than silently dead-ended. Exported for
 * tests.
 */
function isUnresolvableNeedsReview(job, { hasRunDir }) {
  return !!job && job.status === 'needs_review' && !job.runId && !hasRunDir;
}

/**
 * Pure predicate: is this job eligible for the boot re-verify self-heal? Only
 * needs_review jobs with a run log (own or backfilled via resolveRunId) AND a
 * transcript-scan verdict. Crucially EXCLUDES 'uncommitted_changes' (git
 * commit-guard) — verifyRun can't see git, so re-scanning it would falsely
 * heal an unfinished job. Exported for tests.
 */
function isRescanCandidate(job) {
  return !!job
    && job.status === 'needs_review'
    && !!(job.runId || resolveRunId(job))
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
/**
 * Pure helper — no I/O by default (resolveJobRunId is injectable; production
 * caller passes resolveRunId, which does touch disk). Returns the subset of
 * jobs eligible for automatic fix-plan authoring after a reverify pass
 * leaves them still in needs_review.
 *
 * Exclusion rules (all must pass):
 *   - status === 'needs_review'
 *   - a runId, own or backfilled via resolveJobRunId (need a run log to investigate)
 *   - not itself a fix-plan slug (avoids infinite recursion)
 *   - autoFixAttempted cap: a job with no prior attempt is eligible; a job
 *     whose prior attempt outcome was 'no-plan' gets ONE bounded retry
 *     (autoFixRetries < 1); any other attempted job (or an exhausted
 *     no-plan retry) is excluded
 *   - no fix sibling on disk (fixSlugExists) or already in the queue
 */
function selectAutoFixTargets(jobs, { fixSlugExists, resolveJobRunId = resolveRunId }) {
  const slugsInQueue = new Set(jobs.map((j) => j.slug));
  return jobs.filter((job) => {
    if (job.status !== 'needs_review') return false;
    const runId = job.runId || resolveJobRunId(job);
    if (!runId) return false;
    if (isFixPlanBeyondDepthCap(job.slug, job.investigationDepth)) return false;
    if (job.autoFixAttempted) {
      if (job.autoFixOutcome !== 'no-plan') return false;
      if ((job.autoFixRetries ?? 0) >= 1) return false;
    }
    const fixSlug = `${String(job.parallelGroup ?? 99).padStart(2, '0')}-fix-${job.slug.replace(/^\d+-/, '')}`;
    if (fixSlugExists(fixSlug)) return false;
    if (slugsInQueue.has(fixSlug)) return false;
    return true;
  });
}

/**
 * Pure helper — no I/O by default (fixSlugExists is injectable). Answers
 * "does this single needs_review job qualify for an auto-fix investigation
 * right now?" by delegating to selectAutoFixTargets's eligibility rules
 * (same-1-attempt cap, depth cap, no fix sibling) against the full job list,
 * then checking whether this job is among the returned targets. Shared by
 * spawnJob's immediate same-tick path and (indirectly, via
 * selectAutoFixTargets itself) reverifyNeedsReview's periodic path, so both
 * use one eligibility definition rather than two divergent copies.
 */
function isEligibleForImmediateAutoFix(job, allJobs, fixSlugExists) {
  const targets = selectAutoFixTargets(allJobs, {
    fixSlugExists,
    resolveJobRunId: () => job.runId,
  });
  return targets.some((t) => t.slug === job.slug);
}

async function reverifyNeedsReview() {
  const snap = await readQueue();
  const candidates = snap.jobs.filter(isRescanCandidate);
  const healed = [];
  const leftForReview = [];
  for (const job of candidates) {
    const runDir = path.join(RUNS_DIR, job.runId || resolveRunId(job));
    const prdPath = path.join(PRDS_DIR, `${job.slug}.md`);
    // Derive committedDuringRun from the recorded run window. The live
    // commit-guard uses gitHead() (before/after HEAD diff); here the run is
    // already over so we query git log filtered to [startedAt, finishedAt+60s].
    const committedDuringRun = await committedInWindow(job.cwd, job.startedAt, job.finishedAt);
    let v = null;
    try {
      v = await verifyRun({
        runDir,
        prdPath,
        queueEntry: job,
        allJobs: snap.jobs,
        committedDuringRun,
        allowPreSentinelHeal: true,
      });
    } catch { leftForReview.push({ slug: job.slug, reason: 'verifyRun threw' }); continue; }
    if (v && v.verdict === 'clean') {
      healed.push(job.slug);
    } else {
      leftForReview.push({ slug: job.slug, reason: v ? `${v.verdict}: ${v.reason}` : 'null verdict' });
    }
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
  if (leftForReview.length) {
    const detail = leftForReview.map((e) => `${e.slug} (${e.reason})`).join(', ');
    console.log(`[scheduler] boot reverify: left for review: ${detail}`);
  }

  // Mirror the live-completion auto-promote (spawnJob, ~line 1583): ANY
  // completed fix-plan job whose original is still needs_review/failed means
  // the original's work is logically done. Runs every pass (not just against
  // jobs healed THIS pass) and over ALL completed fix-plan jobs, not just
  // ones just-healed above — a fix-plan job healed by a PRIOR boot/periodic
  // pass, or completed via a live run, is just as valid a promotion source.
  // Idempotent: an already-promoted original has status !== 'needs_review'/
  // 'failed', so isPromotableOriginal excludes it on repeat passes — safe to
  // re-run unconditionally. (2026-07-12: 521-fix-*/523-fix-* healed on one
  // boot but their originals stayed stuck needs_review on every subsequent
  // boot/tick, because the promotion only ran inside `if (healed.length)`
  // scoped to that single pass's fresh heals.)
  const promoted = [];
  await mutate((s) => {
    for (const job of s.jobs) {
      if (job.status !== 'completed' || !isFixPlanSlug(job.slug)) continue;
      const orig = healTargetForFix(job.slug, s.jobs);
      if (!orig) continue;
      const priorStatus = orig.status;
      orig.status = 'completed';
      orig.exitCode = 0;
      orig.error = null;
      orig.completedBy = job.slug;
      if (priorStatus === 'needs_review') delete orig.verifierVerdict;
      promoted.push(`${orig.slug} (was ${priorStatus}, via ${job.slug})`);
    }
  });
  if (promoted.length) {
    console.log(`[scheduler] boot reverify: auto-promoted ${promoted.length} original(s): ${promoted.join(', ')}`);
    await broadcast();
  }

  // Surface needs_review jobs that can never self-heal or get an auto-fix
  // investigation (no runId, no backfillable run dir) instead of leaving
  // them silently stranded. Also surface no-plan auto-fix jobs whose one
  // bounded retry is already exhausted. Both are annotated, never looped on.
  const afterHealForAnnotate = await readQueue();
  const unresolvable = afterHealForAnnotate.jobs.filter(
    (j) => isUnresolvableNeedsReview(j, { hasRunDir: !!resolveRunId(j) }) && j.verifierVerdict !== 'no_run_artifacts',
  );
  const exhaustedNoPlan = afterHealForAnnotate.jobs.filter(
    (j) => j.status === 'needs_review'
      && j.autoFixAttempted && j.autoFixOutcome === 'no-plan' && (j.autoFixRetries ?? 0) >= 1
      && j.verifierVerdict !== 'autofix_no_plan',
  );
  if (unresolvable.length || exhaustedNoPlan.length) {
    const unresolvableSet = new Set(unresolvable.map((j) => j.slug));
    const exhaustedSet = new Set(exhaustedNoPlan.map((j) => j.slug));
    await mutate((s) => {
      for (const j of s.jobs) {
        if (unresolvableSet.has(j.slug)) {
          j.verifierVerdict = 'no_run_artifacts';
          j.error = 'no run artifacts — manual review';
        } else if (exhaustedSet.has(j.slug)) {
          j.verifierVerdict = 'autofix_no_plan';
          j.error = 'auto-fix investigation produced no fix plan after retry — manual review';
        }
      }
    });
    if (unresolvable.length) {
      console.log(`[scheduler] boot reverify: no run artifacts for ${unresolvable.map((j) => j.slug).join(', ')} — flagged for manual review`);
    }
    if (exhaustedNoPlan.length) {
      console.log(`[scheduler] boot reverify: auto-fix retry exhausted for ${exhaustedNoPlan.map((j) => j.slug).join(', ')} — flagged for manual review`);
    }
    await broadcast();
  }

  // Auto-fix: spawn a fix-plan investigation for each job still in
  // needs_review after the heal pass (kill-switch: SM_AUTOFIX_DISABLE=1).
  // spawnInvestigation early-returns once investigationsInFlight reaches
  // MAX_CONCURRENT_INVESTIGATIONS (queues the rest for retry), so this loop
  // cannot fan out past the cap regardless of how many targets are selected.
  if (process.env.SM_AUTOFIX_DISABLE !== '1') {
    const afterHeal = await readQueue();
    const targets = selectAutoFixTargets(afterHeal.jobs, {
      fixSlugExists: (s) => fs.existsSync(path.join(PRDS_DIR, `${s}.md`)),
    });
    for (const job of targets) {
      const runId = job.runId || resolveRunId(job);
      const runDir = path.join(RUNS_DIR, runId);
      const isNoPlanRetry = job.autoFixAttempted && job.autoFixOutcome === 'no-plan';
      // Persist the attempt BEFORE spawning — a crash mid-investigation still
      // counts it (mirrors orphanRetries). Safe even when the slot is busy: the
      // investigation is queued and drained as slots free, so it is genuinely
      // attempted rather than silently dropped.
      await mutate((s) => {
        const j = s.jobs.find((x) => x.slug === job.slug);
        if (j) {
          j.autoFixAttempted = true;
          if (!j.runId && runId) j.runId = runId;
          if (isNoPlanRetry) {
            j.autoFixRetries = (j.autoFixRetries ?? 0) + 1;
            delete j.autoFixOutcome;
          }
        }
      });
      console.log(`[scheduler] auto-fix: needs_review ${job.slug} → authoring fix-plan (${isNoPlanRetry ? 'retry' : '1/1'})`);
      spawnInvestigation(job, runDir).catch((e) => {
        console.error('[scheduler] auto-fix spawnInvestigation error', job.slug, e);
      });
    }
  }

  return { rescanned: candidates.length, healed, leftForReview };
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

  ipcMain.handle('schedule:force-tick', async () => {
    // Bypass the billing-poll gate entirely — fire pending jobs immediately regardless of meter state.
    // Clears any existing pause first (same semantics as run-now).
    await clearPause('run-now');
    try {
      const result = await runDueJobs();
      return forceTickOutcome(result);
    } catch (e) {
      logs.writeLine({ level: 'error', scope: 'scheduler', message: 'runDueJobs error (force-tick)', meta: { error: e?.message } });
      return { ok: false, kind: 'error', message: `Failed to fire batch: ${e?.message ?? String(e)}` };
    }
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

  // Re-scan prds/ folder and merge into queue.json. The `schedule:state`
  // handler already reconciles on read, but this gives the renderer an
  // explicit refresh path that also broadcasts so all views update.
  ipcMain.handle('schedule:rescan', async () => {
    const { added, removed } = await mutate(async (state) => {
      const before = new Set(state.jobs.map((j) => j.slug));
      await reconcile(state);
      const after = new Set(state.jobs.map((j) => j.slug));
      const added = [...after].filter((slug) => !before.has(slug)).length;
      const removed = [...before].filter((slug) => !after.has(slug)).length;
      return { added, removed };
    });
    await broadcast();
    let message;
    if (added === 0 && removed === 0) message = 'Rescanned — no new/removed PRD files';
    else if (added > 0 && removed === 0) message = `Rescanned — ${added} new PRD file(s) picked up`;
    else if (added === 0 && removed > 0) message = `Rescanned — ${removed} PRD file(s) removed from disk`;
    else message = `Rescanned — ${added} new PRD file(s) picked up, ${removed} removed from disk`;
    return { ok: true, kind: 'info', message };
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
      if (j.status !== 'running') continue;
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
      if (outcome === 'success') {
        // Job finished cleanly before the crash — keep the win.
        j.status = 'completed';
        j.exitCode = 0;
        j.error = null;
        j.finishedAt = new Date().toISOString();
        delete j.runtime;
        console.log(`[scheduler] boot reconcile: slug=${j.slug} outcome=success → completed`);
      } else if (outcome === 'failed') {
        // The log carries a real failure result event — a genuine failure, keep it.
        j.status = 'failed';
        j.exitCode = j.exitCode ?? 1;
        j.error = `orphaned: app restarted while running${killNote}`;
        j.finishedAt = new Date().toISOString();
        delete j.runtime;
        console.log(`[scheduler] boot reconcile: slug=${j.slug} outcome=failed → failed`);
      } else {
        // no_result / unknown: the run was interrupted (host died / app restarted)
        // with NO evidence it failed on its own merits. Punishing the PRD here is
        // the wrong call — it demands a manual flip and burns an Opus fix-plan on a
        // job that never actually failed. Re-queue it (bounded) so an app restart
        // self-recovers. Mirrors the transient-kill auto-retry on the live path.
        const tries = j.orphanRetries ?? 0;
        if (tries < ORPHAN_REQUEUE_CAP) {
          resetJobFields(j, `orphaned: app restarted mid-run, re-queued (attempt ${tries + 1}/${ORPHAN_REQUEUE_CAP})${killNote}`);
          j.orphanRetries = tries + 1;
          console.log(`[scheduler] boot reconcile: slug=${j.slug} outcome=${outcome} → re-queued (${tries + 1}/${ORPHAN_REQUEUE_CAP})`);
        } else {
          j.status = 'failed';
          j.exitCode = j.exitCode ?? 1;
          j.error = `orphaned: app restarted while running, exhausted ${ORPHAN_REQUEUE_CAP} re-queue attempts${killNote}`;
          j.finishedAt = new Date().toISOString();
          delete j.runtime;
          console.log(`[scheduler] boot reconcile: slug=${j.slug} outcome=${outcome} → failed (orphan retries exhausted)`);
        }
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
  rescheduleInterval = setInterval(() => {
    rescheduleTimer().catch(() => {});
    // Periodic self-heal: re-run the verifier over stale needs_review jobs so a
    // job whose work actually landed (committed in-window, no FAIL sentinel)
    // auto-clears WITHOUT waiting for the next app restart. Cheap-guarded — the
    // log scan only runs when something is actually flagged. Kill-switch:
    // SM_REVERIFY_PERIODIC_DISABLE=1 (boot reverify above stays always-on).
    // reverifyNeedsReview's auto-fix loop is capped downstream by
    // MAX_CONCURRENT_INVESTIGATIONS (spawnInvestigation queues/early-returns
    // past it), so this interval firing cannot fan out investigations.
    if (process.env.SM_REVERIFY_PERIODIC_DISABLE !== '1') {
      const s = readQueueSync();
      if (s.jobs.some((j) => j.status === 'needs_review')) {
        reverifyNeedsReview().catch(() => {});
      }
    }
  }, 10 * 60_000);

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
      pid: process.pid,
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
    return { ok: true, slug, status: 'pending' };
  },

  async listJobs() {
    const state = await readQueue();
    return state.jobs.map((j) => ({ slug: j.slug, title: j.title, status: j.status, cwd: j.cwd }));
  },

  // Exposes the module-level allocateParallelGroup (PRD 548) to callers that
  // only hold the `remote` object (adminServer.cjs's create-prd route) —
  // reuses the same allocator the file-based /develop authoring path relies
  // on implicitly, rather than re-deriving NN here.
  allocateParallelGroup,

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

module.exports = { registerScheduleHandlers, attachWindow, init, ROOT, PRDS_DIR, allocateParallelGroup, selectHistoryJobs, parsePorcelain, FINISH_PROTOCOL, remote, pickNextBatch, pickForProject, reapDeadRunningJobs, pollRecoveryClearSource, memoryLimitedBatchSize, availableForJobs, reverifyNeedsReview, isRescanCandidate, isPromotableOriginal, selectAutoFixTargets, isEligibleForImmediateAutoFix, resolveRunId, isUnresolvableNeedsReview, healTargetForFix, buildInvestigationPrompt, committedInWindow, isFixPlanSlug, isFixPlanBeyondDepthCap, MAX_INVESTIGATION_DEPTH, forceTickOutcome, applyPauseCleared, detectNetworkErrorInLog, detectRateLimitInLog, classifyFailureOutcome, TRANSIENT_RETRY_CAP };
