'use strict';

/**
 * rcaFeedbackHook.cjs — files a deterministic Root Cause Analysis feedback
 * item when a scheduler job is parked in `needs_review`.
 *
 * Mirrors the dodDrainHook.cjs pattern: fire-and-forget, idempotent,
 * kill-switched, never throws to the caller. Unlike the DoD gate this fires
 * per-job at the needs_review transition, not at queue drain.
 *
 * No LLM calls live here — the RCA body is assembled deterministically from
 * the run's meta.json, log tail, and the original PRD's acceptance-criteria
 * section. When an Opus auto-fix investigation later runs (spawnInvestigation
 * in scheduler.cjs) and produces a root-cause summary, that text is folded
 * into this SAME file's "Investigation analysis" section via a second call
 * with the same (slug, runId) — never a duplicate file.
 *
 * Kill-switch: SM_RCA_DISABLE=1 (mirrors SM_DOD_DISABLE / SM_SUPERVISOR_DISABLE).
 *
 * Electron-free by design (no require('electron')) so tests stay hermetic.
 * config.cjs itself requires('electron'), but that resolves to a harmless
 * string (not the electron module) when required outside the Electron
 * runtime, and this lib never touches ipcMain — only the atomic-write /
 * path-validation helpers.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const { readTail } = require('./fileTail.cjs');
const { resolvePrdWriteDir } = require('./prdLocations.cjs');

// The one project this hook always knows how to reach, used as the fallback
// destination when a job's own cwd has no feedback inbox.
const SM_REPO_ROOT = path.join(os.homedir(), 'Projects', 'session-manager');
const SM_REPO_FEEDBACK_DIR = path.join(SM_REPO_ROOT, 'session-manager-operations', 'feedback');

// NEVER write here: ~/.claude/session-manager/feedback/ is the scheduler's
// auto-PRD intake (src/main/scheduler.cjs's periodic feedback sweep) — it
// converts anything dropped there into a scheduled PRD automatically. Filing
// an RCA there would create an RCA → auto-PRD → run → needs_review → RCA
// cycle with no human in the loop. Both real destinations below are project
// feedback INBOXES (consumed by /process-feedback), which is a different,
// human/agent-triaged path.

// ─── VERDICT_LABELS — deliberate duplicate ──────────────────────────────────
// Mirrors src/renderer/components/tabs/scheduler/sched-primitives.tsx:123-131.
// The main process cannot import renderer TSX, so this vocabulary is kept in
// sync by hand. If you change one, change the other.
const VERDICT_LABELS = {
  halt: 'verifier halted',
  deps_unmet: 'dependencies unmet',
  transcript_errors: 'transcript had errors',
  verify_unavailable: 'verify unavailable',
  uncommitted_changes: 'uncommitted changes',
  no_verdict_sentinel: 'no commit or verdict sentinel',
  pass_no_commit: 'PASS sentinel but no commit landed',
  pass_no_commit_already_shipped: 'PASS with no commit — deliverables already shipped',
  pass_no_commit_prior_run_verified: 'PASS with no commit — prior run of this slug already landed the work',
};

function humanVerdict(verdict) {
  return VERDICT_LABELS[verdict] ?? verdict ?? 'unknown';
}

// ─── Failure-class matching (deterministic, no LLM) ─────────────────────────

const FAILURE_CLASSES = {
  ALREADY_SHIPPED: 'already-shipped',
  SELF_QUEUE: 'self-queue',
  STUCK_LOOP: 'stuck-loop',
  POST_AC_OVERRUN: 'post-ac-overrun',
  NO_SENTINEL: 'no-sentinel',
  UNCOMMITTED: 'uncommitted-changes',
  TRANSCRIPT_ERRORS: 'transcript-errors',
  UNKNOWN: 'unknown',
};

const PREVENTION_HINTS = {
  [FAILURE_CLASSES.ALREADY_SHIPPED]:
    "This run found its acceptance criteria already satisfied by a prior commit and correctly made no change, so no commit landed and the verifier returned `pass_no_commit`. This is a stale re-run, not an execution failure — the PRD's `.md` was never moved out of `session-manager-operations/scheduler/prds/` after the work shipped. Archive the PRD into `session-manager-operations/scheduler/prds-archived/` instead of re-queuing or re-running it.",
  [FAILURE_CLASSES.SELF_QUEUE]:
    "This run either invoked /develop or /process-feedback from inside its own headless execution, or backgrounded a long-running command and called ScheduleWakeup to check back later — both are the 'you ARE the executor — never re-queue or self-schedule' anti-pattern. A headless PRD run must perform its own acceptance criteria directly and has no next turn to resume it (standards.md → Execution discipline).",
  [FAILURE_CLASSES.STUCK_LOOP]:
    'Bound every command with `timeout <N> <cmd>` — never leave an unbounded `until`/`while true`/`sleep` poll in a PRD body (PRD_AUTHORING.md loop-hang guidance).',
  [FAILURE_CLASSES.POST_AC_OVERRUN]:
    'Stop at the acceptance checklist — do not add "while we\'re here" work (generators, fixtures, extra polish) once the last AC item is satisfied (PRD_AUTHORING.md post-AC-overrun incident).',
  [FAILURE_CLASSES.NO_SENTINEL]:
    'End every run with a truthful `SCHEDULER_VERDICT: PASS`/`FAIL` sentinel as the literal last line, after the finish-protocol commit has landed.',
  [FAILURE_CLASSES.UNCOMMITTED]:
    'Run `git add -A && git commit` as the final finish-protocol step before printing the verdict sentinel — never end a run with a dirty working tree.',
  [FAILURE_CLASSES.TRANSCRIPT_ERRORS]:
    'Recover or annotate every error within ~10 lines (e.g. `# expected/handled: <why>`) instead of leaving a bare Traceback near the end of the transcript.',
  [FAILURE_CLASSES.UNKNOWN]:
    'Re-run the acceptance criteria gate locally against the failure log to pin down the specific break before re-queuing.',
};

/**
 * Extract the <RCA>...</RCA> block an investigation agent is instructed to
 * print before authoring its fix-plan PRD (see spawnInvestigation's prompt in
 * scheduler.cjs). The investigation log is a stream-json transcript, so a
 * literal newline inside the agent's text lands JSON-escaped as `\n` — unescape
 * common JSON string escapes before matching so a multi-line block extracts
 * cleanly. Returns null if no block is found.
 */
