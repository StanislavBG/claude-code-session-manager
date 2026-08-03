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
 *   - 'schedule:state' broadcasts the full state on mutation. Keeps the
 *     panel UI dead simple — no diff machinery. Sends are trailing-edge
 *     debounced (~BROADCAST_COALESCE_MS) by default so a burst of mutations
 *     collapses into one push; state-machine transitions (pause/resume, job
 *     start/finish) call broadcast({ flush: true }) to bypass the window.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { ipcMain } = require('electron');
const billing = require('./usage.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const supervisor = require('./supervisor.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { readTail } = require('./lib/fileTail.cjs');
const { claudePidAlive, classifyRunOutcome, ORPHAN_REQUEUE_CAP } = require('./lib/reaperHelpers.cjs');
const { openLog, withChildAndLog } = require('./lib/childWithLog.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { createBroadcastCoalescer } = require('./lib/broadcastCoalescer.cjs');
const prdParser = require('./scheduler/prdParser.cjs');
const sessionsStore = require('./sessionsStore.cjs');
const { enqueueExternalPrompt } = require('./chatRunner.cjs');
const { appendResponseEventIfKnown } = require('./promptSessionEvents.cjs');
const promptSessionTranscript = require('./promptSessionTranscript.cjs');
const { verifyRun } = require('./runVerify.cjs');
const { latestTerminalOutcomeForSlug, COMPLETED_EQUIVALENT_VERDICTS } = require('./lib/terminalRunOutcome.cjs');
const logs = require('./logs.cjs');
const { schemas, validated } = require('./ipcSchemas.cjs');
const { readBody, sendJson } = require('./lib/localAdminHttp.cjs');
const {
  POLL_INTERVAL_MS,
  USAGE_REFRESH_INTERVAL_MS,
  MAX_JOB_DURATION_MS,
  BROADCAST_COALESCE_MS,
} = require('./lib/schedulerConfig.cjs');
const { pickForProject, pickNextBatch, DEFAULT_PROJECT_CWD } = require('./lib/schedulerBatch.cjs');
const { runDefinitionOfDoneOnDrain } = require('./lib/dodDrainHook.cjs');
const { writeRcaReport, extractRcaBlock } = require('./lib/rcaReport.cjs');
const queueHistory = require('./lib/queueHistory.cjs');
const queueOps = require('./queueOps.cjs');
// Feedback-auto-PRD sweep — formerly only run by the external scheduler-watchdog
// while the app was down (PRD 686 moved it in-app so it also runs while alive).
// Plain Node module, no Electron dependency; queuePath/prdsDir defaults already
// match ROOT/QUEUE_PATH below since both resolve the same ~/.claude/session-manager
// home-dir layout.
const { resolvePrdsDirs, resolveArchivedPrdsDirs, resolvePrdWriteDir, listEpicPrdDirs, listArchivedPrdDirs } = require('./lib/prdLocations.cjs');
const { ensureEpic, appendPrdCreatedEvent, readActiveIndex } = require('./lib/epicMint.cjs');
const { buildContextDigest } = require('./lib/epicContextDigest.cjs');

// ---------- origin session resolution (PRD 832) ----------
// An Epic IS a tagged claude session — job rows carry the originating
// claudeSessionId alongside sourcePromptId so every PRD stays traceable to
// the session that spawned it. active-index.json is tiny; a short TTL cache
// keeps reconcile (every 60s, N jobs) at one read per project per pass.
const originIndexCache = new Map(); // cwd -> { at, sessions }
const ORIGIN_CACHE_TTL_MS = 30_000;
function resolveOriginSessionId(cwd, epicId) {
  if (!cwd || !epicId) return null;
  let entry = originIndexCache.get(cwd);
  if (!entry || Date.now() - entry.at > ORIGIN_CACHE_TTL_MS) {
    entry = { at: Date.now(), sessions: readActiveIndex(cwd).sessions };
    originIndexCache.set(cwd, entry);
  }
  const session = entry.sessions[epicId];
  return session && typeof session.claudeSessionId === 'string' ? session.claudeSessionId : null;
}
const sessionSlots = require('./lib/sessionSlots.cjs');
const queueStore = require('./lib/queueStore.cjs');
const { splitFrontmatter } = require('./lib/prdFrontmatter.cjs');
const { migratePrds, consolidateFlatPrds } = require('./lib/prdMigration.cjs');
const { allProjectCwds } = require('../../scripts/lib/activeSessions.cjs');

// Captured once at module load so every run's meta sidecar can record how
// stale the running process is relative to on-disk source (incident: PRD
// 812-commit-guard-retry — the scheduler process was booted ~52 min before
// an exemption it should have applied landed on disk, and nothing in the
// run record showed that; this is the fix).
const SCHEDULER_BOOTED_AT = new Date().toISOString();
const SCHEDULER_CODE_SHA = (() => {
  try {
    return execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
})();

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
// Wider than RESULT_TAIL_BYTES (which only needs the subtype near the
// boundary) — a real `result` string can be a full paragraph, so
// extractResultTextFromLog scans more of the tail to find it whole.
const RESULT_TEXT_TAIL_BYTES = 64 * 1024;

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

// Best-effort `git fetch --all --prune` in cwd, bounded and never throwing.
// A PRD that does its work in a separate `git worktree add` checkout (per
// standards.md's own recommended pattern for shared repos) commits and pushes
// from THAT worktree, then removes it — the commit never touches job.cwd's
// own refs, so job.cwd's remote-tracking branches can be stale relative to
// what was actually pushed. Refreshing them here is what lets the git log
// --all scan below see a worktree-pushed commit. Resolves once fetch settles
// (or times out / errors) — callers don't need the result, just the refresh.
function fetchAllRefs(cwd) {
  return new Promise((resolve) => {
    if (!cwd) { resolve(); return; }
    execFile(
      'git',
      ['-C', cwd, 'fetch', '--all', '--prune'],
      { timeout: 20_000, windowsHide: true },
      () => resolve(),
    );
  });
}

// Returns true if ≥1 commit landed on any ref (branch, remote-tracking branch,
// or tag) in cwd between startedAt and finishedAt (with 60s slack) — not just
// the currently checked-out branch. Used both by the self-heal pass and by the
// live commit-guard's fallback (see computeCommittedDuringRun) to derive
// committedDuringRun from the recorded run window. Fetches remotes first (see
// fetchAllRefs) so a commit pushed from a separate worktree checkout that was
// since removed is still visible via job.cwd's remote-tracking refs. Never
// throws; git-unavailable → false (no override, job stays as-is).
async function committedInWindow(cwd, startedAt, finishedAt) {
  if (!cwd || !startedAt) return false;
  await fetchAllRefs(cwd);
  return new Promise((resolve) => {
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

// Live commit-guard: cheap HEAD-diff fast path, falling back to the
// git-log --all scan when HEAD didn't move on the starting branch. A PRD that
// checks out other branches, commits real work on each, then checks its
// starting branch back out before exit leaves HEAD unchanged even though
// commits landed — the fallback catches that case. Never throws.
//
// Both signals are known to race against ref/object visibility at the exact
// moment of process exit — a job that commits in a throwaway linked worktree
// and removes it before exiting can have committedInWindow() return false
// even though the commit is real and already pushed (confirmed incidents:
// pass-no-commit-worktree-commit-invisible-at-exit, RCA 770-pr269). When both
// signals say "no commit", wait a short bounded delay and retry once before
// giving up — a replayed identical call moments later reliably finds it.
const COMMIT_GUARD_RETRY_DELAY_MS = 2000;

async function computeCommittedDuringRun(cwd, headBefore, headAfter, startedAt, untilIso) {
  if (headBefore && headAfter && headBefore !== headAfter) return true;
  // Call via module.exports (not the bare local binding) so tests can
  // vi.spyOn(scheduler, 'committedInWindow') to drive the retry deterministically.
  if (await module.exports.committedInWindow(cwd, startedAt, untilIso)) return true;
  await new Promise((resolve) => { setTimeout(resolve, COMMIT_GUARD_RETRY_DELAY_MS); });
  return module.exports.committedInWindow(cwd, startedAt, untilIso);
}

/**
 * Override for a SIGTERM'd (143) run when a commit landed in its window.
 * Exit 143 alone doesn't prove the deliverable is missing — the 776/779
 * incidents (2026-07-30) both died on a headless-incompatible interactive
 * step (xvfb Electron screenshot / playwright electron.launch) AFTER their
 * commit had already landed, and sat `failed` forever with a real deliverable
 * on disk. A landed commit doesn't prove every AC line passed though (the
 * step it died on is still unverified), so this routes to `needs_review`,
 * never silently promotes to `completed`. Returns null for every other exit
 * code, or for a 143 with no commit found in window — those fall through to
 * the existing `failed` path unchanged. Pure/no I/O: the commit-window scan
 * (committedInWindow) happens at the call site, not here.
 */
function classifySigtermWithCommit(exitCode, commitFoundInWindow) {
  if (exitCode !== 143 || !commitFoundInWindow) return null;
  return {
    status: 'needs_review',
    reason: 'SIGTERM after a commit landed — verify AC before treating as done',
  };
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

// ---------- per-project PRD dir resolution (PRD 808) ----------
//
// PRDS_DIR above is now the LEGACY global dir — kept only as a migration
// source and a search fallback. Live PRDs resolve per-job to
// `<job.cwd>/session-manager-operations/scheduler/prds/` via prdLocations.cjs.

/**
 * Every PRD-source directory currently in play: the legacy global dir (still
 * searched so a not-yet-migrated file is never invisible) plus every active
 * project's own PRDs dir. Used by scans that enumerate PRDs across projects
 * (reconcile, list-prds, lint, rescan).
 */
function candidatePrdsDirs() {
  return [PRDS_DIR, ...resolvePrdsDirs()];
}

/**
 * Every `prds-archived/` dir across every project (the sibling-of-source
 * layout archiveCompletedPrd writes into — see that function's comment).
 * Used only by list-prds so the PRDs/Runs tabs can show an Epic's REAL
 * historical PRD count, not just its currently-pending one. Deliberately
 * excludes the flat legacy PRDS_ARCHIVE_DIR (manual `schedule:archive-prd`
 * timestamped-subdir layout) — that path is for a different, unused-by-
 * any-renderer manual archive flow, not Epic-scoped completion archiving.
 */
function candidateArchivedPrdsDirs() {
  return resolveArchivedPrdsDirs();
}

/**
 * Resolve an archived PRD's real terminal outcome for `schedule:list-prds`:
 * its live queue.json row (if the job hasn't aged out yet), else its
 * history.jsonl row, else 'completed' — archiveCompletedPrd only ever
 * archives a job whose effective status is 'completed' (a 'failed' job's
 * PRD source stays in the live prds/ dir), so 'completed' is a safe
 * default, not a guess; the live/history lookups are defensive in case
 * that archiving invariant ever changes. Exported as a pure function (no
 * IPC/fs) so this fallback chain is unit-testable without an Electron
 * harness.
 */
function resolveArchivedPrdStatus(slug, liveStatusBySlug, histBySlug) {
  const resolved = liveStatusBySlug.get(slug) ?? histBySlug.get(slug)?.status ?? 'completed';
  return resolved === 'failed' ? 'failed' : 'completed';
}

/** The PRD-source directory for a given job cwd (falls back to DEFAULT_PROJECT_CWD). */
function prdDirForCwd(cwd) {
  return resolvePrdWriteDir(cwd || DEFAULT_PROJECT_CWD);
}

/** Absolute path to `<job's project PRDs dir>/<job.slug>.md`. */
function prdPathForJob(job) {
  return path.join(prdDirForCwd(job && job.cwd), `${job && job.slug}.md`);
}

/**
 * Absolute path to a job's archived-twin `<slug>.md`. Resolves to the first
 * archive dir (across the flat legacy layout and every Epic's own sibling
 * archive — see listArchivedPrdDirs) that actually contains the slug, falling
 * back to the flat `prds-archived/<slug>.md` path when none do (this fallback
 * is only ever used for its string value — logging/note text in
 * prdArchivedSkipResult — never as an existence check).
 */
function archivedPrdPathForJob(job) {
  const slug = job && job.slug;
  const flatPath = path.join(prdDirForCwd(job && job.cwd), '..', 'prds-archived', `${slug}.md`);
  for (const dir of listArchivedPrdDirs((job && job.cwd) || DEFAULT_PROJECT_CWD)) {
    const candidate = safeSlugPathIn(dir, slug);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return flatPath;
}

/**
 * True if a job's PRD has already been archived — in the flat legacy
 * `prds-archived/` dir OR in the Epic-scoped sibling archive dir every new
 * PRD actually lands in (archiveCompletedPrd archives into the source PRD's
 * OWN parent's prds-archived/, which for an Epic PRD is inside that Epic).
 * A queue entry whose PRD moved to either is stale — the work already
 * shipped — not a genuine missing-PRD failure.
 */
async function archivedTwinExists(job) {
  const slug = job && job.slug;
  for (const dir of listArchivedPrdDirs((job && job.cwd) || DEFAULT_PROJECT_CWD)) {
    const candidate = safeSlugPathIn(dir, slug);
    if (!candidate) continue;
    try {
      await fsp.access(candidate);
      return true;
    } catch { /* not here — try the next archive dir */ }
  }
  return false;
}

/**
 * Build the non-failure result + run meta for a queued job whose PRD source
 * is gone. Shared by both PRD-read failure exits in executeJob so the
 * stale-skip logic isn't duplicated. Two reasons, both exitCode: 0 (no RCA
 * feedback item, since neither is a real work failure):
 *   - 'prd-archived': the source was archived — archivedTwinExists found it
 *     under a prds-archived/ dir. The work already shipped.
 *   - 'prd-missing': the source is gone everywhere (ENOENT on every
 *     candidate dir, no archived twin either) — most commonly a PRD that
 *     existed at enqueue time and was deleted before dispatch (e.g. a test
 *     fixture that leaked into the live queue and was cleaned up by its own
 *     `finally` block). Retire the row rather than fail it.
 */
function prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, reason = 'prd-archived') {
  const msg = reason === 'prd-missing'
    ? 'PRD source no longer exists on disk — retiring stale queue entry'
    : (() => {
        const archivedTwin = archivedPrdPathForJob(job);
        return `PRD already archived (${archivedTwin}) — work shipped; retiring stale queue entry`;
      })();
  safeLog(`[scheduler] ${msg}\n`);
  closeFd();
  const finishedAt = Date.now();
  config.writeJsonSync(metaPath, {
    slug: job.slug, cwd, sessionId, exitCode: 0, skipped: reason,
    note: msg, startedAt, finishedAt, durationMs: 0,
  });
  return { exitCode: 0, durationMs: 0, skipped: reason, note: msg, sessionId };
}

/**
 * Search every candidate PRD dir for `<slug>.md` (legacy dir first, then
 * each active project's dir). Returns the containing dir, or null if the
 * slug isn't found anywhere. Used by slug-only callers (IPC handlers) that
 * don't have a job's cwd on hand.
 */
async function findPrdDir(slug) {
  for (const dir of candidatePrdsDirs()) {
    try {
      await fsp.access(path.join(dir, `${slug}.md`));
      return dir;
    } catch { /* not here — try the next candidate dir */ }
  }
  return null;
}

/**
 * Resolve `<dir>/<slug>.md` for a directory already known to contain (or be
 * about to receive) the slug, and enforce path containment. Returns the
 * absolute path on success, null on slug-escape attempts. The zod schema
 * for slugs already blocks `..` because the SLUG_RE excludes `/`, but
 * defense-in-depth: a second containment check after path.resolve costs
 * nothing and catches future regex laxity.
 */
function safeSlugPathIn(dir, slug) {
  const resolved = path.resolve(path.join(dir, `${slug}.md`));
  if (!resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

/**
 * Locate an EXISTING `<slug>.md` across every candidate PRD dir and return
 * its safe, containment-checked absolute path — or null if the slug isn't
 * found anywhere (or would escape its containing dir).
 */
async function safeSlugPath(slug) {
  const dir = await findPrdDir(slug);
  if (!dir) return null;
  return safeSlugPathIn(dir, slug);
}

/**
 * Move a completed job's `<slug>.md` out of its PRD dir into that dir's
 * sibling `prds-archived/`, so a finished slug can't be re-fired by the
 * scheduler. Sibling-of-source (not the hard-coded legacy PRDS_ARCHIVE_DIR)
 * so a per-project PRD (`<cwd>/session-manager-operations/scheduler/prds/`)
 * archives into that SAME project's `prds-archived/`, not the global legacy
 * one — PRDS_ARCHIVE_DIR only happens to coincide with this for the legacy
 * PRDS_DIR. Mirrors the `schedule:clear-queue` archive logic (same
 * containment check). Non-throwing: a missing source file (already archived
 * or already gone) is a silent no-op, and any other error is logged as a
 * warning — an archive failure must never break job-completion bookkeeping.
 */
async function archiveCompletedPrd(slug, cwd) {
  try {
    const srcDir = (await findPrdDir(slug)) ?? prdDirForCwd(cwd);
    const src = safeSlugPathIn(srcDir, slug);
    if (!src) return;
    const archiveDir = path.join(srcDir, '..', 'prds-archived');
    await fsp.mkdir(archiveDir, { recursive: true });
    const dst = path.join(archiveDir, `${slug}.md`);
    await fsp.rename(src, dst);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'archiveCompletedPrd: rename failed', meta: { slug, error: e?.message } });
    }
  }
}

/**
 * Mark any still-runnable (pending/running) queue job for the given slugs as
 * completed. Called after a PRD's .md is manually archived (queueOps.cjs's
 * `schedule:archive-prd`) so a stale queue entry can never survive to fire
 * against a PRD that no longer exists in the live prds/ dir — the same
 * ENOENT-avoidance archivedTwinExists provides in executeJob, applied at the
 * archiving source instead of at fire-time. auto-archived slugs never need
 * this (selectAutoArchivable in queueOps.cjs only selects already-completed
 * jobs), so this is exercised only by the manual archive path.
 */
async function retireCompletedSlugs(slugs) {
  const list = Array.isArray(slugs) ? slugs.filter(Boolean) : [];
  if (list.length === 0) return;
  const slugSet = new Set(list);
  await mutate((s) => {
    for (const j of s.jobs) {
      if (!j || !slugSet.has(j.slug)) continue;
      if (j.status !== 'pending' && j.status !== 'running') continue;
      j.status = 'completed';
      j.finishedAt = new Date().toISOString();
      j.exitCode = 0;
      j.error = null;
      delete j.runtime;
    }
  });
  await broadcast({ flush: true });
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

/**
 * One-time, idempotent migration (PRD 808): move every PRD source .md file
 * still sitting in the legacy global PRDS_DIR into its own project's
 * `<cwd>/session-manager-operations/scheduler/prds/`, based on that PRD's
 * own frontmatter `cwd`. Runs at every boot — a no-op fs.readdir once
 * nothing is left to move. Files migratePrds couldn't resolve (missing/
 * unparseable cwd, cwd not on disk) are left in place and logged as a
 * warning — never silently dropped — so a human can fix the frontmatter.
 */
async function runPrdMigration() {
  let result;
  try {
    result = await migratePrds(PRDS_DIR);
  } catch (e) {
    logs.writeLine({ level: 'error', scope: 'scheduler', message: 'PRD migration failed', meta: { error: e?.message } });
    return null;
  }
  console.log(`[scheduler] PRD migration: moved ${result.moved}, skipped ${result.skipped}`);
  if (result.unresolved.length > 0) {
    logs.writeLine({
      level: 'warn',
      scope: 'scheduler',
      message: `PRD migration: ${result.unresolved.length} file(s) left in legacy dir`,
      meta: { legacyDir: PRDS_DIR, unresolved: result.unresolved },
    });
    for (const u of result.unresolved) {
      console.warn(`[scheduler] PRD migration: left ${u.file} in legacy dir (${u.reason})`);
    }
  }

  // Phase 2 (2026-07-31 domain-model decision): the flat per-project
  // `scheduler/prds/` dir is retired — new PRDs are epic-scoped, and anything
  // still sitting flat consolidates into `prds-archived/` for later special
  // processing. Queue rows for moved files are reaped by the archived-twin
  // retirement. Idempotent per project; failures are logged, never fatal.
  for (const cwd of allProjectCwds()) {
    try {
      const c = await consolidateFlatPrds(cwd);
      if (c.moved > 0) {
        console.log(`[scheduler] flat-PRD consolidation: archived ${c.moved} file(s) in ${cwd}`);
      }
      for (const f of c.failed) {
        logs.writeLine({
          level: 'warn', scope: 'scheduler',
          message: `flat-PRD consolidation: could not archive ${f.file}`,
          meta: { cwd, reason: f.reason },
        });
      }
    } catch (e) {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'flat-PRD consolidation failed', meta: { cwd, error: e?.message } });
    }
  }
  return result;
}

// Matches only numbered timestamp backups (queue.json.bak-<epoch>), not the
// bare `queue.json.bak` single-shot copy some older code paths left behind.
const QUEUE_BAK_RE = /^queue\.json\.bak-\d+$/;
const QUEUE_BAK_KEEP = 5;

/**
 * Sweeps accumulated queue.json.bak-<epoch> files down to the newest
 * QUEUE_BAK_KEEP, deleting the rest. Runs at boot. `entries` comes from
 * fs.readdir(ROOT), so every candidate path is already contained in ROOT.
 */
async function sweepQueueBackups() {
  let entries;
  try {
    entries = await fsp.readdir(ROOT);
  } catch {
    return;
  }
  const baks = entries.filter((f) => QUEUE_BAK_RE.test(f));
  if (baks.length <= QUEUE_BAK_KEEP) return;

  baks.sort((a, b) => {
    const ta = Number(a.slice('queue.json.bak-'.length));
    const tb = Number(b.slice('queue.json.bak-'.length));
    return tb - ta; // newest (largest epoch) first
  });
  const toDelete = baks.slice(QUEUE_BAK_KEEP);
  let removed = 0;
  for (const f of toDelete) {
    try {
      await fsp.unlink(path.join(ROOT, f));
      removed++;
    } catch (e) {
      console.warn('[scheduler] backup sweep: unlink failed', f, e?.message);
    }
  }
  if (removed > 0) {
    console.log(`[scheduler] backup sweep: removed ${removed} old queue.json.bak-* file(s), kept ${QUEUE_BAK_KEEP}`);
  }
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

// An empty queue and an unreadable queue are NOT the same thing, and
// conflating them is destructive: reconcile() treats every PRD .md with no
// matching jobs[] row as a brand-new goal and re-mints it as 'pending', so a
// single failed read that yields `jobs: []` re-queues the entire archive of
// already-completed work — then mutate() writes that empty array back and the
// real statuses are gone. (2026-07-31: 189 completed jobs resurrected and
// fired into an ENOENT retry storm.)
//
// So: a MISSING file is a legitimately empty queue (first boot). A file that
// exists but won't read or parse is `unreadable` — a poison state that must
// never reach reconcile() or writeQueue(). Callers get the flag, not a lie.
// (The single-file EMPTY_QUEUE/shapeQueue readers were retired with the
// global queue.json — queueStore.cjs's merged readers own the shape now.)

// Quarantine a corrupt shard alongside itself (once per process — the first
// copy is the one that matters; later ticks would just overwrite it with the
// same bytes) so a human can diff it against the .bak-* snapshots.
let quarantined = false;
function flagUnreadable(state) {
  if (!state.unreadable) return state;
  if (!quarantined && state.unreadablePath) {
    quarantined = true;
    try {
      fs.copyFileSync(state.unreadablePath, `${state.unreadablePath}.corrupt-${Date.now()}`);
    } catch { /* best-effort: the read already failed, the copy may too */ }
  }
  console.error(`[scheduler] queue state unreadable — refusing to treat as empty: ${state.unreadable}`);
  logs.writeLine({
    level: 'error', scope: 'scheduler',
    message: 'queue state unreadable — scheduling halted until it reads clean',
    meta: { path: state.unreadablePath, error: state.unreadable },
  });
  return state;
}

// Storage is FEDERATED (lib/queueStore.cjs, 2026-07-31): per-project job
// shards under `<cwd>/session-manager-operations/scheduler/state/queue.json`
// plus one machine-runtime file (config/paused/lastRunAt). Reads merge every
// shard into the single state object all downstream logic already expects;
// writes split it back. The old global scheduled-plans/queue.json is retired
// (split at boot by queueStore.migrateLegacyGlobalQueue).

// Sync queue read — passed to the supervisor module (which calls it from
// supervisorTick / applyAction with no await) and the heartbeat interval.
// IPC handlers and mutate() use readQueue (async) below.
function readQueueSync() {
  const s = queueStore.readMergedSync();
  s.config = { ...DEFAULT_CONFIG, ...(s.config || {}) };
  return flagUnreadable(s);
}

// Async queue read — used on all IPC hot paths. Reading queue.json sync was
// blocking the main thread inside ipcMain.handle callbacks; awaiting the
// shard reads hands control back to the renderer between files.
async function readQueue() {
  const s = await queueStore.readMerged();
  s.config = { ...DEFAULT_CONFIG, ...(s.config || {}) };
  return flagUnreadable(s);
}

async function writeQueue(state) {
  // Last line of defence: never persist a state derived from a failed read.
  if (state && state.unreadable) {
    throw new Error(`refusing to write queue state from an unreadable read (${state.unreadable})`);
  }
  ensureDirs();
  await queueStore.writeSplit(state, state.config?.defaultCwd ?? DEFAULT_PROJECT_CWD);
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
    // Bail BEFORE fn runs: a mutator handed an unreadable (therefore empty)
    // state would compute its result from a queue that isn't there, and
    // writeQueue would then persist that fiction over the real file.
    if (state.unreadable) {
      throw new Error(`queue mutation skipped: queue.json unreadable (${state.unreadable})`);
    }
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
// Aggregates every candidate PRD dir's files into one flat, sorted list.
// prdParser's dir-mtime cache is keyed per-dir internally by its own single
// mtime var, so scanning N dirs here costs N stat+readdir passes rather than
// one — acceptable: PRD counts per project are bounded (hundreds, not
// millions), and correctness across multiple project dirs matters more than
// preserving the single-dir cache's steady-state zero-read fast path.
async function listPrdFiles() {
  ensureDirs();
  const dirs = candidatePrdsDirs();
  const perDir = await Promise.all(dirs.map((dir) => prdParser.listPrdFiles(dir)));
  return perDir.flat().sort();
}

/**
 * Atomically mint a brand-new parallel-group NN for a PRD about to be
 * authored under the given project's own PRDs dir (falls back to
 * DEFAULT_PROJECT_CWD's dir when no cwd is supplied). See
 * prdParser.allocateParallelGroup for the collision-proof mechanics. Callers
 * wanting to join an EXISTING group (deliberate parallel siblings) skip this
 * and just reuse the NN prefix.
 */
async function allocateParallelGroup(cwd) {
  const dir = prdDirForCwd(cwd);
  await fsp.mkdir(dir, { recursive: true });
  // PRD 832: numbers are unique across the WHOLE project, not just the
  // allocator's bookkeeping dir — scan every Epic prds/ dir plus the
  // archive so a number used anywhere (even by a hand-authored or archived
  // PRD) is never reissued. The reservation markers + high-water sidecar
  // stay in `dir`; the cross-dir max only raises the floor.
  const targetCwd = cwd || DEFAULT_PROJECT_CWD;
  const extraDirs = [
    ...listEpicPrdDirs(targetCwd),
    path.join(prdDirForCwd(targetCwd), '..', 'prds-archived'),
  ];
  let extraFloor = 0;
  for (const d of extraDirs) {
    try {
      extraFloor = Math.max(extraFloor, await prdParser.maxParallelGroupInUse(d));
    } catch { /* missing dir — nothing allocated there */ }
  }
  return prdParser.allocateParallelGroup(dir, { extraFloor });
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
 * sourcePromptId backfill (PRD 830) is pending-only: a pending row always
 * takes the freshly-parsed value (explicit frontmatter, or the dir-derived
 * epic id parsePrd falls back to when frontmatter has none) since it hasn't
 * started executing yet. A running/completed row's sourcePromptId is left
 * exactly as it was minted at dispatch time — reconcile must not rewrite
 * linkage on work already in flight or finished.
 */
function reconcileSourcePromptId(job, parsedSourcePromptId) {
  return job.status === 'pending'
    ? (parsedSourcePromptId ?? job.sourcePromptId ?? null)
    : job.sourcePromptId;
}

/**
 * Walk prds/, ensure every .md has a queue entry. Drop entries whose .md
 * is gone. Refresh title/cwd/parallelGroup from disk every reconcile so
 * editing the .md after queueing is honored.
 *
 * Status is preserved: pending stays pending, completed stays completed.
 * Newly-discovered PRDs land as `pending`.
 */
// Epic ids already warned about (PRD-bearing but absent from
// active-index.json). Module-scoped so the warning is one line per Epic per
// process rather than one per 60s reconcile tick.
const warnedUnregisteredEpics = new Set();

async function reconcile(state) {
  // Defence in depth — tickQueue already gates on this, but reconcile is the
  // function that would do the damage (every unmatched PRD .md becomes a
  // fresh 'pending' row), so it refuses the poison state itself.
  if (state && state.unreadable) {
    throw new Error(`reconcile skipped: queue.json unreadable (${state.unreadable})`);
  }
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
  // Terminal (completed/failed) jobs whose .md vanished from disk BEFORE
  // their row ever crossed HISTORY_RETENTION_MS in partitionJobs — i.e. the
  // common case, since archiveCompletedPrd() (called right when a job
  // finishes, scheduler.cjs's `newlyCompletedPrds` handling) moves the PRD
  // file immediately, while partitionJobs' appendHistory only fires after 7
  // days. Bug found 2026-08-02: the old code below dropped these rows on the
  // very next reconcile() pass with NO history write at all — the file-gone
  // check couldn't tell "already recorded to history.jsonl on a prior pass"
  // apart from "never recorded anywhere", so a job that completed and had
  // its file auto-archived within minutes lost its history entirely. Both
  // Queue and History tabs then read as empty even for projects with real,
  // successfully-completed work. Collected here; reconciled against
  // historyTerminalBySlug() below and backfilled before being dropped.
  const terminalDroppedNeedingHistoryCheck = [];
  for (const job of state.jobs) {
    const p = onDisk.get(job.slug);
    if (!p) {
      // A terminal job whose .md is gone was archived on purpose — dropping
      // its row is the intended end of the auto-archive flow, PROVIDED it's
      // already durably recorded in history.jsonl (checked below).
      //
      // A PENDING or RUNNING job whose .md is merely not VISIBLE is a
      // different thing entirely, and dropping it destroys queued work: the
      // file may be unreadable, on a project whose dir failed to enumerate,
      // or mid-move. "I can't see it" is not "the user deleted it", so the
      // row survives — worst case it re-resolves on the next pass.
      if (job.status === 'pending' || job.status === 'running') {
        // Exception: a PENDING row whose PRD has an archived twin was
        // retired on purpose (work landed by other means — e.g. implemented
        // inline — and the source .md moved to prds-archived/). Keeping it
        // would show a phantom "scheduled" job forever; firing it would just
        // hit executeJob's archived-twin skip anyway. Running rows are left
        // alone — the reaper owns their lifecycle.
        if (job.status === 'pending' && (await archivedTwinExists(job))) {
          console.log(`[scheduler] reconcile: retiring pending job ${job.slug} — PRD already archived (work landed elsewhere)`);
          continue;
        }
        seen.add(job.slug);
        next.push({ ...job });
        console.warn(`[scheduler] reconcile: keeping ${job.status} job ${job.slug} — PRD source not visible in any candidate dir`);
      } else if (job.status === 'completed' || job.status === 'failed') {
        terminalDroppedNeedingHistoryCheck.push(job);
      }
      continue;
    }
    seen.add(job.slug);
    next.push({
      ...job,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      sourcePromptId: reconcileSourcePromptId(job, p.sourcePromptId),
      sourceTabId: p.sourceTabId,
      // Unlike sourcePromptId (frozen once a row leaves 'pending'), epicId is
      // refreshed from disk every pass: the PRD's directory IS its Epic
      // membership, so moving the file between Epic dirs must re-point the row.
      epicId: p.epicId ?? job.epicId ?? null,
      dependsOn: p.dependsOn,
      originSessionId: job.originSessionId
        ?? resolveOriginSessionId(p.cwd, p.epicId ?? reconcileSourcePromptId(job, p.sourcePromptId)),
      bodyPreview: p.body.split('\n').slice(0, 6).join('\n'),
    });
  }
  // Slugs on disk with no matching state.jobs row are normally brand-new
  // PRDs — but once queueHistory.partitionJobs (above, later this same
  // function) has been dropping terminal jobs into history.jsonl across
  // prior reconcile passes, an old completed/failed job's row can ALSO be
  // "unmatched" simply because it already left jobs[]. Without this check
  // it would get resurrected below as a fresh 'pending' entry and the
  // scheduler would genuinely re-execute an already-completed PRD — the
  // exact backlog this auto-archive feature exists to clean up. Only pay
  // the history lookup when there's actually an unmatched slug to resolve.
  const unmatchedSlugs = [];
  for (const [slug] of onDisk) {
    if (!seen.has(slug)) unmatchedSlugs.push(slug);
  }
  const historyBySlug = (unmatchedSlugs.length > 0 || terminalDroppedNeedingHistoryCheck.length > 0)
    ? await queueHistory.historyTerminalBySlug()
    : new Map();

  // Backfill: any terminal job dropped above whose slug isn't already in
  // history.jsonl gets written now, before its row is gone for good. This is
  // the fix for the bug described where the loop collects
  // terminalDroppedNeedingHistoryCheck — without it, a job whose PRD file was
  // auto-archived immediately on completion (the normal case) is lost from
  // both jobs[] and history.jsonl in the same reconcile pass.
  if (terminalDroppedNeedingHistoryCheck.length > 0) {
    const missing = terminalDroppedNeedingHistoryCheck.filter((j) => !historyBySlug.has(j.slug));
    if (missing.length > 0) {
      await queueHistory.appendHistory(missing);
      console.log(`[scheduler] reconcile: backfilled ${missing.length} completed/failed job(s) into history.jsonl (PRD file already archived, row about to drop)`);
    }
  }

  // Terminal-in-history slugs whose .md file is still on disk: fed into the
  // auto-archive selection pass below (as synthetic completed entries) so
  // their file can still be swept, without ever creating a live job row
  // for them (that row already exists, durably, in history.jsonl).
  const historyArchiveCandidates = [];

  // Cache active-index.json reads per cwd across this reconcile pass — many
  // unmatched PRDs typically share a project, and readActiveIndex is a
  // synchronous fs.readFileSync.
  const epicStatusCache = new Map(); // cwd -> { sessions }
  function epicStatus(cwd, epicId) {
    if (!cwd || !epicId) return null;
    let idx = epicStatusCache.get(cwd);
    if (!idx) {
      idx = readActiveIndex(cwd);
      epicStatusCache.set(cwd, idx);
    }
    return idx.sessions[epicId]?.status ?? null;
  }

  for (const [slug, p] of onDisk) {
    if (seen.has(slug)) continue;
    // Security gate: a PRD's file location IS its Epic membership
    // (prdLocations.deriveEpicIdFromPrdPath / p.epicId). Before this check,
    // the scheduler queued ANY .md file it found under an Epic's prds/ dir
    // regardless of that Epic's status or even whether it was ever properly
    // minted — so a PRD filed under a 'proposed' Epic (agent-proposed,
    // awaiting human Approve & start via EpicApprovalBar), or one dropped
    // straight onto disk under a directory that was never registered via
    // ensureEpic()/active-index.json at all (bypassing the app entirely),
    // would still execute as a claude -p job with --dangerously-skip-permissions.
    // Block ONLY an explicit 'proposed' — the actual human gate. The human's
    // Approve action flips status to 'active' (state/promptSessions.ts) and
    // the very next reconcile pass picks the PRD up with no other change.
    //
    // This deliberately does NOT require a positive 'active' registration.
    // That stricter form shipped briefly and caused a 6-hour silent outage
    // (2026-08-01): 23 real PRDs whose Epic dir existed on disk but had no
    // active-index.json entry were skipped forever with no log line, so the
    // scheduler looked simply dead. Absence of an entry is not evidence of a
    // rogue writer — an Epic archived on completion also leaves active-index,
    // and other paths can create the dir without registering it. Fail-closed
    // is right for the approval gate; it is wrong as a blanket requirement,
    // because the failure mode is invisible and unrecoverable by the user.
    const ownerStatus = epicStatus(p.cwd, p.epicId);
    if (p.epicId && ownerStatus === 'proposed') {
      continue;
    }
    // Unregistered Epic dir: allowed, but never silently — this is the only
    // signal that a PRD's Epic is missing from the index it should be in.
    if (p.epicId && ownerStatus === null && !warnedUnregisteredEpics.has(p.epicId)) {
      warnedUnregisteredEpics.add(p.epicId);
      console.warn(`[scheduler] epic ${p.epicId} (${p.cwd}) has PRDs on disk but no active-index.json entry — queuing anyway; register or archive it to silence this`);
    }
    const hist = historyBySlug.get(slug);
    if (hist) {
      if (hist.status === 'completed') {
        historyArchiveCandidates.push({ slug, status: hist.status, finishedAt: hist.finishedAt });
      }
      // 'failed' (or any other terminal status found in history) is left
      // alone entirely: not resurrected, not archived — matches "needs_
      // review and failed PRD files are NEVER auto-archived."
      continue;
    }
    // history.jsonl may not exist yet (nothing has crossed HISTORY_RETENTION_MS
    // since the feature shipped), which leaves historyBySlug empty and the
    // guard above inert. Fall back to reading the slug's own newest run
    // sidecars straight off disk — same "don't resurrect an already-terminal
    // slug" intent, independent of history.jsonl's existence.
    const fallback = latestTerminalOutcomeForSlug(slug, { runsDir: RUNS_DIR });
    if (fallback) {
      if (fallback.status === 'completed') {
        historyArchiveCandidates.push({ slug, status: fallback.status, finishedAt: fallback.finishedAt });
      }
      continue;
    }
    const entry = {
      slug,
      title: p.title,
      cwd: p.cwd,
      parallelGroup: p.parallelGroup,
      estimateMinutes: p.estimateMinutes,
      sourcePromptId: p.sourcePromptId,
      sourceTabId: p.sourceTabId,
      epicId: p.epicId ?? null,
      dependsOn: p.dependsOn,
      originSessionId: resolveOriginSessionId(p.cwd, p.epicId ?? p.sourcePromptId),
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
  const sorted = next.sort((a, b) => b.slug.localeCompare(a.slug));

  // Move terminal jobs past the retention window out to history.jsonl so
  // queue.json (mutation cost, broadcast payload, pickNextBatch scan) stays
  // small. Append BEFORE dropping so a crash between the two can't lose a
  // record — appendHistory dedupes by slug+runId, so a replay of the same
  // batch on next boot is a safe no-op.
  const nowMs = Date.now();
  const { hot, toArchive } = queueHistory.partitionJobs(sorted, nowMs);
  if (toArchive.length > 0) {
    await queueHistory.appendHistory(toArchive);
    console.log(`[scheduler] queue history: archived ${toArchive.length} job(s), jobs[] ${sorted.length} -> ${hot.length}`);
    state.jobs = hot;
  } else {
    state.jobs = sorted;
  }

  // Auto-archive completed PRDs' .md files out of the live prds/ dir. Runs
  // AFTER the history append above (which is awaited) so a job's queue row
  // is always durably in history.jsonl before its file can be moved — a
  // file is never removed ahead of its queue row. `sorted` (not `hot`) is
  // passed so a job that just crossed retention THIS pass is eligible for
  // file-archiving in the same pass, per its already-persisted history row.
  // `historyArchiveCandidates` adds slugs whose row left jobs[] on an
  // EARLIER pass (or before this feature shipped) — same predicate applies
  // via selectAutoArchivable, they just don't get a live job row.
  try {
    const archiveInput = historyArchiveCandidates.length > 0
      ? sorted.concat(historyArchiveCandidates)
      : sorted;
    const archiveResult = await queueOps.autoArchiveCompleted({ jobs: archiveInput }, { nowMs });
    if (archiveResult.archived > 0) {
      console.log(`[scheduler] auto-archived ${archiveResult.archived} completed PRD file(s) -> ${archiveResult.archivedTo}`);
    }
  } catch (e) {
    console.warn('[scheduler] autoArchiveCompleted failed', e?.message);
  }

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
// (The 5-minute feedback sweep that used to piggyback on this heartbeat is
// gone: it scanned each active project's session-manager-operations/feedback/
// and auto-queued a /process-feedback PRD. Both the folder and that skill are
// retired, and nothing auto-creates work any more — a parked job is surfaced
// back into the Epic that authored its PRD instead. See lib/rcaReport.cjs.)
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

// Last tickQueue outcome, kept for the UI. tickQueue already computes a precise
// reason for every way a batch can come back empty (dependency holds, slot
// exhaustion, the memory gate, pause, manual policy) and used to throw all of
// it into console.log — so the Home slot count read "5" while the queue was
// actually pinned at 1 with nothing on screen explaining why. This is that
// explanation, recorded once per tick and broadcast with the rest of the state.
let lastTick = null;
function recordTick(outcome, extra = {}) {
  lastTick = { ...outcome, ...extra, at: new Date().toISOString() };
  return outcome;
}

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
    lastTick,
    // The machine-wide slot pool IS the concurrency limit — there is no
    // separate scheduler cap any more. `source` distinguishes the
    // SM_SESSION_SLOTS env override from the persisted Home-tab value so the
    // UI can disable its own control when the env has taken over.
    effectiveConcurrency: (() => {
      const snap = sessionSlots.snapshot();
      return {
        cap: snap.total,
        free: Math.max(0, snap.total - snap.inUse),
        source: snap.envOverride ? 'env' : 'pool',
      };
    })(),
  };
  if (withPaths) {
    payload.paths = { root: ROOT, prds: PRDS_DIR, runs: RUNS_DIR, queue: queueStore.MACHINE_STATE_PATH };
  }
  return payload;
}

// Trailing-edge debounce for the `schedule:state` IPC push: a burst of
// broadcast() calls (boot reverify healing several rows, poll-loop refreshes,
// queue-linter fixups) arms one BROADCAST_COALESCE_MS timer and sends a
// single payload built fresh at fire time, instead of one full-payload push
// per mutation. Callers where latency matters (pause/resume, job
// start/finish/reap/reset) pass `{ flush: true }` to bypass the window and
// send immediately.
const broadcastCoalescer = createBroadcastCoalescer({
  delayMs: BROADCAST_COALESCE_MS,
  send: (payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    sendIfAlive(mainWindow, 'schedule:state', payload);
  },
  getPayload: async () => buildScheduleStatePayload(await readQueue()),
});

async function broadcast(opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const state = await readQueue();
  await reconcile(state);
  await writeQueue(state);
  if (opts.flush) {
    await broadcastCoalescer.flush();
  } else {
    broadcastCoalescer.schedule();
  }
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
  await broadcast({ flush: true });
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
  if (wasPaused) await broadcast({ flush: true });
}

/**
 * Mutate a job in place to "pending" with cleared run metadata.
 *
 * Refuses (no-ops, returns false) on a job already in a terminal success
 * state ('completed') unless opts.force is true — resetting a completed job
 * re-fires the PRD and re-executes already-shipped work (the false-failure
 * class PRD 812-workbench-review-nits-cleanup demonstrated: a completed job
 * was reset to pending and re-ran a correct no-op that then got flagged
 * needs_review). All internal call sites operate on jobs that are still
 * 'running'/'failed' at the point they call this, so the guard is a no-op
 * for them; only an external reset request (IPC/admin API) can target an
 * already-'completed' job, and that path is exactly what this guards.
 */
function resetJobFields(job, errorMsg, opts = {}) {
  if (job.status === 'completed' && opts.force !== true) return false;
  job.status = 'pending';
  job.runId = null;
  job.startedAt = null;
  job.finishedAt = null;
  job.exitCode = null;
  job.error = errorMsg ?? null;
  delete job.runtime;
  delete job.verifierVerdict;
  // Deliberately NOT deleting job.landedCommit: it must outlive a reset so a
  // re-fired run of this same slug can pass it to verifyRun as
  // priorLandedCommit (pass_no_commit_prior_run_verified exemption).
  return true;
}

// Grace period between a boot orphan's SIGTERM and reading its log to
// classify the outcome — matches killOrphanClaudePid's own internal 5s
// SIGKILL follow-up delay, plus a small margin so classification always runs
// after that SIGKILL has had a chance to land.
const BOOT_ORPHAN_KILL_GRACE_MS = 6000;

/**
 * partitionBootOrphans(jobs, isAlive?) → { immediate: string[], deferred: string[] }
 *
 * Pure decision split for boot reconciliation. A 'running' job whose recorded
 * pid is still alive must NOT be classified from its log yet — the orphaned
 * process may still be writing to it, so reading now risks misclassifying a
 * job that is about to emit result:success as no_result and double-running it.
 * Ported from reconcileQueueOffline's cross-tick escalation (see
 * scripts/lib/watchdogHelpers.cjs) — here it's a single deferred window since
 * this process stays up to revisit it, rather than a separate short-lived
 * watchdog process needing another tick.
 */
function partitionBootOrphans(jobs, isAlive = claudePidAlive) {
  const immediate = [];
  const deferred = [];
  for (const j of jobs) {
    if (j.status !== 'running') continue;
    const pid = j.runtime?.pid;
    if (pid && isAlive(pid)) {
      deferred.push(j.slug);
    } else {
      immediate.push(j.slug);
    }
  }
  return { immediate, deferred };
}

/**
 * applyOrphanOutcome(job, outcome, killNote?) → void
 *
 * Mutates `job` in place to finalize a boot-orphaned 'running' job given its
 * classified run outcome: success/failed finalize terminally; no_result/unknown
 * re-queues to pending bounded by ORPHAN_REQUEUE_CAP. The status-mutation
 * semantics (and the cap-exhaustion boundary) match the now-deleted
 * reconcileQueueOffline (scripts/lib/watchdogHelpers.cjs) verbatim; killNote
 * plumbing differs slightly (see call sites) since this path always knows
 * pid liveness up front rather than re-checking per tick.
 */
function applyOrphanOutcome(job, outcome, killNote = '') {
  const now = new Date().toISOString();
  if (outcome === 'success') {
    job.status = 'completed';
    job.exitCode = 0;
    job.error = null;
    job.finishedAt = now;
    delete job.runtime;
  } else if (outcome === 'failed') {
    job.status = 'failed';
    job.exitCode = job.exitCode ?? 1;
    job.error = `orphaned: app restarted while running${killNote}`;
    job.finishedAt = now;
    delete job.runtime;
  } else {
    const tries = job.orphanRetries ?? 0;
    if (tries < ORPHAN_REQUEUE_CAP) {
      resetJobFields(job, `orphaned: app restarted mid-run, re-queued (attempt ${tries + 1}/${ORPHAN_REQUEUE_CAP})${killNote}`);
      job.orphanRetries = tries + 1;
    } else {
      job.status = 'failed';
      job.exitCode = job.exitCode ?? 1;
      job.error = `orphaned: app restarted while running, exhausted ${ORPHAN_REQUEUE_CAP} re-queue attempts${killNote}`;
      job.finishedAt = now;
      delete job.runtime;
    }
  }
}

/**
 * isNotifiableTerminalStatus(effectiveStatus) → boolean
 *
 * Gates notifyOriginatingTab to true terminal transitions only: 'completed'
 * and 'failed'. Excludes 'needs_review' (not yet truly done — may still
 * auto-fix) and, implicitly, the rateLimited/paused-queue path, which never
 * reaches effectiveStatus computation at all (it takes the treatAsPending
 * branch in spawnJob and resets the job to pending instead).
 */
function isNotifiableTerminalStatus(effectiveStatus) {
  return effectiveStatus === 'completed' || effectiveStatus === 'failed';
}

/**
 * Scans a run log's tail for the last `{"type":"result",...}` JSONL event
 * (the claude harness's final message) and returns its `result` string, or
 * null if the log is missing, unreadable, or has no parseable result line.
 * Never throws — a missing/torn log must not break notifyOriginatingTab.
 */
function extractResultTextFromLog(logPath) {
  if (!logPath) return null;
  try {
    const tail = readTail(logPath, RESULT_TEXT_TAIL_BYTES);
    if (!tail) return null;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('"type":"result"')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.result === 'string') return parsed.result;
      } catch {
        // torn/partial line — keep scanning backward
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * resolveNotifyPrd(job, parsePrdRaw) → Promise<parsed PRD | null>
 *
 * Locate and parse a finishing job's PRD for the notification path, trying
 * the live Epic-scoped dir first (findPrdDir scans candidatePrdsDirs) and
 * then the archived twin (archivedPrdPathForJob scans listArchivedPrdDirs).
 *
 * Both lookups are required, and `prdPathForJob` is deliberately NOT used
 * here (PRD 985). It resolves to `resolvePrdWriteDir(cwd)` — the RETIRED
 * flat `<cwd>/session-manager-operations/scheduler/prds/` dir, which today
 * holds only zero-byte `.reserved-NNN` number stubs and no PRD at all, so it
 * ENOENT'd for every Epic-scoped PRD. On top of that, archiveCompletedPrd
 * renames the file into `prds-archived/` immediately BEFORE the notify call
 * (see tickQueue's newlyCompletedPrds loop), so even a correct live-dir
 * lookup finds nothing by the time we run. The net effect was that `prd`
 * was always null on the completed path: sourcePromptId never resolved, no
 * transcript turn was written, no response event was appended, and the
 * completed PRD silently never reported back to the Epic that authored it.
 * Verified live: PRDs 961/962/963/964/967 all completed 2026-08-03 and not
 * one response event landed on either authoring Epic's chain.
 *
 * Never throws — an unreadable/absent PRD returns null and each caller
 * falls back to the job's own `epicId`.
 */
async function resolveNotifyPrd(job, parsePrdRaw) {
  if (!job || !job.slug) return null;
  const liveDir = await findPrdDir(job.slug).catch(() => null);
  const livePath = liveDir ? safeSlugPathIn(liveDir, job.slug) : null;
  if (livePath) {
    const parsed = await parsePrdRaw(livePath).catch(() => null);
    if (parsed) return parsed;
  }
  const archivedPath = archivedPrdPathForJob(job);
  if (!archivedPath) return null;
  return await parsePrdRaw(archivedPath).catch(() => null);
}

/**
 * notifyOriginatingTab(job) → void
 *
 * On a true terminal transition (completed/failed — never the benign
 * rateLimited auto-pause, which resets the job to pending instead), publish
 * a short status notification for the PRD that queued this job.
 *
 * Resolution order (PRD 814, extended by PRD 854): (1) if the PRD's
 * `sourcePromptId` resolves to a known, still-active PromptSession (minted
 * for a dev-work dispatch, PRD 813) under the job's cwd, append a 'response'
 * PromptSessionEvent to THAT session's own event chain — its own scoped Epic
 * conversation (EpicDetail.tsx), not whatever tab happens to be active — and
 * stop; (2) otherwise, fall back to pushing a short status prompt via
 * enqueueExternalPrompt (PRD 753) at a target id resolved from, in order,
 * the PRD's own `sourceTabId` frontmatter, then `sourcePromptId` again (a PRD
 * dispatched straight from an Epic's composer, dispatchPromptSessionToPrd,
 * never sets sourceTabId — sourcePromptId IS the Epic id and is a valid
 * chat:external-send target too, which the renderer now resolves against
 * both open tabs and known Epics, refusing a completed one), then the first
 * open tab (per sessionsStore's persisted tabs.json) whose cwd matches the
 * job's cwd — first match only, no fan-out to multiple matching tabs; (3)
 * no-op. The cwd-match step only runs when NEITHER sourceTabId nor
 * sourcePromptId is present in frontmatter at all — `sendPrompt` (
 * enqueueExternalPrompt) is fire-and-forget IPC with no ack, so once step
 * (2) picks either id it is not retried even if the renderer can't resolve
 * it either (e.g. a stale/garbage id) — same non-guaranteed-delivery
 * tradeoff this function already accepted for sourceTabId pre-PRD-854.
 * Never throws to the caller (fire-and-forget from spawnJob). Deps are
 * injectable (mirrors partitionBootOrphans's isAlive param) so unit tests
 * can exercise the resolution logic without touching disk/electron.
 */
async function notifyOriginatingTab(job, {
  parsePrdRaw = prdParser.parsePrdRaw,
  loadSessions = sessionsStore.load,
  sendPrompt = enqueueExternalPrompt,
  appendResponseEvent = appendResponseEventIfKnown,
  appendTranscriptTurn = promptSessionTranscript.appendTurn,
  readResultFromLog = extractResultTextFromLog,
} = {}) {
  try {
    const prdPath = prdPathForJob(job);
    const prd = await parsePrdRaw(prdPath).catch(() => null);
    const message = `PRD ${job.slug} finished: ${job.status}. Check Scheduler for details.`;

    // Persist the job's real result text (not just the short status chip
    // above) to the durable per-Epic transcript, keyed off whichever id
    // notifyOriginatingTab would otherwise notify. Best-effort: a missing
    // cwd/epic id, an unreadable run log, or an IPC error here must never
    // block the notification below.
    const epicIdForTranscript = prd?.sourcePromptId || prd?.sourceTabId || null;
    if (epicIdForTranscript && job.cwd) {
      try {
        const logPath = job.runId ? path.join(RUNS_DIR, job.runId, `${job.slug}.log`) : null;
        const resultText = readResultFromLog(logPath);
        await appendTranscriptTurn(job.cwd, epicIdForTranscript, {
          role: 'assistant',
          text: resultText || message,
        });
      } catch (e) {
        console.error('[scheduler] notifyOriginatingTab transcript append error', job?.slug, e);
      }
    }

    if (prd?.sourcePromptId) {
      const routed = await appendResponseEvent(job.cwd || null, prd.sourcePromptId, message, {
        prdSlug: job.slug,
        outcome: job.status,
      }).catch((e) => {
        console.error('[scheduler] notifyOriginatingTab appendResponseEvent error', job?.slug, e);
        return false;
      });
      if (routed) return;
    }

    // appendResponseEvent already refused above (unknown id, completed
    // Epic, or disk error) — the sourcePromptId fallback below re-sends to
    // the SAME id via chat:external-send, which the renderer independently
    // re-checks against its own live PromptSession store. Deliberate
    // defense-in-depth (main's disk-backed check vs. the renderer's
    // in-memory one can disagree/race), not a redundant duplicate to prune.
    let targetTabId = prd?.sourceTabId || prd?.sourcePromptId || null;
    if (!targetTabId) {
      const jobCwd = job.cwd || null;
      if (jobCwd) {
        const { tabs } = await loadSessions();
        const match = (tabs || []).find((t) => t && t.cwd === jobCwd);
        targetTabId = match?.id || null;
      }
    }
    if (!targetTabId) {
      console.log(`[scheduler] notifyOriginatingTab: no open tab and no Epic for ${job.slug}, skipping`);
      return;
    }

    sendPrompt(targetTabId, message);
  } catch (e) {
    console.error('[scheduler] notifyOriginatingTab error', job?.slug, e);
  }
}

/**
 * notifyNeedsReview(job, report) → Promise<boolean>
 *
 * A job parked in `needs_review` is a question, not a result: something about
 * the PRD was unclear, unverifiable, or ran past its acceptance criteria.
 * That question belongs in the conversation that WROTE the PRD, so this
 * appends a 'response' event to the authoring Epic's own chain (the same
 * channel notifyOriginatingTab uses for completed/failed, which deliberately
 * excludes needs_review — isNotifiableTerminalStatus). It resolves the Epic
 * from the PRD's `sourcePromptId`, falling back to the job's own `epicId`.
 *
 * Join-only by construction: appendResponseEventIfKnown refuses an unknown or
 * non-active session and returns false. Nothing here can create an Epic — if
 * no open authoring Epic exists, the root-cause report in the run directory
 * is the whole record and the Scheduler tab is where it surfaces.
 */
async function notifyNeedsReview(job, report, {
  parsePrdRaw = prdParser.parsePrdRaw,
  appendResponseEvent = appendResponseEventIfKnown,
} = {}) {
  try {
    if (!job || !report || !report.filed) return false;
    const prd = await parsePrdRaw(prdPathForJob(job)).catch(() => null);
    const epicId = prd?.sourcePromptId || job.epicId || null;
    if (!epicId || !job.cwd) {
      console.log(`[scheduler] notifyNeedsReview: no authoring Epic for ${job.slug}, report only`);
      return false;
    }
    const message = `${report.summary}. Root-cause report: ${report.path}`;
    return await appendResponseEvent(job.cwd, epicId, message, { prdSlug: job.slug, outcome: 'needs_review' });
  } catch (e) {
    console.error('[scheduler] notifyNeedsReview error', job?.slug, e);
    return false;
  }
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

/**
 * Commit-guard verdict decision. Pure/no I/O so the false-positive defenses
 * can be unit-tested directly rather than only through a live spawnJob run.
 * Returns the flagged verifyResult replacement, or null if the guard should
 * not fire (any of the four defenses applies).
 *
 * The fourth defense (legitimateNoOp) exists because runVerify.cjs's own
 * pass_no_commit exemptions (COMPLETED_EQUIVALENT_VERDICTS members like
 * pass_no_commit_already_shipped) already independently proved a truthful
 * PASS-with-no-commit is correct; without this check the commit-guard
 * double-punishes that same honest no-op for dirt a concurrent interactive
 * session left behind (incidents: 655-needs-review-rca-feedback-hook,
 * 672-fix-feedback-session-manager, 2026-07-31).
 */
function commitGuardVerdict({ newlyDirty, siblingRunning, jobSelfCommitted, legitimateNoOp, verifyResult }) {
  if (!newlyDirty || newlyDirty.length === 0) return null;
  if (siblingRunning || jobSelfCommitted || legitimateNoOp) return null;
  const sample = newlyDirty.slice(0, 3).join(', ');
  const carried = [...(verifyResult?.annotations ?? [])];
  if (verifyResult && verifyResult.verdict !== 'clean') {
    carried.push({ verdict: verifyResult.verdict, reason: verifyResult.reason });
  }
  return {
    verdict: 'uncommitted_changes',
    reason: `finish protocol incomplete: ${newlyDirty.length} uncommitted file(s) left in working tree (e.g. ${sample})`,
    downgradeTo: 'needs_review',
    annotations: carried.length ? carried : undefined,
  };
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
  // Resolve through findPrdDir's full candidate search (legacy flat dir +
  // every project's Epic-scoped dirs) first, so the common case — a live
  // Epic-scoped PRD — is a first-try hit instead of probing the retired flat
  // dir and only then falling back.
  let prompt;
  const resolvedDir = await findPrdDir(job.slug);
  let prdPath = resolvedDir ? path.join(resolvedDir, `${job.slug}.md`) : prdPathForJob(job);
  try {
    const parsed = await parsePrd(prdPath);
    // Centrally enforce the review → security-review → verify → commit finish
    // sequence on every job, regardless of what the PRD body says.
    prompt = parsed.body + FINISH_PROTOCOL;
  } catch (e) {
    // The project-scoped dir isn't the only place a PRD source can live — a
    // writer that hasn't migrated to prdLocations.cjs yet (or a not-yet-run
    // boot migration) can leave it in the legacy global dir. Fall back to
    // findPrdDir's full candidate search before failing the job outright.
    const fallbackDir = await findPrdDir(job.slug);
    if (fallbackDir) {
      const fallbackPath = path.join(fallbackDir, `${job.slug}.md`);
      safeLog(`[scheduler] PRD not in project dir; found ${job.slug}.md in ${fallbackDir}\n`);
      try {
        const parsed = await parsePrd(fallbackPath);
        prompt = parsed.body + FINISH_PROTOCOL;
        prdPath = fallbackPath;
      } catch (e2) {
        // Found the dir a moment ago but the read still failed. Case A: the
        // source has since been archived — stale-skip as usual. Case B: it
        // was deleted out from under us in the window between findPrdDir and
        // parsePrd (ENOENT) with no archived twin — also a stale row, not a
        // real failure. Anything else (malformed/unreadable PRD) is a real
        // failure and keeps exitCode: -1.
        if (await archivedTwinExists(job)) {
          return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-archived');
        }
        if (e2 && e2.code === 'ENOENT') {
          return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-missing');
        }
        safeLog(`[scheduler] failed to read PRD: ${e2?.message}\n`);
        closeFd();
        return { exitCode: -1, durationMs: 0, error: e2?.message };
      }
    } else {
      // No candidate dir has the slug at all. Case A: it was archived —
      // stale-skip. Case B: the read error is ENOENT (the common case: a
      // source that existed at enqueue time and is gone by dispatch, e.g. a
      // leaked test fixture) with no archived twin — retire as stale rather
      // than a hard failure. Anything else (a real read/parse error) still
      // fails the job.
      if (await archivedTwinExists(job)) {
        return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-archived');
      }
      if (e && e.code === 'ENOENT') {
        return prdArchivedSkipResult(job, cwd, sessionId, startedAt, safeLog, closeFd, metaPath, 'prd-missing');
      }
      safeLog(`[scheduler] failed to read PRD: ${e?.message}\n`);
      closeFd();
      return { exitCode: -1, durationMs: 0, error: e?.message };
    }
  }

  // Prepend the Epic's own session digest (PRD 950/958) when this job traces
  // back to a known Epic — additive only, never mutates the PRD body itself.
  // A missing/unresolved epicId or a digest build failure is a silent no-op:
  // the PRD's own body must remain sufficient to complete the job on its own.
  const digestEpicId = job.epicId ?? job.sourcePromptId ?? null;
  const originSessionId = resolveOriginSessionId(cwd, digestEpicId);
  let contextDigestApplied = false;
  if (originSessionId) {
    try {
      const digestText = await buildContextDigest({ cwd, epicId: digestEpicId });
      if (digestText) {
        prompt = digestText + '\n\n' + prompt;
        contextDigestApplied = true;
      }
    } catch (e) {
      safeLog(`[scheduler] context digest build failed (job still dispatches without it): ${e?.message ?? e}\n`);
    }
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
          config.writeJsonSync(metaPath, { slug: job.slug, cwd, sessionId, exitCode: -1, error: errMsg, startedAt, finishedAt: Date.now(), durationMs, schedulerBootedAt: SCHEDULER_BOOTED_AT, schedulerCodeSha: SCHEDULER_CODE_SHA, originSessionId, contextDigestApplied });
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
          schedulerBootedAt: SCHEDULER_BOOTED_AT, schedulerCodeSha: SCHEDULER_CODE_SHA,
          originSessionId, contextDigestApplied,
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
3.5. Before writing the fix-plan PRD file, print a block summarizing the root
   cause in 15 lines or fewer, in exactly this form (plain text between the
   tags, no markdown fences):

   <RCA>
   <your root-cause summary here>
   </RCA>

   This is parsed out of your transcript and folded into the RCA feedback item
   already filed for this job, so it must stand alone (the reader won't have
   your reasoning, only this block).
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
 * Pure predicate: a run whose meta.json shows a clean exit (exitCode 0) and
 * whose verdicts.json verdict is completed-equivalent (clean / the
 * pass_no_commit exemptions) has nothing left to diagnose — spawning an
 * Opus investigation for it just manufactures a depth+1 fix-of-a-fix PRD for
 * already-shipped work. Any missing/malformed input is treated as "don't
 * skip" (fail-open: never let a missing artifact suppress a real
 * investigation). Exported for tests.
 */
function shouldSkipInvestigationForCleanRun({ meta, verdicts }) {
  if (!meta || meta.exitCode !== 0) return false;
  if (!verdicts || !COMPLETED_EQUIVALENT_VERDICTS.has(verdicts.verdict)) return false;
  return true;
}

/**
 * Reads <runDir>/<slug>.meta.json + <slug>.verdicts.json off disk for the
 * shouldSkipInvestigationForCleanRun guard. Fails safe to {} on any read/parse
 * error (never suppresses an investigation on a missing artifact).
 */
function readRunOutcomeSidecars(runDir, slug) {
  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  };
  return {
    meta: readJson(path.join(runDir, `${slug}.meta.json`)),
    verdicts: readJson(path.join(runDir, `${slug}.verdicts.json`)),
  };
}

/**
 * Spawn an Opus investigation session for a failed job. The investigator's job
 * is to read the failure log + original PRD, identify the root cause, and write
 * a fix-plan PRD into prds/<NN>-fix-<base>.md. Reconcile picks it up; the next
 * Sonnet slot fires it. Investigations themselves are NOT queue entries — they
 * run out-of-band, so they don't consume the concurrency cap. They DO consume
 * tokens, which the when-available throttle will reflect on the next poll.
 *
 * Skipped if the failed job is itself a fix-plan (avoids infinite recursion),
 * or if the run being investigated actually verified clean (nothing to fix —
 * see shouldSkipInvestigationForCleanRun).
 */
async function spawnInvestigation(failedJob, runDir) {
  if (isFixPlanBeyondDepthCap(failedJob.slug, failedJob.investigationDepth)) {
    console.log(`[scheduler] skip investigation: ${failedJob.slug} is a fix plan at/beyond depth cap (depth=${failedJob.investigationDepth ?? 'none'})`);
    return { deferred: false };
  }
  {
    const { meta, verdicts } = readRunOutcomeSidecars(runDir, failedJob.slug);
    if (shouldSkipInvestigationForCleanRun({ meta, verdicts })) {
      console.log(`[scheduler] skip investigation: ${failedJob.slug} last run verified ${verdicts.verdict} (exit 0) — nothing to diagnose`);
      return { deferred: false };
    }
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
    originalBody = (await parsePrd(prdPathForJob(failedJob))).body;
  } catch {
    originalBody = failedJob.bodyPreview || '(original PRD missing from disk)';
  }

  const logTail = readTail(failedLogPath, 16 * 1024) || '(failed to read log)';

  const baseSlug = failedJob.slug.replace(/^\d+-/, '');
  const group = failedJob.parallelGroup ?? 99;
  const fixSlug = `${String(group).padStart(2, '0')}-fix-${baseSlug}`;
  const fixPath = path.join(prdDirForCwd(failedJob.cwd), `${fixSlug}.md`);

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

  // Mark the job 'investigating' so the Queue UI shows an active status for
  // the whole probe duration — previously this left the job's persisted
  // status frozen at 'failed'/'needs_review' the entire time, which read as
  // "nothing is happening" even though an Opus process was actively running.
  await mutate((s) => {
    const j = s.jobs.find((x) => x.slug === failedJob.slug);
    if (j) j.status = 'investigating';
  });
  await broadcast({ flush: true });

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
      // Restore the pre-investigation status now that the probe has exited —
      // 'investigating' must never be the job's resting state.
      mutate((s) => {
        const j = s.jobs.find((x) => x.slug === failedJob.slug);
        if (j && j.status === 'investigating') j.status = failedJob.status || 'failed';
      })
        .then(() => broadcast({ flush: true }))
        .catch(() => {});
      if (error) {
        const errMsg = spawnFailed
          ? `investigation spawn failed: ${error?.message ?? String(error)}`
          : `investigation error: ${error.message}`;
        sl(`\n[scheduler] ${errMsg}\n`);
        return;
      }
      sl(`\n[scheduler] investigation exit code=${exitCode}\n`);
      // Fold the investigation's <RCA> summary into the root-cause report already
      // written for this job (needs_review jobs only — writeRcaReport no-ops when
      // failedJob has no verifierVerdict, e.g. plain 'failed' jobs never got one).
      const investigationText = extractRcaBlock(readTail(investigationLogPath, 64 * 1024));
      if (investigationText) {
        writeRcaReport({
          job: failedJob,
          runDir,
          verdict: failedJob.verifierVerdict,
          annotations: failedJob.verifierAnnotations,
          investigationText,
        }).catch((e) => {
          console.error('[scheduler] writeRcaReport (investigation enrichment) error', failedJob.slug, e);
        });
      }
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
    // openLog failure, spawn setup) must not strand the reserved slot, and must
    // not strand the job on the transient 'investigating' status either.
    releaseSlot();
    mutate((s) => {
      const j = s.jobs.find((x) => x.slug === failedJob.slug);
      if (j && j.status === 'investigating') j.status = failedJob.status || 'failed';
    })
      .then(() => broadcast({ flush: true }))
      .catch(() => {});
    throw e;
  }
}

async function spawnJob(job, runId, runDir, defaultCwd) {
  // Session-Manager owns the machine-wide `claude -p` pool (sessionSlots.cjs)
  // — the scheduler REQUESTS capacity, it doesn't own a private cap. A miss
  // leaves the job pending; the next tick retries when a slot frees up.
  const slotToken = sessionSlots.acquire(`scheduler:${job.slug}`);
  if (!slotToken) {
    console.log(`[scheduler] no session slot free for ${job.slug} — deferring (${JSON.stringify(sessionSlots.snapshot().holders.map((h) => h.owner))})`);
    return;
  }
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
    await broadcast({ flush: true });

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
      await broadcast({ flush: true });
    });

    if (res.rateLimited) {
      const resetIso = await refreshNextReset().catch(() => cachedNextReset);
      await setPaused('rate_limit', resetIso);
    }

    // Stale queue entry: the PRD already shipped and was archived before this
    // run fired (see archivedTwinExists in executeJob). Treat it as a plain
    // completion — no verify pass, no commit guard, no RCA feedback — since
    // there is no real transcript/commit to check.
    if (res.skipped === 'prd-archived') {
      await mutate((s) => {
        const idx = s.jobs.findIndex((x) => x.slug === job.slug);
        if (idx >= 0) {
          s.jobs[idx].status = 'completed';
          s.jobs[idx].finishedAt = new Date().toISOString();
          s.jobs[idx].exitCode = 0;
          s.jobs[idx].error = null;
          delete s.jobs[idx].runtime;
        }
      });
      await broadcast({ flush: true });
      return;
    }

    // Post-run verification: for exit=0 runs, scan the transcript and check
    // dependency prerequisites before stamping 'completed'. This catches the
    // false-positive class where an agent exits cleanly while leaving failures
    // in its tool output (see incidents: PRD 39, 44, 56 on 2026-05-23→24).
    // Called outside mutate() so the queue lock is not held during I/O.
    let verifyResult = null;
    // Persisted onto the job row (see the mutate() block below) whenever
    // this run's own HEAD advances, so a LATER re-fire of the same slug can
    // pass it back into verifyRun as priorLandedCommit (see the
    // pass_no_commit_prior_run_verified exemption in runVerify.cjs).
    let jobLandedCommitThisRun = null;
    if (res.exitCode === 0 && !res.rateLimited) {
      // Detect whether the job self-committed by comparing HEAD before/after.
      // Used by the sentinel override: SCHEDULER_VERDICT: PASS + a landed
      // commit together override incidental transcript noise verdicts.
      const headAtExit = await gitHead(guardCwd);
      const committedDuringRun = await computeCommittedDuringRun(
        guardCwd,
        guardHeadBefore,
        headAtExit,
        job.startedAt,
        new Date().toISOString(),
      );
      if (guardHeadBefore && headAtExit && headAtExit !== guardHeadBefore) {
        jobLandedCommitThisRun = headAtExit;
      }

      const prdPath = prdPathForJob(job);
      const stateForDeps = await readQueue();
      // priorLandedCommit: the commit a PREVIOUS run of this same slug landed,
      // if any — prefer the live jobs[] row (survives a resetJob, see
      // resetJobFields), fall back to history.jsonl for a slug that already
      // left jobs[]. Never the commit THIS run just made (committedDuringRun
      // already covers that case).
      const liveRow = stateForDeps.jobs.find((j) => j.slug === job.slug);
      let priorLandedCommit = liveRow?.landedCommit ?? null;
      if (!priorLandedCommit) {
        const hist = await queueHistory.historyTerminalBySlug().catch(() => null);
        priorLandedCommit = hist?.get(job.slug)?.landedCommit ?? null;
      }
      verifyResult = await verifyRun({
        runDir,
        prdPath,
        queueEntry: job,
        allJobs: stateForDeps.jobs,
        committedDuringRun,
        priorLandedCommit,
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
    //   - legitimate-no-op skip: if the verifier already independently proved
    //     this run's PASS-with-no-commit is truthful (verdict is one of
    //     COMPLETED_EQUIVALENT_VERDICTS — pass_no_commit_target_verified,
    //     _prior_run_verified, _already_shipped), the run itself did nothing
    //     wrong; dirt left by a concurrent interactive session (e.g.
    //     /process-feedback writing new PRD .md files into the same repo
    //     while this job's own AC turned out to already be satisfied) is not
    //     this job's unfinished work. Without this skip, runVerify.cjs's
    //     exemption and this guard double-punish the same honest no-op from
    //     two different code paths (incidents: 655-needs-review-rca-feedback-hook,
    //     672-fix-feedback-session-manager, 2026-07-31).
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
    const guardIsLegitimateNoOp = verifyResult && COMPLETED_EQUIVALENT_VERDICTS.has(verifyResult.verdict);
    if (res.exitCode === 0 && !res.rateLimited && !guardWillRefire && !guardIsLegitimateNoOp) {
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
        const guardVerdict = commitGuardVerdict({
          newlyDirty,
          siblingRunning,
          jobSelfCommitted,
          legitimateNoOp: guardIsLegitimateNoOp,
          verifyResult,
        });
        if (guardVerdict) {
          verifyResult = guardVerdict;
          console.log(`[scheduler] commit-guard: ${job.slug} left ${newlyDirty.length} files uncommitted → needs_review`);
        }
      }
    }

    // SIGTERM commit check: reuse the same commit-window scan the exit=0
    // guard uses above (one commit-detection path, not two) to see whether a
    // 143 (SIGTERM) run still landed a deliverable before it died. Scoped
    // narrowly to exit 143 — never applied to other non-zero exit codes or to
    // rateLimited (already handled separately, above).
    let sigtermCommitFound = false;
    if (res.exitCode === 143 && !res.rateLimited) {
      const guardHeadAtSigterm = await gitHead(guardCwd);
      sigtermCommitFound = await computeCommittedDuringRun(
        guardCwd,
        guardHeadBefore,
        guardHeadAtSigterm,
        job.startedAt,
        new Date().toISOString(),
      );
    }

    let actuallyFailed = false;
    let failedJobSnapshot = null;
    let needsInvestigationNow = false;
    let investigationJobSnapshot = null;
    let needsReviewRcaSnapshot = null;
    let terminalNotifySnapshot = null;
    const newlyCompletedPrds = [];
    await mutate((s) => {
      const i2 = s.jobs.findIndex((x) => x.slug === job.slug);
      if (i2 >= 0) {
        const treatAsPending = res.rateLimited || (s.paused && s.paused.reason === 'rate_limit');
        if (treatAsPending) {
          resetJobFields(s.jobs[i2], res.rateLimited ? 'paused: rate limit' : 'paused: queue halted');
        } else {
          // Determine effective status, applying the verifier verdict for exit=0 runs.
          let effectiveStatus;
          let sigtermOverrideReason = null;
          const sigtermOverride = res.exitCode !== 0
            ? classifySigtermWithCommit(res.exitCode, sigtermCommitFound)
            : null;
          if (sigtermOverride) {
            effectiveStatus = sigtermOverride.status;
            sigtermOverrideReason = sigtermOverride.reason;
          } else if (res.exitCode !== 0) {
            effectiveStatus = 'failed';
          } else if (
            !verifyResult
            || COMPLETED_EQUIVALENT_VERDICTS.has(verifyResult.verdict)
          ) {
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
            ? (verifyResult?.reason ?? sigtermOverrideReason ?? null)
            : (res.error || null);
          // Persist the commit THIS run landed (if HEAD advanced) so a later
          // re-fire of the same slug can prove its own no-op re-run is
          // truthful via the pass_no_commit_prior_run_verified exemption.
          // Survives resetJobFields — see that function's comment.
          if (jobLandedCommitThisRun) {
            s.jobs[i2].landedCommit = jobLandedCommitThisRun;
          }
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

          if (isNotifiableTerminalStatus(effectiveStatus)) {
            terminalNotifySnapshot = { ...s.jobs[i2] };
          }
          if (effectiveStatus === 'completed') {
            newlyCompletedPrds.push({ slug: s.jobs[i2].slug, cwd: s.jobs[i2].cwd });
          }
          if (effectiveStatus === 'failed') {
            actuallyFailed = true;
            failedJobSnapshot = { ...s.jobs[i2] };
          } else if (effectiveStatus === 'needs_review') {
            // Snapshot for the RCA feedback hook (fired outside mutate(), below).
            // Every needs_review transition gets an RCA — including uncommitted_changes,
            // the least self-healing verdict — but never a rate-limit pause (that
            // takes the treatAsPending branch above and never reaches here).
            needsReviewRcaSnapshot = { ...s.jobs[i2] };

            // Same-tick auto-fix (feedback 2026-07-12): rather than waiting up to
            // 10 min for reverifyNeedsReview()'s periodic pass, check right here
            // whether this job qualifies for auto-fix (same eligibility rule
            // reverifyNeedsReview uses via selectAutoFixTargets) and, if so, spawn
            // the investigation immediately. Stamp autoFixAttempted BEFORE the
            // investigation fires (mirrors reverifyNeedsReview's auto-fix section)
            // so the periodic pass 10 min later sees it already attempted and
            // does not spawn a duplicate.
            const fixSlugExists = (slug) => candidatePrdsDirs().some((dir) => fs.existsSync(path.join(dir, `${slug}.md`)));
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
              newlyCompletedPrds.push({ slug: orig.slug, cwd: orig.cwd });
            }
          }
        }
      }
    });
    for (const { slug, cwd } of newlyCompletedPrds) {
      await archiveCompletedPrd(slug, cwd);
    }
    await broadcast({ flush: true });

    if (terminalNotifySnapshot) {
      notifyOriginatingTab(terminalNotifySnapshot).catch((e) => {
        console.error('[scheduler] notifyOriginatingTab error', job.slug, e);
      });
    }

    if (needsReviewRcaSnapshot) {
      // Fire-and-forget, mirroring the DoD drain hook: never blocks the status
      // transition, never throws to this caller.
      writeRcaReport({
        job: needsReviewRcaSnapshot,
        runDir,
        verdict: needsReviewRcaSnapshot.verifierVerdict,
        annotations: needsReviewRcaSnapshot.verifierAnnotations,
      })
        .then((report) => notifyNeedsReview(needsReviewRcaSnapshot, report))
        .catch((e) => {
          console.error('[scheduler] writeRcaReport error', job.slug, e);
        });
    }

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
        await broadcast({ flush: true });
      } else if (decision.action === 'fail-dirty') {
        console.log(`[scheduler] transient failure (${decision.transientKind}) for ${job.slug} left ${newlyDirtyCount} uncommitted file(s) (e.g. ${dirtySample}) — not auto-requeuing`);
        await mutate((s) => {
          const i = s.jobs.findIndex((x) => x.slug === job.slug);
          if (i >= 0) {
            s.jobs[i].status = 'failed';
            s.jobs[i].error = `transient failure (${decision.transientKind}) left ${newlyDirtyCount} uncommitted file(s) in working tree (e.g. ${dirtySample}) — not auto-requeued to avoid overwriting partial work; review and commit or discard manually`;
          }
        });
        await broadcast({ flush: true });
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
        await broadcast({ flush: true });
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
    // Slot release notifies subscribed pumps (chat lane) machine-wide.
    sessionSlots.release(slotToken);
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
    // Never reconcile against an unreadable queue: reconcile() would see zero
    // job rows for every PRD on disk and resurrect the lot as 'pending'.
    if (state.unreadable) {
      console.error('[scheduler] tickQueue skipped: queue.json unreadable');
      return { fired: false, reason: 'unreadable' };
    }
    if (state.paused) {
      console.log('[scheduler] tickQueue skipped: paused');
      return recordTick({ fired: false, reason: 'paused' }, { detail: 'scheduler paused' });
    }
    if (cancelToken.cancelled) return { fired: false, reason: 'cancelled' };

    await reconcile(state);
    // Session-Manager's machine-wide slot pool is the ONLY concurrency limit
    // the picker answers to (plus the memory gate below). The scheduler used
    // to also carry a private `concurrencyCap` of 3 — the exact per-consumer
    // cap that sessionSlots.cjs was written to replace — which silently
    // ceilinged the queue at 3 while the pool the user configured said 5.
    const freeSlots = sessionSlots.available();
    const { batch, reason: holdReason, holds } = pickNextBatch(state.jobs, runningSet, freeSlots);
    if (batch.length === 0 && freeSlots === 0) {
      const snap = sessionSlots.snapshot();
      const pendingCount = state.jobs.filter((j) => j.status === 'pending').length;
      console.log(`[scheduler] slot gate: 0 of ${snap.total} session slots free (${snap.holders.map((h) => h.owner).join(', ')}) — deferring ${pendingCount} pending job(s)`);
      return recordTick(
        { fired: false, reason: 'slots-exhausted', deferredCount: pendingCount, holders: snap.holders },
        { detail: `${snap.total} of ${snap.total} session slots busy (${snap.holders.map((h) => h.owner).join(', ')})`, holds },
      );
    }
    if (batch.length === 0) {
      // Queue drained — run the definition-of-done gate fire-and-forget.
      // Non-blocking: does not hold the mutate lock; errors are logged, not thrown.
      runDefinitionOfDoneOnDrain(state, { cancelToken }).catch((err) => {
        console.log(`[scheduler] dod-drain: ${err?.message ?? String(err)}`);
      });
      if (holdReason) return recordTick({ fired: false, reason: 'held', detail: holdReason }, { holds });
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
        return recordTick({ fired: false, reason: 'already-running', runningCount }, { holds });
      }
      return recordTick({ fired: false, reason: 'drained' }, { holds });
    }

    const availableMb = getAvailableMemMb();
    // Reserve a fixed slice for the Electron host before the per-job gate, so a
    // job is never started into the host's own headroom (that path OOM-kills
    // Electron and SIGHUPs every pty — 2026-06-16 incident).
    const jobBudgetMb = availableForJobs(availableMb, RESERVED_HOST_MB);
    // The slot pool already bounded `batch` (it was passed as freeSlots to
    // pickNextBatch above), so only the memory gate can narrow it further.
    const allowed = memoryLimitedBatchSize(
      jobBudgetMb, MIN_FREE_MB_PER_JOB, runningSet.size, batch.length,
    );
    if (allowed === 0) {
      const threshold = RESERVED_HOST_MB + MIN_FREE_MB_PER_JOB * (runningSet.size + 1);
      console.log(`[scheduler] memory gate: available=${availableMb} MB < threshold=${threshold} MB (host reserve ${RESERVED_HOST_MB} + ${MIN_FREE_MB_PER_JOB}/job × ${runningSet.size + 1}) — deferring ${batch.length} job(s)`);
      lastMemGate = { availableMb, threshold, deferred: true, at: new Date().toISOString() };
      return recordTick(
        { fired: false, reason: 'memory-deferred', deferredCount: batch.length, availableMb, threshold },
        { detail: `memory gate: ${availableMb} MB free, need ${threshold} MB`, holds },
      );
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
    return recordTick({ fired: true, count: gatedBatch.length, group: gatedBatch[0]?.parallelGroup }, { holds });
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
    case 'unreadable':
      return { ok: false, kind: 'error', message: 'queue.json is unreadable — scheduling halted; a .corrupt-<ts> copy was saved next to it' };
    case 'cancelled':
      return { ok: true, kind: 'warn', message: 'Batch cancelled — try again' };
    case 'memory-deferred':
      return { ok: true, kind: 'warn', message: `Deferred ${result.deferredCount} job(s) — low memory (${result.availableMb} MB available, need ${result.threshold} MB)` };
    case 'slots-exhausted':
      return { ok: true, kind: 'warn', message: `Deferred ${result.deferredCount} job(s) — all session slots in use (${(result.holders ?? []).map((h) => h.owner).join(', ')})` };
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
  if (state.unreadable) {
    console.error('[scheduler] runDueJobs skipped: queue.json unreadable');
    return { fired: false, reason: 'unreadable' };
  }
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
    // Do NOT gate on runningSet: spawnJob()'s finally block unconditionally
    // deletes a job's slug from runningSet even when the preceding completion
    // mutate() threw and was swallowed, leaving queue.json stuck at
    // status:"running" with no slug left in runningSet to trigger reconciliation.
    // queue.json is the source of truth for which jobs are actually running.
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

    await broadcast({ flush: true });
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

// Pure helper: filter to completed/failed, merge with archived history
// entries (now that terminal jobs age out of jobs[] into history.jsonl —
// see queueHistory.cjs), dedupe by slug+runId (jobs[] wins on overlap —
// it's the fresher copy in the append-before-drop crash window), sort
// newest-finished first, cap to limit clamped to [1, 500] (default 50).
// O(n log n) on queue+history size (small at any realistic scale).
// Exported for unit testing. `historyEntries` defaults to [] so existing
// callers/tests that only pass `jobs` are unaffected.
function selectHistoryJobs(jobs, limit, historyEntries = []) {
  const cap = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const hot = (Array.isArray(jobs) ? jobs : []).filter((j) => j && (j.status === 'completed' || j.status === 'failed'));
  const seen = new Set(hot.map((j) => `${j.slug}|${j.runId ?? ''}`));
  const archived = (Array.isArray(historyEntries) ? historyEntries : []).filter((j) => {
    if (!j) return false;
    const key = `${j.slug}|${j.runId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...hot, ...archived]
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
const RESCANNABLE_VERDICTS = new Set(['transcript_errors', 'verify_unavailable', 'no_verdict_sentinel', 'pass_no_commit', 'pass_no_commit_already_shipped']);

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
    const prdPath = prdPathForJob(job);
    // Derive committedDuringRun from the recorded run window. The live
    // commit-guard uses gitHead() (before/after HEAD diff); here the run is
    // already over so we query git log filtered to [startedAt, finishedAt+60s].
    const committedDuringRun = await committedInWindow(job.cwd, job.startedAt, job.finishedAt);
    // priorLandedCommit: same lookup as spawnJob's post-run verify — the live
    // jobs[] row first (survives a resetJob), else history.jsonl.
    let priorLandedCommit = job.landedCommit ?? null;
    if (!priorLandedCommit) {
      const hist = await queueHistory.historyTerminalBySlug().catch(() => null);
      priorLandedCommit = hist?.get(job.slug)?.landedCommit ?? null;
    }
    let v = null;
    try {
      v = await verifyRun({
        runDir,
        prdPath,
        queueEntry: job,
        allJobs: snap.jobs,
        committedDuringRun,
        allowPreSentinelHeal: true,
        priorLandedCommit,
      });
    } catch { leftForReview.push({ slug: job.slug, reason: 'verifyRun threw' }); continue; }
    if (v && COMPLETED_EQUIVALENT_VERDICTS.has(v.verdict)) {
      healed.push(job.slug);
    } else {
      leftForReview.push({ slug: job.slug, reason: v ? `${v.verdict}: ${v.reason}` : 'null verdict' });
    }
  }
  if (healed.length) {
    const healSet = new Set(healed);
    const healedPrds = [];
    await mutate((s) => {
      for (const j of s.jobs) {
        if (j.status === 'needs_review' && healSet.has(j.slug)) {
          j.status = 'completed';
          j.error = null;
          delete j.verifierVerdict;
          healedPrds.push({ slug: j.slug, cwd: j.cwd });
        }
      }
    });
    for (const { slug, cwd } of healedPrds) {
      await archiveCompletedPrd(slug, cwd);
    }
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
  const promotedPrds = [];
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
      promotedPrds.push({ slug: orig.slug, cwd: orig.cwd });
    }
  });
  for (const { slug, cwd } of promotedPrds) {
    await archiveCompletedPrd(slug, cwd);
  }
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
      fixSlugExists: (s) => candidatePrdsDirs().some((dir) => fs.existsSync(path.join(dir, `${s}.md`))),
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

  // Session-Manager-wide claude -p slot pool (lib/sessionSlots.cjs) —
  // read-only diagnostic surface for the Home widget and the global
  // configuration tab.
  ipcMain.handle('schedule:session-slots', () => sessionSlots.snapshot());

  // Home-tab control for the same pool: user-set cap in [0, 10], default 5.
  // 0 pauses new claude -p launches machine-wide without killing anything
  // already running. SM_SESSION_SLOTS (if set) still overrides this at read
  // time — sessionSlots.snapshot().envOverride tells the UI to disable itself.
  ipcMain.handle('schedule:set-session-slots', validated(schemas.setSessionSlotsSchema, async (data) => {
    sessionSlots.setCap(data.cap);
    return sessionSlots.snapshot();
  }));

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
    if (!(await safeSlugPath(slug))) return { ok: false, error: 'invalid slug' };
    const outcome = await mutate((state) => {
      const idx = state.jobs.findIndex((j) => j.slug === slug);
      if (idx < 0) return 'not-found';
      // Guard is in resetJobFields: refuses to reset an already-'completed'
      // job, which would otherwise re-fire a PRD whose deliverable already
      // landed (see resetJobFields' doc comment for the incident).
      return resetJobFields(state.jobs[idx]) ? 'ok' : 'refused';
    });
    if (outcome === 'not-found') return { ok: false, error: 'not found' };
    if (outcome === 'refused') {
      return {
        ok: false,
        error: 'job already completed — resetting it would re-execute shipped work; archive the PRD instead',
      };
    }
    await broadcast({ flush: true });
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
      const srcDir = await findPrdDir(job.slug) ?? prdDirForCwd(job.cwd);
      const src = path.resolve(path.join(srcDir, `${job.slug}.md`));
      if (!src.startsWith(srcDir + path.sep)) continue;
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
    const filePath = await safeSlugPath(slug);
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
    // Editing an existing PRD writes back to whichever dir it already lives
    // in; a brand-new slug (no cwd known yet — e.g. the renderer's "New PRD"
    // template, authored before the user fills in `cwd`) falls back to the
    // legacy global dir until it's re-saved with a real cwd and migrated by
    // the next reconcile-driven scan.
    const dir = (await findPrdDir(data.slug)) ?? PRDS_DIR;
    if (dir === PRDS_DIR) ensureDirs();
    const resolved = safeSlugPathIn(dir, data.slug);
    if (!resolved) return { ok: false, error: 'invalid slug' };
    try {
      await config.writeTextAtomic(resolved, data.body, { writer: 'scheduler' });
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
    const out = [];
    const seenSlugs = new Set();

    async function readDirInto(dir, { archived }) {
      let entries;
      try {
        entries = await fsp.readdir(dir);
      } catch (e) {
        if (e?.code !== 'ENOENT') {
          logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'list-prds: readdir failed', meta: { dir, error: e?.message } });
        }
        return;
      }
      for (const name of entries) {
        if (!name.endsWith('.md') || name.startsWith('.')) continue;
        const filePath = path.join(dir, name);
        try {
          const parsed = await parsePrd(filePath);
          // A slug can't be both live and archived at once, but a duplicate
          // slug found in two archive dirs (shouldn't happen — archiving is
          // a single rename — but is cheap to guard) is skipped rather than
          // double-counted.
          if (seenSlugs.has(parsed.slug)) continue;
          seenSlugs.add(parsed.slug);
          const stat = await fsp.stat(filePath);
          const entry = {
            slug: parsed.slug,
            parallelGroup: parsed.parallelGroup,
            title: parsed.title,
            cwd: parsed.cwd || '',
            estimateMinutes: parsed.estimateMinutes,
            sourcePromptId: parsed.sourcePromptId,
            epicId: parsed.epicId ?? null,
            mtimeMs: stat.mtimeMs,
            archived,
          };
          out.push(entry);
        } catch (e) {
          logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'list-prds: skipping unparseable file', meta: { name, error: e?.message } });
        }
      }
    }

    // Live PRDs first, so an archived duplicate (shouldn't exist, but a
    // stale rename copy is possible) never shadows the still-runnable live
    // entry.
    for (const dir of candidatePrdsDirs()) {
      await readDirInto(dir, { archived: false });
    }

    const archivedStart = out.length;
    for (const dir of candidateArchivedPrdsDirs()) {
      await readDirInto(dir, { archived: true });
    }

    // Archived PRDs need a status: archiveCompletedPrd (scheduler.cjs) only
    // ever archives a job whose effective status is 'completed' — a 'failed'
    // job's PRD source stays in the live prds/ dir (still visible/countable
    // there already). Still resolve the real job status defensively (live
    // queue row, falling back to history.jsonl) rather than hard-coding
    // 'completed', so this stays correct if that archiving invariant ever
    // changes.
    if (out.length > archivedStart) {
      const [state, histBySlug] = await Promise.all([
        readQueue(),
        queueHistory.historyTerminalBySlug().catch(() => new Map()),
      ]);
      const liveStatusBySlug = new Map(state.jobs.map((j) => [j.slug, j.status]));
      for (let i = archivedStart; i < out.length; i++) {
        const entry = out[i];
        entry.archivedStatus = resolveArchivedPrdStatus(entry.slug, liveStatusBySlug, histBySlug);
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
      const historyEntries = await queueHistory.readHistory({ limit });
      return { ok: true, jobs: selectHistoryJobs(state.jobs, limit, historyEntries) };
    } catch (e) {
      return { ok: false, jobs: [], error: e?.message ?? 'read failed' };
    }
  });
}

async function init() {
  ensureDirs();
  // Boot phase — reconciliation, migrations, self-heal, first reset probe.
  // Guarded as a unit: everything below installs the timers that ARE the
  // running scheduler (poll loop, heartbeat, supervisor). A throw in here
  // used to reject init() and silently skip all of them, leaving an app
  // that looks up and holds the ownership lock but never ticks and never
  // writes a heartbeat — indistinguishable from a hung queue. Most of this
  // work is best-effort recovery; none of it is worth trading the scheduler
  // itself for. rescheduleTimer() in particular reaches the billing API,
  // which fails whenever the OAuth token is stale.
  try {
    // A slot freed anywhere (e.g. a chat run settled) may unblock a deferred
    // batch — advance the queue without waiting for the next 60s poll.
    sessionSlots.subscribe(() => { tickQueue().catch(() => {}); });
    // Retire the global queue.json: split its rows into per-project shards
    // BEFORE the first read below, so boot reconciliation sees the shards.
    try {
      const m = await queueStore.migrateLegacyGlobalQueue(DEFAULT_PROJECT_CWD);
      if (m.migrated) {
        console.log(`[scheduler] legacy global queue retired: ${m.moved} row(s) split across ${m.projects} project shard(s)`);
      }
    } catch (e) {
      console.error('[scheduler] legacy queue split failed', e?.message);
    }
    await runPrdMigration();
    sweepQueueBackups().catch((e) => console.warn('[scheduler] backup sweep failed', e?.message));

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
    //
    // Jobs whose recorded pid is still alive are deferred (not classified here) —
    // see partitionBootOrphans. Everything else (dead pid or no pid) is safe to
    // classify immediately below.
    const bootSnap = readQueueSync();
    const { immediate: immediateSlugs, deferred: deferredSlugs } = partitionBootOrphans(bootSnap.jobs);
    const bootOutcomes = new Map();
    for (const j of bootSnap.jobs) {
      if (!immediateSlugs.includes(j.slug)) continue;
      const logPath = j.runId ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`) : null;
      bootOutcomes.set(j.slug, logPath ? classifyRunOutcome(logPath) : 'unknown');
    }
    const bootReconciledCompletions = [];
    await mutate((state) => {
      for (const j of state.jobs) {
        if (j.status !== 'running' || !immediateSlugs.includes(j.slug)) continue;
        const outcome = bootOutcomes.get(j.slug) ?? 'unknown';
        const pid = j.runtime?.pid;
        const killNote = pid ? ` (orphan pid=${pid}: dead)` : '';
        applyOrphanOutcome(j, outcome, killNote);
        if (j.status === 'completed') bootReconciledCompletions.push({ slug: j.slug, cwd: j.cwd });
        console.log(`[scheduler] boot reconcile: slug=${j.slug} outcome=${outcome} → status=${j.status}`);
      }
    });
    for (const { slug, cwd } of bootReconciledCompletions) {
      await archiveCompletedPrd(slug, cwd);
    }

    // Still-alive orphans: SIGTERM (+ killOrphanClaudePid's own deferred SIGKILL
    // follow-up) now, but classification waits until BOOT_ORPHAN_KILL_GRACE_MS
    // later — reading the log while the orphan might still be writing to it
    // could misclassify an about-to-succeed run as no_result and double-run the
    // same PRD (2026-05-21 incident this guard exists for).
    for (const slug of deferredSlugs) {
      const j = bootSnap.jobs.find((x) => x.slug === slug);
      const pid = j?.runtime?.pid;
      const bootRunId = j?.runId ?? null; // captured now — guards against reconciling a DIFFERENT later run of the same slug
      if (!pid) continue;
      const result = killOrphanClaudePid(pid);
      const killNote = ` (orphan pid=${pid}: ${result})`;
      if (result === 'killed') {
        console.log(`[scheduler] boot: SIGTERM'd orphan claude pid=${pid} for ${slug} — deferring finalize ${BOOT_ORPHAN_KILL_GRACE_MS}ms`);
      }
      setTimeout(() => {
        const logPath = j.runId ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`) : null;
        const outcome = logPath ? classifyRunOutcome(logPath) : 'unknown';
        let deferredCompletedCwd;
        mutate((state) => {
          const cur = state.jobs.find((x) => x.slug === slug);
          // Race guard: bail if the job already resolved, OR if it's already been
          // re-picked into a NEW run (different runId) within the grace window —
          // that new run is not the boot orphan we SIGTERM'd and must not be
          // touched by this stale classification.
          if (!cur || cur.status !== 'running' || cur.runId !== bootRunId) return;
          applyOrphanOutcome(cur, outcome, killNote);
          console.log(`[scheduler] boot reconcile (deferred): slug=${slug} outcome=${outcome} → status=${cur.status}`);
          deferredCompletedCwd = cur.status === 'completed' ? cur.cwd : undefined;
        }).then(() => {
          if (deferredCompletedCwd !== undefined) return archiveCompletedPrd(slug, deferredCompletedCwd);
        }).catch((e) => console.error(`[scheduler] deferred boot reconcile failed for ${slug}:`, e?.message));
      }, BOOT_ORPHAN_KILL_GRACE_MS).unref?.();
    }

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
  } catch (e) {
    console.error('[scheduler] boot phase failed — starting timers anyway:', e?.message);
    try {
      require('./logs.cjs').writeLine({
        scope: 'scheduler',
        level: 'error',
        message: 'boot phase failed; timers started anyway',
        meta: { error: e?.message },
      });
    } catch { /* logging must never be the thing that stops the scheduler */ }
  }
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
  // `cwd` is optional: prdCreate.cjs's create flow passes the target
  // project's cwd explicitly (the file may not exist yet, so there's
  // nothing for findPrdDir to search for); the renderer's slug-only IPC
  // path (editing an already-queued PRD) omits it and relies on findPrdDir.
  async readPrd(slug, cwd) {
    let dir;
    if (cwd) {
      // The slug may live in the legacy flat dir or any Epic's prds/ under
      // this project; probe local dirs, defaulting to the flat dir (callers
      // use a miss there as the "doesn't exist yet" signal on create).
      const localDirs = [prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)];
      dir = localDirs.find((d) => {
        const p = safeSlugPathIn(d, slug);
        return p && fs.existsSync(p);
      }) ?? prdDirForCwd(cwd);
    } else {
      dir = await findPrdDir(slug);
    }
    if (!dir) return { ok: false, error: 'invalid slug' };
    const filePath = safeSlugPathIn(dir, slug);
    if (!filePath) return { ok: false, error: 'invalid slug' };
    try {
      // realpath resolves symlinks; re-check boundary to block a rogue agent job
      // that places a symlink inside the PRDs dir pointing outside the safe root.
      const real = await fsp.realpath(filePath);
      if (!real.startsWith(dir + path.sep)) {
        return { ok: false, error: 'invalid slug' };
      }
      const text = await fsp.readFile(real, 'utf8');
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  },

  // `cwd` optional — see readPrd's comment above; prdCreate.cjs's create
  // flow supplies it (the destination project dir for a brand-new file that
  // doesn't exist yet, so findPrdDir would return nothing to write into).
  async writePrd(slug, body, cwd) {
    let dir;
    let epicTrace = null;
    if (cwd) {
      // Edit-in-place if this slug already lives anywhere under this project
      // (legacy flat dir or any Epic's prds/); otherwise this is a CREATE,
      // and every new PRD belongs to an Epic (CLAUDE.md domain model) — mint
      // one from the body's frontmatter title/tag.
      const localDirs = [prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)];
      for (const d of localDirs) {
        const candidate = safeSlugPathIn(d, slug);
        if (candidate && fs.existsSync(candidate)) { dir = d; break; }
      }
      if (!dir) {
        // Every PRD must join an EXISTING, human-created Epic — ensureEpic
        // is join-only for every caller but the New Epic UI (epicMint.cjs's
        // SINGLE-CREATOR LAW), so this can never conjure one.
        const { fm } = splitFrontmatter(body);
        try {
          const epic = await ensureEpic(cwd, {
            // fm.sourcePromptId must be an existing Epic's promptSessionId
            // (== its active-index.json sessions key), NOT a
            // PromptTicket.id — epicMint.cjs's ensureEpic looks it up via
            // `index.sessions[explicitEpicId]` (see epicMint.cjs ~line 73),
            // a literal-equality join. Any other id (e.g. a PromptTicket.id)
            // simply won't match and this call throws below.
            epicId: fm.sourcePromptId,
            // Join-only call (no mintAuthority, explicit epicId): the
            // explicitEpicId branch in ensureEpic returns before `source` is
            // ever read, so this is a no-op today — kept for symmetry/audit
            // trail if that join path ever grows a source-touch.
            source: { producer: 'scheduler-dispatch', prdSlug: slug },
          });
          dir = epic.prdDir;
          epicTrace = epic.epicId;
        } catch (e) {
          return {
            ok: false,
            error: `no existing Epic to join (sourcePromptId=${fm.sourcePromptId ?? 'none'}): ${e?.message ?? 'unknown error'}. `
              + 'Create the Epic first via the New Epic UI, then pass its id as sourcePromptId.',
          };
        }
      }
      await fsp.mkdir(dir, { recursive: true });
    } else {
      dir = (await findPrdDir(slug)) ?? PRDS_DIR;
      if (dir === PRDS_DIR) ensureDirs();
    }

    // writePrd only ever JOINS an existing Epic now (no mintAuthority
    // above) — it can never mint one, so there is no orphaned-mint case left
    // to roll back here (contrast the old PRD 825/851 cleanup, removed).
    const resolved = safeSlugPathIn(dir, slug);
    if (!resolved) {
      return { ok: false, error: 'invalid slug' };
    }
    try {
      // Symlink defense, matching readPrd/readLog: safeSlugPathIn is lexical
      // and does NOT resolve symlinks, so a rogue job could plant a PRDs-dir
      // entry → an arbitrary $HOME path and have writeTextAtomic clobber it.
      // Resolve the real parent dir (the file itself may not exist yet) and
      // re-assert containment; also reject the target if it is already a
      // symlink.
      const realParent = await fsp.realpath(path.dirname(resolved));
      if (realParent !== dir && !realParent.startsWith(dir + path.sep)) {
        return { ok: false, error: 'invalid slug' };
      }
      const existing = await fsp.lstat(resolved).catch(() => null);
      if (existing && existing.isSymbolicLink()) {
        return { ok: false, error: 'invalid slug' };
      }
      await config.writeTextAtomic(resolved, body, { writer: 'scheduler' });
      const stat = await fsp.stat(resolved);
      if (epicTrace) {
        // Best-effort: record the dispatch on the Epic's event chain.
        try { await appendPrdCreatedEvent(cwd, epicTrace, slug); } catch { /* trace only */ }
      }
      return { ok: true, bytesWritten: stat.size };
    } catch (e) {
      return { ok: false, error: e?.message ?? 'write failed' };
    }
  },

  async resetJob(slug, opts = {}) {
    if (!(await safeSlugPath(slug))) return { ok: false, error: 'invalid slug' };
    const outcome = await mutate((state) => {
      const idx = state.jobs.findIndex((j) => j.slug === slug);
      if (idx < 0) return { kind: 'not-found' };
      // Terminal-status guard lives in resetJobFields itself; force:true
      // threads through to override it.
      if (!resetJobFields(state.jobs[idx], null, { force: opts.force === true })) {
        return { kind: 'refused' };
      }
      return { kind: 'ok' };
    });
    if (outcome.kind === 'not-found') return { ok: false, error: 'not found' };
    if (outcome.kind === 'refused') {
      return {
        ok: false,
        error: 'job already completed — resetting it would re-execute shipped work; archive the PRD instead, or pass force:true',
      };
    }
    await broadcast({ flush: true });
    return { ok: true, slug, status: 'pending' };
  },

  async listJobs() {
    const state = await readQueue();
    return state.jobs.map((j) => ({ slug: j.slug, title: j.title, status: j.status, cwd: j.cwd }));
  },

  // Exposes the module-level allocateParallelGroup (PRD 548) to callers that
  // only hold the `remote` object (lib/prdCreate.cjs's create-prd route) —
  // reuses the same allocator the file-based /develop authoring path relies
  // on implicitly, rather than re-deriving NN here.
  allocateParallelGroup,
};

// Registers the two job-management admin HTTP routes (PRD 689 — moved
// verbatim out of the former standalone admin HTTP server module's
// handleRequest, no behavior change) against an injected localAdminHttp.cjs
// transport. `remoteObj` is accepted as a parameter (defaults to this
// module's own `remote`) so the route logic stays testable in isolation
// without booting Electron, matching that former module's original
// dependency-injection pattern.
function registerAdminRoutes(adminHttp, remoteObj = remote) {
  adminHttp.registerRoute('GET', '/admin/scheduler/jobs', async (req, res) => {
    const jobs = await remoteObj.listJobs();
    sendJson(res, 200, jobs);
  });

  adminHttp.registerRoute('POST', '/admin/scheduler/reset-job', async (req, res) => {
    const raw = await readBody(req);
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    const slug = typeof parsed.slug === 'string' ? parsed.slug : null;
    if (!slug) {
      sendJson(res, 400, { ok: false, error: 'missing slug' });
      return;
    }
    const force = parsed.force === true;
    const result = await remoteObj.resetJob(slug, { force });
    sendJson(res, 200, result);
  });
}

module.exports = { registerScheduleHandlers, attachWindow, init, ROOT, PRDS_DIR, writeQueue, reconcile, reconcileSourcePromptId, allocateParallelGroup, selectHistoryJobs, parsePorcelain, FINISH_PROTOCOL, remote, pickNextBatch, pickForProject, reapDeadRunningJobs, pollRecoveryClearSource, memoryLimitedBatchSize, availableForJobs, reverifyNeedsReview, isRescanCandidate, isPromotableOriginal, selectAutoFixTargets, isEligibleForImmediateAutoFix, resolveRunId, isUnresolvableNeedsReview, healTargetForFix, buildInvestigationPrompt, committedInWindow, computeCommittedDuringRun, classifySigtermWithCommit, isFixPlanSlug, isFixPlanBeyondDepthCap, MAX_INVESTIGATION_DEPTH, forceTickOutcome, applyPauseCleared, detectNetworkErrorInLog, detectRateLimitInLog, classifyFailureOutcome, commitGuardVerdict, TRANSIENT_RETRY_CAP, buildScheduleStatePayload, partitionBootOrphans, applyOrphanOutcome, BOOT_ORPHAN_KILL_GRACE_MS, registerAdminRoutes, notifyOriginatingTab, notifyNeedsReview, isNotifiableTerminalStatus, extractResultTextFromLog, candidatePrdsDirs, candidateArchivedPrdsDirs, resolveArchivedPrdStatus, prdDirForCwd, prdPathForJob, archivedPrdPathForJob, archivedTwinExists, findPrdDir, runPrdMigration, shouldSkipInvestigationForCleanRun, archiveCompletedPrd, retireCompletedSlugs, SCHEDULER_BOOTED_AT, SCHEDULER_CODE_SHA, resetJobFields, executeJob, prdArchivedSkipResult };