function extractRcaBlock(text) {
  if (!text) return null;
  const unescaped = text.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  const m = unescaped.match(/<RCA>([\s\S]*?)<\/RCA>/);
  return m ? m[1].trim() : null;
}

const ALREADY_SHIPPED_RE = /already (fully )?(satisfied|implemented|committed|done|shipped)|was (already )?(implemented|committed) in|nothing (new )?to commit|no (code )?changes were needed/i;
const SELF_QUEUE_SKILL_RE = /Launching skill: session-manager-dev:(develop|process-feedback)/;
const SELF_QUEUE_WAKEUP_RE = /ScheduleWakeup/;
const STUCK_LOOP_RE = /\b(until\s|while\s+true|sleep\s)/i;
const AC_CHECKBOX_RE = /^\s*[-*]\s*\[[xX]\]/;
const SENTINEL_PASS_RE = /SCHEDULER_VERDICT:\s*PASS/;
const STUCK_LOOP_WINDOW = 40; // "final lines" per AC
const POST_AC_OVERRUN_MIN_TAIL_FRACTION = 0.3;

/**
 * Classify why a job likely landed in needs_review, from the log tail plus
 * the verifier verdict. Pure/deterministic — no LLM, no I/O.
 *
 * Complexity: O(n) over log-tail lines (n bounded — callers pass a tail, not
 * a full log).
 */
function classifyFailure({ verdict, logTail }) {
  const lines = (logTail || '').split('\n');

  // Checked first, before SELF_QUEUE/STUCK_LOOP: a correct executor that finds
  // its acceptance criteria already satisfied by a prior commit makes no
  // change and truthfully prints a PASS sentinel, so the run lands
  // `pass_no_commit` (or `no_verdict_sentinel`, e.g. when it exits before the
  // finish-protocol sentinel). Gated tightly on verdict so a tail that merely
  // *mentions* "already implemented" (e.g. quoting a PRD body) while genuinely
  // failing for another reason doesn't get misclassified as this benign case
  // (incident: PRD 812-rca-self-delegation-failure-class re-ran 27 minutes
  // after its own fix landed in 9cf0384 and was misclassified NO_SENTINEL).
  if (
    (verdict === 'pass_no_commit' || verdict === 'no_verdict_sentinel') &&
    ALREADY_SHIPPED_RE.test(logTail || '')
  ) {
    return FAILURE_CLASSES.ALREADY_SHIPPED;
  }

  // Checked before STUCK_LOOP: a backgrounded command + ScheduleWakeup
  // (variant b) can land words like "sleep"/"poll" in the tail via the PRD's
  // own AC text, which would otherwise false-match STUCK_LOOP_RE (see PRD 771).
  if (SELF_QUEUE_SKILL_RE.test(logTail || '') || SELF_QUEUE_WAKEUP_RE.test(logTail || '')) {
    return FAILURE_CLASSES.SELF_QUEUE;
  }

  const tailWindow = lines.slice(-STUCK_LOOP_WINDOW);
  if (tailWindow.some((l) => STUCK_LOOP_RE.test(l))) {
    return FAILURE_CLASSES.STUCK_LOOP;
  }

  // post-AC overrun: the log shows an AC checkbox line, then keeps going
  // (fails) well after it, with no PASS sentinel in between — i.e. the run
  // did the acceptance work then kept working (and died) past it.
  let lastAcIdx = -1;
  lines.forEach((l, i) => {
    if (AC_CHECKBOX_RE.test(l)) lastAcIdx = i;
  });
  if (lastAcIdx >= 0 && lines.length > 0) {
    const tailAfterAc = lines.slice(lastAcIdx + 1);
    const passSeenAfter = tailAfterAc.some((l) => SENTINEL_PASS_RE.test(l));
    const remainingFraction = tailAfterAc.length / lines.length;
    if (!passSeenAfter && remainingFraction > POST_AC_OVERRUN_MIN_TAIL_FRACTION) {
      return FAILURE_CLASSES.POST_AC_OVERRUN;
    }
  }

  if (verdict === 'uncommitted_changes') return FAILURE_CLASSES.UNCOMMITTED;
  if (verdict === 'no_verdict_sentinel' || verdict === 'pass_no_commit') return FAILURE_CLASSES.NO_SENTINEL;
  if (verdict === 'transcript_errors' || verdict === 'verify_unavailable') return FAILURE_CLASSES.TRANSCRIPT_ERRORS;
  return FAILURE_CLASSES.UNKNOWN;
}

/**
 * Extract the `# Acceptance criteria` section (any heading level) from a PRD
 * body, up to the next heading or end of body. Returns null if not found.
 */
function extractAcceptanceCriteria(prdBody) {
  if (typeof prdBody !== 'string') return null;
  const lines = prdBody.split('\n');
  const startIdx = lines.findIndex((l) => /^#{1,6}\s*Acceptance criteria\s*$/i.test(l.trim()));
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endOffset = rest.findIndex((l) => /^#{1,6}\s+\S/.test(l));
  const section = endOffset === -1 ? rest : rest.slice(0, endOffset);
  const text = section.join('\n').trim();
  return text || null;
}

// ─── Destination resolution ──────────────────────────────────────────────────

/**
 * Resolve where an RCA for `job` should be filed.
 *   1. <job.cwd>/session-manager-operations/feedback/ if it exists.
 *   2. Else session-manager's own repo inbox, naming the target project.
 */
function resolveDestination(job) {
  const jobCwd = job?.cwd;
  if (jobCwd) {
    const candidate = path.join(jobCwd, 'session-manager-operations', 'feedback');
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return { dir: candidate, allowlistRoot: jobCwd, targetProjectNote: null };
      }
    } catch {
      // missing/inaccessible — fall through to the session-manager fallback
    }
  }
  const targetProjectNote = jobCwd
    ? `Filed into session-manager's own feedback inbox because \`${jobCwd}\` has no ` +
      `\`session-manager-operations/feedback/\` directory. Target project: \`${jobCwd}\`.`
    : 'Filed into session-manager\'s own feedback inbox (job had no cwd on record).';
  return { dir: SM_REPO_FEEDBACK_DIR, allowlistRoot: SM_REPO_ROOT, targetProjectNote };
}

function shortRunId(runId) {
  const cleaned = String(runId ?? '').replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(0, 12) || 'norun';
}

function rcaFileName(dateStr, slug, runId) {
  return `${dateStr}-rca-${slug}-${shortRunId(runId)}.md`;
}

function lastNLines(text, n) {
  const lines = (text || '').split('\n');
  return lines.slice(-n).join('\n');
}

function readRunMeta(runDir, slug) {
  if (!runDir) return null;
  try {
    const raw = fs.readFileSync(path.join(runDir, `${slug}.meta.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readPrdBody(cwd, slug) {
  if (!cwd) return '';
  try {
    const raw = fs.readFileSync(path.join(resolvePrdWriteDir(cwd), `${slug}.md`), 'utf8');
    return splitFrontmatter(raw).body;
  } catch {
    return '';
  }
}

/**
 * Assemble the deterministic RCA markdown body (frontmatter + sections).
 * Pure — no I/O, no LLM.
 */
function buildRcaMarkdown({ job, verdict, meta, logTail, acText, failureClass, investigationText, targetProjectNote }) {
  const title = `Root cause: ${job.slug} → needs_review (${humanVerdict(verdict)})`;
  const fm = ['---', `title: ${title}`, 'source: scheduler-rca', 'type: rca', 'severity: normal', `prdSlug: ${job.slug}`, `runId: ${job.runId}`, `verdict: ${verdict}`, '---'].join('\n');

  const last60 = lastNLines(logTail, 60);
  const exitCode = meta?.exitCode ?? job.exitCode ?? 'unknown';
  const durationMs = meta?.durationMs != null ? `${meta.durationMs}ms` : 'unknown';
  const prevention = PREVENTION_HINTS[failureClass] ?? PREVENTION_HINTS[FAILURE_CLASSES.UNKNOWN];

  const sections = [
    `# What happened\n\nJob \`${job.slug}\` was parked in \`needs_review\` with verifier verdict ` +
      `\`${verdict}\` (${humanVerdict(verdict)}).${job.error ? `\n\n${job.error}` : ''}`,
    `# Evidence\n\n- Exit code: ${exitCode}\n- Duration: ${durationMs}\n\nLast 60 log lines:\n\n\`\`\`\n${last60 || '(no log available)'}\n\`\`\``,
    `# The PRD's acceptance criteria\n\n${acText || '(acceptance criteria not found — original PRD may have been archived or removed)'}`,
    `# Likely failure class\n\n**${failureClass}**\n\nPrevention: ${prevention}`,
  ];
  if (targetProjectNote) sections.push(`# Note\n\n${targetProjectNote}`);
  if (investigationText) sections.push(`## Investigation analysis\n\n${investigationText.trim()}`);

  return `${fm}\n\n${sections.join('\n\n')}\n`;
}

/**
 * File (or update) a deterministic RCA feedback item for a needs_review job.
 * Never throws — logs one line on success/skip/error and always resolves.
 *
 * Idempotency: the destination filename is deterministic per (slug, runId).
 * A second call for the same (slug, runId) with no investigationText is a
 * no-op; a second call WITH investigationText overwrites the same file to
 * add/replace the "Investigation analysis" section rather than filing a
 * duplicate. A different runId (new run of the same slug) files a new RCA.
 *
 * @param {object} opts
 * @param {{slug: string, cwd?: string, runId: string, exitCode?: number, error?: string}} opts.job
 * @param {string} [opts.runDir]   Run directory containing <slug>.log / <slug>.meta.json.
 * @param {string} opts.verdict    Verifier verdict string (e.g. 'uncommitted_changes').
 * @param {Array}  [opts.annotations]  Non-blocking verifier annotations (currently unused
 *                                     in the body beyond being accepted for future use).
 * @param {string} [opts.investigationText]  <RCA> block text from an Opus investigation.
 * @param {Date}   [opts.now]      Override for the date segment of the filename (testing).
 * @returns {Promise<{filed: boolean, path?: string, updated?: boolean, reason?: string}>}
 */
async function fileRcaFeedback({ job, runDir, verdict, annotations, investigationText, now } = {}) {
  try {
    if (process.env.SM_RCA_DISABLE === '1') {
      console.log('[rca] skip: SM_RCA_DISABLE=1');
      return { filed: false, reason: 'disabled' };
    }
    if (!job || !job.slug || !job.runId) {
      console.log('[rca] skip: missing job.slug/job.runId');
      return { filed: false, reason: 'missing-job-fields' };
    }
    // Defense-in-depth: job.slug is already constrained by the scheduler's own
    // slug schema (ipcSchemas.cjs SCHEDULE_SLUG_RE) wherever a job is created,
    // but this lib builds filesystem paths straight from it — a second,
    // narrower check here costs nothing and closes off future regex laxity
    // upstream (mirrors scheduler.cjs's safeSlugPath()).
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(job.slug)) {
      console.log(`[rca] skip: unsafe job.slug ${JSON.stringify(job.slug)}`);
      return { filed: false, reason: 'unsafe-slug' };
    }
    if (!verdict) {
      console.log(`[rca] skip: no verdict for ${job.slug}`);
      return { filed: false, reason: 'no-verdict' };
    }

    const dest = resolveDestination(job);
    const dateStr = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
    const fileName = rcaFileName(dateStr, job.slug, job.runId);
    const destPath = path.resolve(path.join(dest.dir, fileName));
    if (!destPath.startsWith(path.resolve(dest.dir) + path.sep)) {
      console.log(`[rca] skip: destPath escaped dest dir (${destPath})`);
      return { filed: false, reason: 'unsafe-path' };
    }
    // /process-feedback archives dispositioned items to <dest.dir>/processed/
    // immediately at disposition time (its own README convention) — long
    // before this hook's own run-verify/self-heal passes might touch the same
    // (slug, runId) again. Once archived, the live-dir check alone goes false
    // and a re-trigger would refile a duplicate straight into the live inbox.
    const processedPath = path.resolve(path.join(dest.dir, 'processed', fileName));
    if (!processedPath.startsWith(path.resolve(path.join(dest.dir, 'processed')) + path.sep)) {
      console.log(`[rca] skip: processedPath escaped processed dir (${processedPath})`);
      return { filed: false, reason: 'unsafe-path' };
    }

    const liveExists = fs.existsSync(destPath);
    const processedExists = !liveExists && fs.existsSync(processedPath);
    const alreadyFiled = liveExists || processedExists;
    if (alreadyFiled && !investigationText) {
      const existingPath = liveExists ? destPath : processedPath;
      console.log(`[rca] skip: already filed for ${job.slug}@${job.runId}`);
      return { filed: false, reason: 'duplicate', path: existingPath };
    }
    // An investigationText update must target wherever the file actually
    // lives (live dir or processed/), not assume the live dir.
    const targetPath = liveExists || !processedExists ? destPath : processedPath;

    const meta = readRunMeta(runDir, job.slug);
    const logPath = runDir ? path.join(runDir, `${job.slug}.log`) : null;
    const logTail = logPath ? readTail(logPath, 64 * 1024) : '';
    const acText = extractAcceptanceCriteria(readPrdBody(job.cwd, job.slug));
    const failureClass = classifyFailure({ verdict, logTail });

    const markdown = buildRcaMarkdown({
      job, verdict, meta, logTail, acText, failureClass, investigationText,
      targetProjectNote: dest.targetProjectNote, annotations,
    });

    config.addAllowedRoot(dest.allowlistRoot);
    await config.writeTextAtomic(targetPath, markdown);

    console.log(`[rca] ${alreadyFiled ? 'updated (investigation)' : 'filed'} ${targetPath}`);
    return { filed: true, path: targetPath, updated: alreadyFiled };
  } catch (e) {
    console.error('[rca] error filing RCA feedback', e?.message ?? String(e));
    return { filed: false, reason: 'error', error: e?.message ?? String(e) };
  }
}

module.exports = {
  fileRcaFeedback,
  // Pure helpers, exported for unit tests.
  humanVerdict,
  classifyFailure,
  extractAcceptanceCriteria,
  extractRcaBlock,
  resolveDestination,
  rcaFileName,
  buildRcaMarkdown,
  FAILURE_CLASSES,
  VERDICT_LABELS,
  SM_REPO_FEEDBACK_DIR,
};
