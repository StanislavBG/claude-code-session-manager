/**
 * runVerify.cjs — post-run reconciliation verifier.
 *
 * Called by scheduler.cjs after every agent exit=0, before marking a job
 * "completed". The verdict depends only on outcomes — sentinel, commit
 * evidence, exit code, log readability, dependency prerequisites. Transcript
 * content is NEVER scanned for error text (pattern scan retired).
 *
 * Pure: no IPC, no queue writes. Writes a verdicts.json sidecar to runDir as
 * a by-product so the renderer and any offline tooling can read the result
 * without re-parsing the log.
 *
 * Exported API:
 *   verifyRun({ runDir, prdPath, queueEntry, allJobs }) → Promise<Verdict>
 *
 * Verdict shape:
 *   { verdict: 'clean'|'halt'|'deps_unmet'|'verify_unavailable'
 *       |'no_verdict_sentinel'|'abandoned_background_task',
 *     reason: string,
 *     downgradeTo: 'pending'|'needs_review'|null }
 *
 * Downgrade policy:
 *   clean           → null        (caller stamps 'completed')
 *   halt            → 'pending'   (re-fires automatically next slot; only for
 *                                  a run that printed no SCHEDULER_VERDICT line)
 *   deps_unmet      → 'pending'   (re-fires when deps clear)
 *   transcript_errors → historical rows only; no longer emitted
 *   verify_unavailable → 'needs_review' (unreadable log / verifier threw)
 *   no_verdict_sentinel → 'needs_review'
 *   abandoned_background_task → 'needs_review'
 *   run_commit_not_landed → 'needs_review' (PASS but transcript SHA unreachable)
 *   pass_no_commit_already_shipped → historical rows only; no longer emitted
 *
 * Time complexity: O(N·L) where N = log line count, L = avg content line count.
 * The log is read once with readFileSync (700 KB typical; well within Node.js
 * heap). Line-by-line JSON parsing keeps working set small.
 *
 * Non-goals: semantic understanding of agent output, retroactive re-verification
 * of already-completed jobs.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parsePrdFile } = require('./lib/prd/prdFrontmatter.cjs');
const { isSatisfiedDepRow } = require('./lib/prd/depSlugResolve.cjs');

const VERDICTS_SCHEMA_VERSION = 1;

// Bound on the `gh pr view` postcondition check below (§ merge-main exemption).
const GH_CHECK_TIMEOUT_MS = 15_000;

// ─── policy-denial detector ──────────────────────────────────────────────────

/**
 * A PreToolUse hook denial (`guard-destructive-git.cjs`, `guard-prd-writes.cjs`,
 * `guard-inline-implementation.cjs`, or the harness's own `Blocked: sleep N
 * followed by: ...` form) never executed the tool it names — it says nothing
 * about whether the task succeeded, and the model is expected to adapt and
 * retry. (Incident: PRD 1106, 2026-09-02 — four guard-destructive-git denials
 * in a fully-implemented, correctly-isolated run.)
 */
function isPolicyDenial(content) {
  if (typeof content !== 'string' || !content) return false;
  return /^(?:Error:\s*)?Blocked:/.test(content);
}


// ─── log parser ───────────────────────────────────────────────────────────────

/**
 * Coerce a tool_result content field to a plain string.
 * Claude's stream-json may send content as either a string or an array of
 * { type: 'text', text: '...' } blocks.
 */
function extractContent(item) {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

/**
 * Parse the run log into a flat sequence of extracted events.
 *
 * Event shapes:
 *   { kind:'tool_use',    seq, toolUseId, toolName, description, command, parentToolUseId }
 *   { kind:'tool_result', seq, toolUseId, content, isError, parentToolUseId }
 *   { kind:'result',      seq, subtype, resultText }
 *
 * Non-JSON lines (scheduler metadata "[scheduler] ...") are silently skipped.
 * Malformed JSON lines are also skipped.
 *
 * O(N) where N = log line count.
 *
 * @returns {{ events: object[], resultEvent: object|null, error: string|null }}
 */
function parseLog(logPath) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    return { events: [], resultEvent: null, error: e.message, transcriptCommitShas: [] };
  }

  const events = [];
  let resultEvent = null;
  let seq = 0;
  let transcriptCommitLanded = false;
  const transcriptCommitShaSet = new Set();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[scheduler]')) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    // Harness-emitted commit evidence: git itself produced these lines (a
    // `vcs_state_changed` system event, or a tool_use_result carrying a
    // gitOperation), so the model cannot fabricate them. Detected here as a
    // plain boolean scan — never pushed into `events`, so the index-based
    // final-20% math elsewhere is unaffected.
    if (obj.type === 'system' && obj.subtype === 'vcs_state_changed' && obj.kind === 'commit') {
      transcriptCommitLanded = true;
    }
    const gitOpKind = obj.tool_use_result?.gitOperation?.commit?.kind;
    if (gitOpKind === 'committed' || gitOpKind === 'cherry-picked') {
      if (gitOpKind === 'committed') transcriptCommitLanded = true;
      const sha = obj.tool_use_result.gitOperation.commit.sha;
      if (typeof sha === 'string' && sha) transcriptCommitShaSet.add(sha);
    }

    // Final result event.
    if (obj.type === 'result') {
      const ev = {
        kind: 'result',
        seq: seq++,
        subtype: obj.subtype ?? '',
        resultText: typeof obj.result === 'string' ? obj.result : '',
      };
      resultEvent = ev;
      events.push(ev);
      continue;
    }

    // Assistant turn: extract tool_use items.
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item?.type === 'tool_use') {
          events.push({
            kind: 'tool_use',
            seq: seq++,
            toolUseId: item.id ?? '',
            toolName: item.name ?? '',
            description: item.input?.description ?? '',
            command: item.input?.command ?? '',
            parentToolUseId: obj.parent_tool_use_id ?? null,
          });
        }
      }
      continue;
    }

    // User turn: extract tool_result items.
    if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item?.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            seq: seq++,
            toolUseId: item.tool_use_id ?? '',
            content: extractContent(item),
            isError: item.is_error === true,
            parentToolUseId: obj.parent_tool_use_id ?? null,
          });
        }
      }
      continue;
    }
  }

  return { events, resultEvent, error: null, transcriptCommitLanded, transcriptCommitShas: [...transcriptCommitShaSet] };
}

// Stable, narrow substrings of the harness's auto-background tool_result text
// (Bash: "Command did not complete within its 120s timeout and was moved to
// the background... You will be notified when it completes."). Anchored on
// short distinctive fragments rather than the whole sentence so harness
// wording drift degrades to the generic no_verdict_sentinel verdict instead
// of throwing.
const BACKGROUND_TASK_MARKERS = ['moved to the background', 'You will be notified when it completes'];

/**
 * True when any tool_result in the transcript carries the harness's
 * auto-background marker text — i.e. a Bash command was auto-backgrounded
 * after its foreground timeout and the run ended waiting for a notification
 * a headless run structurally cannot receive.
 */
function hasAbandonedBackgroundTask(events) {
  for (const ev of events) {
    if (ev.kind !== 'tool_result' || !ev.content) continue;
    if (BACKGROUND_TASK_MARKERS.some((marker) => ev.content.includes(marker))) return true;
  }
  return false;
}

// ─── dependency check ────────────────────────────────────────────────────────

/**
 * Verify that all declared dependencies for `queueEntry` are satisfied.
 *
 * One layer: queue.json's `dependsOn` array — the same and only dependency
 * signal the dispatcher (findBlockingDep) uses. PRD body prose is NOT parsed.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkDeps(queueEntry, allJobs) {
  const bySlug = new Map(allJobs.map((j) => [j.slug, j]));
  // A PRD's filename carries the allocator's `NN-` prefix, but `dependsOn:` is
  // authored with the bare name (the author cannot know the number that will
  // be issued). Resolve exact slug first, then bare-name — identical rule to
  // schedulerBatch.pickForProject's rowsForDep, which MUST agree with this
  // function (see the missing-row note below).
  const rowsByBareSlug = new Map();
  for (const j of allJobs) {
    const bare = String(j.slug ?? '').replace(/^\d+-/, '');
    if (!rowsByBareSlug.has(bare)) rowsByBareSlug.set(bare, []);
    rowsByBareSlug.get(bare).push(j);
  }
  const rowsForDep = (slug) => {
    const exact = bySlug.get(slug);
    if (exact) return [exact];
    return rowsByBareSlug.get(String(slug ?? '').replace(/^\d+-/, '')) ?? [];
  };

  // 1. Queue-level dependsOn (explicit).
  const queueDeps = Array.isArray(queueEntry.dependsOn) ? queueEntry.dependsOn : [];
  for (const depSlug of queueDeps) {
    const deps = rowsForDep(depSlug);
    // A dep with NO row is SATISFIED, not unmet. Completed rows are retired to
    // history shards and their PRD is archived, so absence is the normal
    // end-state of a finished dependency — exactly how pickForProject reads it.
    //
    // This used to return deps_unmet, which put the two halves of the
    // scheduler in direct contradiction: the picker treated a missing dep as
    // done and fired the job, then this check treated the same missing dep as
    // unmet and downgraded the finished run back to pending — an infinite
    // re-run, one full billed claude -p per cycle. It also silently dropped
    // real work: PRDs 854 and 857 each ran to exit 0, were downgraded on a
    // bare dep name that never matched any row, and ended up on disk with no
    // queue row at all.
    if (deps.length === 0) continue;
    // Same predicate as findBlockingDep — an auto-resolve skip the picker
    // dispatched past must not be re-judged unmet here (same infinite re-run).
    const unfinished = deps.find((d) => !isSatisfiedDepRow(d));
    if (unfinished) {
      return { ok: false, reason: `dependsOn: "${depSlug}" is ${unfinished.status} (need completed)` };
    }
  }

  return { ok: true };
}

// ─── sentinel scanner ─────────────────────────────────────────────────────────

/**
 * Scan for a `SCHEDULER_VERDICT: PASS|FAIL|BLOCKED_BY_FOREIGN_WIP` sentinel (a legacy NEEDS_HUMAN line is classed as FAIL)
 * line in the run output.
 *
 * Checks `resultEvent.resultText` first (the agent's final message), then the
 * last tool_result content. Anchored to line-start so prose mentioning the
 * string in mid-sentence does not match.
 *
 * Returns 'pass', 'fail', 'blocked_by_foreign_wip', or null.
 */
function scanSentinel(resultEvent, events) {
  const RE = /^SCHEDULER_VERDICT:\s*(PASS|FAIL|BLOCKED_BY_FOREIGN_WIP|NEEDS_HUMAN)\b/m;
  const norm = (v) => { const l = v.toLowerCase(); return l === 'needs_human' ? 'fail' : l; };

  if (resultEvent) {
    const m = resultEvent.resultText.match(RE);
    if (m) return norm(m[1]);
  }

  let lastToolResult = null;
  for (const ev of events) {
    if (ev.kind === 'tool_result') lastToolResult = ev;
  }
  if (lastToolResult && lastToolResult.content) {
    const m = lastToolResult.content.match(RE);
    if (m) return norm(m[1]);
  }

  return null;
}

/**
 * First line that starts at column 0 with the exact uppercase halt marker
 * (`HALT:`) outside a fenced block, else null. Line-anchored and fence-aware
 * because reports quote the marker in prose and paste tool output in fences,
 * and PRD_AUTHORING.md §4/§9/§10 tell scripts to print it on failure — neither
 * is the executor's own stop signal.
 * @param {unknown} text
 * @returns {string | null}
 */
function scanHaltLine(text) {
  if (typeof text !== 'string') return null;
  let inFence = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trimEnd();
    const t = line.trimStart();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.startsWith('HALT:')) return line;
  }
  return null;
}

/**
 * One-line reason after `SCHEDULER_VERDICT: FAIL` (same two-source scan order
 * as scanSentinel). Trimmed, capped at 300 chars; '' when absent.
 */
function scanSentinelReason(resultEvent, events) {
  const RE = /^SCHEDULER_VERDICT:\s*(?:FAIL|NEEDS_HUMAN)\b[ \t]*([^\n]*)/m;
  const clip = (m) => m[1].trim().slice(0, 300);
  if (resultEvent && resultEvent.resultText) {
    const m = resultEvent.resultText.match(RE);
    if (m) return clip(m);
  }
  let lastToolResult = null;
  for (const ev of events) {
    if (ev.kind === 'tool_result') lastToolResult = ev;
  }
  if (lastToolResult && lastToolResult.content) {
    const m = lastToolResult.content.match(RE);
    if (m) return clip(m);
  }
  return '';
}

/**
 * Scan for a `FOREIGN_WIP_PATHS: <comma-separated paths>` evidence line —
 * the mandatory companion to a `SCHEDULER_VERDICT: BLOCKED_BY_FOREIGN_WIP`
 * sentinel (see FINISH_PROTOCOL in scheduler.cjs). Same two-source scan order
 * as scanSentinel (resultEvent.resultText, then the last tool_result) so the
 * two scanners always agree on which "final say" they're reading from.
 *
 * Returns a deduplicated array of trimmed path strings (possibly empty — an
 * executor that emits the verdict with no paths line, or an empty one, gives
 * the caller nothing to validate, which the caller must treat as an invalid
 * claim, not an empty-but-valid one).
 */
function scanForeignWipPathsClaim(resultEvent, events) {
  const RE = /^FOREIGN_WIP_PATHS:\s*(.+)$/m;

  const parse = (text) => {
    const m = typeof text === 'string' ? text.match(RE) : null;
    if (!m) return null;
    return [...new Set(m[1].split(',').map((p) => p.trim()).filter(Boolean))];
  };

  if (resultEvent) {
    const paths = parse(resultEvent.resultText);
    if (paths) return paths;
  }

  let lastToolResult = null;
  for (const ev of events) {
    if (ev.kind === 'tool_result') lastToolResult = ev;
  }
  if (lastToolResult) {
    const paths = parse(lastToolResult.content);
    if (paths) return paths;
  }

  return [];
}

// ─── merge-main postcondition exemption ──────────────────────────────────────

/**
 * True for the `NN-prXXX-merge-main` / `NN-fix-prXXX-merge-main` slug
 * convention already used dozens of times in this queue (merge-current-main
 * PRDs targeting a shared repo's PR branch). Narrow, mechanical string check —
 * this is the only slug shape exempted from the `pass_no_commit` flag below.
 */
function isMergeMainSlug(slug) {
  return typeof slug === 'string' && /-merge-main$/.test(slug);
}

/**
 * Extract the target PR number for a `-merge-main` PRD. The convention embeds
 * it two ways: in the frontmatter title/body as "PR #<n>" (preferred — the
 * human-authored, unambiguous source), and in the slug itself as "prNNN"
 * (fallback, for PRD text that doesn't spell it out). Returns null if neither
 * source yields a number.
 */
function extractMergeMainPrNumber(slug, prdFullText) {
  if (typeof prdFullText === 'string') {
    const m = prdFullText.match(/PR\s*#(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  const sm = typeof slug === 'string' ? slug.match(/pr(\d+)-merge-main$/) : null;
  if (sm) return parseInt(sm[1], 10);
  return null;
}

/**
 * Independently re-check a PR's mergeable state via `gh pr view`. Used only to
 * decide whether a `-merge-main` PRD's unsubstantiated PASS (no commit landed
 * during the run) reflects a target that was already satisfied by an
 * out-of-band actor before this run started — see the 2026-07-18 false-positive
 * feedback item.
 *
 * Bounded (15s) and fully fail-safe: ANY error (gh missing/unauthed, network,
 * timeout, malformed JSON, non-existent PR) resolves `{ ok: false }` rather
 * than throwing, so a failure here only ever falls back to today's behavior —
 * it can never turn a real failure into a false "verified".
 *
 * `execImpl` is injectable (defaults to `child_process.execFileSync`) so unit
 * tests can stub the subprocess call without shelling out to a real `gh`.
 *
 * @returns {{ ok: boolean, data?: { mergeable: string, mergeStateStatus: string }, error?: string }}
 */
function checkMergeablePr({ cwd, prNumber, timeoutMs = GH_CHECK_TIMEOUT_MS, execImpl = execFileSync }) {
  try {
    const out = execImpl(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'mergeable,mergeStateStatus'],
      { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const data = JSON.parse(out);
    if (data && data.mergeable === 'MERGEABLE' && data.mergeStateStatus !== 'CONFLICTING') {
      return { ok: true, data };
    }
    return { ok: false, data };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ─── prior-run-landed-commit postcondition exemption (re-fired same slug) ───

/**
 * Independently re-check, via real git ancestry, whether a commit a PREVIOUS
 * run of this same slug landed is reachable from the current HEAD. Used to
 * distinguish a truthful no-op re-run (the slug's work already shipped in an
 * earlier run, so this run correctly made no new commit) from a lying PASS
 * with no substantiating work at all.
 *
 * Bounded (15s) and fully fail-safe: ANY error (bad SHA, non-git cwd, timeout,
 * `sha` not an ancestor) resolves `false` rather than throwing, so a failure
 * here only ever falls back to today's pass_no_commit behavior — it can never
 * turn a real failure into a false "verified".
 *
 * `execImpl` is injectable (defaults to `child_process.execFileSync`) so unit
 * tests can stub the subprocess call without shelling out to real git.
 */
function isAncestorCommit({ cwd, sha, timeoutMs = GH_CHECK_TIMEOUT_MS, execImpl = execFileSync }) {
  if (!sha) return false;
  try {
    execImpl('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `cwd` is inside a git repository. Used to gate the transcript
 * commit-evidence fallback below: a job whose cwd is not a git repo can never
 * produce committedDuringRun=true (gitHead()/committedInWindow() fail closed
 * there), so the fallback must only apply in that narrow case — never when
 * git ancestry is actually observable.
 */
function isGitRepo(cwd) {
  if (!cwd) return false;
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], {
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Material check for a DECLARED artifact-only PRD (`deliverable: artifact` +
 * `artifactPaths`). Returns true only when every declared path resolves inside
 * `cwd`, is a non-empty regular file, and has an mtime inside the run window
 * (startedAt - 60s .. (finishedAt ?? now) + 120s). Never throws: any doubt
 * (no paths, `..`, escape, missing, non-file, empty, stale, fs error) → false.
 * `cwd` may be a list of roots; a path is accepted if it verifies under any.
 * Complexity O(paths).
 */
function artifactsVerifiedOnDisk({ cwd, paths, startedAt, finishedAt, fsImpl = fs } = {}) {
  return artifactsCheck({ cwd, paths, startedAt, finishedAt, fsImpl }).ok;
}

function artifactsCheck({ cwd, paths, startedAt, finishedAt, fsImpl = fs }) {
  const fail = { ok: false, verified: [] };
  try {
    const roots = (Array.isArray(cwd) ? cwd : [cwd]).filter((r) => typeof r === 'string' && r);
    if (!roots.length || !Array.isArray(paths) || paths.length === 0) return fail;
    const start = Date.parse(startedAt ?? '');
    if (Number.isNaN(start)) return fail;
    const endParsed = finishedAt ? Date.parse(finishedAt) : NaN;
    const end = Number.isNaN(endParsed) ? Date.now() : endParsed;
    const lo = start - 60_000;
    const hi = end + 120_000;
    const verified = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.includes('\0')) return fail;
      if (p.split(/[\\/]/).includes('..')) return fail;
      let hit = null;
      for (const root of roots) {
        const base = path.resolve(root);
        const abs = path.resolve(base, p);
        const rel = path.relative(base, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        let st;
        try { st = fsImpl.statSync(abs); } catch { continue; }
        if (!st.isFile() || st.size <= 0) continue;
        if (st.mtimeMs < lo || st.mtimeMs > hi) continue;
        hit = { path: p, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
        break;
      }
      if (!hit) return fail;
      verified.push(hit);
    }
    return { ok: true, verified };
  } catch {
    return fail;
  }
}

// ─── main verifier ────────────────────────────────────────────────────────────

/**
 * Verify a completed run (exit=0). Returns a verdict indicating whether the
 * scheduler should mark the job 'completed', downgrade to 'pending', or
 * escalate to 'needs_review'.
 *
 * @param {object}   params
 * @param {string}   params.runDir            Absolute path to the run directory.
 * @param {string}   params.prdPath           Absolute path to the PRD .md file.
 * @param {object}   params.queueEntry        The queue.json entry for this job.
 * @param {object[]} [params.allJobs]         All entries from queue.json (dep checks).
 * @param {boolean}  [params.committedDuringRun] True when HEAD moved during the run,
 *                                            confirming the job's commit landed.
 *                                            Default false for back-compat.
 * (`allowPreSentinelHeal` is still passed by one caller but is ignored: the pattern verdicts it healed no longer exist.)
 *                                            pass for pre-sentinel legacy runs.
 * @param {Function} [params.ghExecImpl]      Test-only override for the `gh pr view`
 *                                            subprocess call used by the -merge-main
 *                                            postcondition exemption. Defaults to
 *                                            child_process.execFileSync.
 * @param {string|null} [params.priorLandedCommit] The commit SHA a PREVIOUS run of this
 *                                            same slug landed, if any — supplied by the
 *                                            caller (scheduler.cjs). Used by the
 *                                            pass_no_commit_prior_run_verified exemption.
 * @param {string|null} [params.jobLandedCommitThisRun] The commit SHA THIS run's own
 *                                            guard cwd HEAD advanced to (spawnJob's
 *                                            `headAtExit` when it differs from
 *                                            `guardHeadBefore`), or the equivalent
 *                                            already-persisted `job.landedCommit` when
 *                                            re-verifying a stale needs_review row. This
 *                                            is a HEAD delta observed for THIS job's own
 *                                            dispatch — strictly stronger attribution than
 *                                            `committedDuringRun`'s repo-wide window scan —
 *                                            and, unlike the now-deleted `sm-job/<slug>`
 *                                            branch tip, it survives `cleanupWorktree`.
 *                                            Used by the ground-truth-outranks-heuristics
 *                                            rule below. Default null for back-compat.
 * @param {number|null} [params.exitCode]     The run's process exit code. The
 *                                            ground-truth-outranks-heuristics rule only
 *                                            ever applies when this is exactly 0 — default
 *                                            null so callers that don't pass it keep
 *                                            today's behavior byte-for-byte.
 * @returns {Promise<{verdict:string, reason:string, downgradeTo:string|null}>}
 */
async function verifyRun({
  runDir, prdPath, queueEntry, allJobs = [], committedDuringRun = false,
  ghExecImpl, priorLandedCommit = null, jobLandedCommitThisRun = null, exitCode = null, worktreeDir = null,
}) {
  const { slug } = queueEntry;
  const logPath = path.join(runDir, `${slug}.log`);
  const verdictsPath = path.join(runDir, `${slug}.verdicts.json`);

  /** Write the sidecar and return the verdict object. */
  function conclude(verdict, reason, downgradeTo, extras) {
    const record = {
      schemaVersion: VERDICTS_SCHEMA_VERSION,
      verdict,
      reason,
      downgradeTo,
      scannedAt: new Date().toISOString(),
      ...(extras ?? {}),
    };
    // Atomic (tmp+rename) — scheduler.cjs reads this sidecar to decide completed-equivalence,
    // so a torn write must never be observable. Lazy require keeps this module electron-free at load.
    try { require('./config.cjs').writeJsonSync(verdictsPath, record); } catch { /* best-effort */ }
    return { verdict, reason, downgradeTo, ...(extras ?? {}) };
  }

  try {
    // ── Read PRD body (strip frontmatter) ──────────────────────────────────
    let prdBody = '';
    let prdFullText = '';
    try {
      const prdText = fs.readFileSync(prdPath, 'utf8');
      prdFullText = prdText;
      if (prdText.startsWith('---\n')) {
        const end = prdText.indexOf('\n---', 4);
        prdBody = end !== -1 ? prdText.slice(end + 4).trim() : prdText;
      } else {
        prdBody = prdText;
      }
    } catch { /* PRD unreadable — skip PRD-level dep checks */ }

    // ── 1. Dependency check ────────────────────────────────────────────────
    // Run first: if deps are unmet we can skip the expensive log parse.
    const depsResult = checkDeps(queueEntry, allJobs);
    if (!depsResult.ok) {
      return conclude('deps_unmet', depsResult.reason, 'pending');
    }

    // ── 2. Parse log ───────────────────────────────────────────────────────
    const { events, resultEvent, error: parseError, transcriptCommitLanded, transcriptCommitShas } = parseLog(logPath);

    if (parseError) {
      return conclude('verify_unavailable', `log unreadable: ${parseError}`, 'needs_review');
    }

    // A job whose cwd is not a git repo (e.g. an investigation fix-plan that
    // inherited cwd: /tmp) can never produce committedDuringRun=true —
    // gitHead()/committedInWindow() both fail closed there. In that case
    // ONLY, fall back to the harness-emitted commit evidence in the
    // transcript, which git itself produced and the model cannot fabricate.
    //
    // jobLandedCommitThisRun (spawnJob's own guardHeadBefore/headAtExit delta,
    // or the equivalent already-persisted job.landedCommit on a re-verify
    // pass) is folded into the SAME commitEvidence signal used everywhere in
    // this function — a HEAD delta observed for THIS job's own dispatch is at
    // least as strong as the repo-wide committedDuringRun window scan, so
    // every exemption below that already trusts commitEvidence (no_verdict_
    // sentinel, pass_no_commit, the PASS+commitEvidence sentinel override)
    // should trust this evidence too, not just the new ground-truth rule.
    const cwdIsGitRepo = isGitRepo(queueEntry?.cwd);
    const commitEvidence = committedDuringRun || Boolean(jobLandedCommitThisRun) || (!cwdIsGitRepo && transcriptCommitLanded);
    let commitEvidenceSource = null;
    if (!committedDuringRun) {
      if (jobLandedCommitThisRun) commitEvidenceSource = 'jobLandedCommitThisRun';
      else if (commitEvidence) commitEvidenceSource = 'transcript';
    }

    // ── 3. HALT detection (fallback only) ─────────────────────────────────
    // The SCHEDULER_VERDICT line is the executor's final say (FINISH_PROTOCOL
    // VERDICT LINE step); the halt check is a fallback for runs that printed
    // none. Incident: Rabbits-Game 163-attack-scorecard, 2026-10-24 — a PASS
    // report quoting the marker in backticks was re-queued as a halt.
    const sentinel = scanSentinel(resultEvent, events);
    if (resultEvent && sentinel === null) {
      const haltLine = scanHaltLine(resultEvent.resultText);
      if (haltLine) {
        const rt = resultEvent.resultText;
        let reason = `Agent HALTed: ${haltLine.slice(0, 200)}`;
        // Embed machine-parseable floor date if present in HALT message.
        const dateMatch = rt.match(/~?(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) reason += ` (eligible from: ${dateMatch[1]})`;
        return conclude('halt', reason, 'pending');
      }
    }

    // ── 4. Policy-denial annotations ──────────────────────────────────────
    // The verdict depends only on outcomes (sentinel, commit evidence, exit,
    // log readability) — transcript content is never scanned for error text.
    // A PreToolUse denial is still recorded as a non-blocking annotation.
    const issues = [];
    const annotations = [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.kind !== 'tool_result' || ev.parentToolUseId) continue;
      if (isPolicyDenial(ev.content)) {
        annotations.push({
          verdict: 'policy_denial',
          reason: `PreToolUse policy denial at event ${i}: ${ev.content.slice(0, 200)}`,
        });
      }
    }

    // An explicit executor FAIL is always blocking — outranks every other
    // verdict and every override below (early return). Transcript issues are
    // kept as annotations so nothing is lost.
    if (sentinel === 'fail') {
      const failReason = scanSentinelReason(resultEvent, events);
      const kept = [...annotations, ...issues.map((i) => ({ verdict: i.verdict, reason: i.reason }))];
      return conclude(
        'sentinel_fail',
        'executor reported SCHEDULER_VERDICT: FAIL' + (failReason ? ': ' + failReason : ''),
        'needs_review',
        { sentinel, ...(kept.length ? { annotations: kept } : {}) },
      );
    }

    const sentinelFields = sentinel ? { sentinel } : {};
    const extras = (annotations.length || sentinel)
      ? { ...(annotations.length ? { annotations } : {}), ...sentinelFields }
      : undefined;

    // No pattern hits is not automatically "clean": a run that neither
    // committed anything nor ever emitted the finish-protocol sentinel did not
    // finish for SOME reason. When the transcript shows the harness's
    // auto-background marker, that reason is knowable and cheap to recover
    // from: the run backgrounded a long Bash command past its foreground
    // timeout and ended waiting for a "you will be notified" callback a
    // headless run can never receive — it did not necessarily fail to do the
    // work, it failed to come back and commit it. That gets its own verdict
    // (abandoned_background_task) so the auto-fix investigation checks the
    // working tree for already-written work first, instead of re-planning the
    // whole PRD from a wrong "stopped on a clarifying question" premise.
    if (sentinel === null && !commitEvidence) {
      if (hasAbandonedBackgroundTask(events)) {
        issues.push({
          verdict: 'abandoned_background_task',
          reason: 'run made no commit and emitted no SCHEDULER_VERDICT sentinel, and the transcript shows a Bash command auto-backgrounded past its foreground timeout — the run likely ended waiting for a background-task notification a headless run cannot receive, not because the work failed; the work is probably already written and just needs to be committed',
          priority: 1,
        });
      } else {
        issues.push({
          verdict: 'no_verdict_sentinel',
          reason: 'run made no commit and emitted no SCHEDULER_VERDICT sentinel — the run ended before the finish protocol for some reason (stopped on a clarifying question, crashed, ran out of turns, or another cause not identifiable from this transcript alone)',
          priority: 1,
        });
      }
    }

    // A truthful-looking PASS sentinel with no commit is still not "clean":
    // the finish protocol requires the commit to land before printing PASS
    // (see the module's finish-protocol docs), so a PASS with no commit means
    // the run's own claim of success is unsubstantiated — route it to
    // needs_review so the auto-fix pipeline can investigate rather than
    // silently accepting a bare sentinel as proof of work done. Mutually
    // exclusive with the no_verdict_sentinel case above (sentinel === null
    // vs sentinel === 'pass'), kept as a separate sibling check for clarity.
    //
    // EXEMPTION: fix-plan jobs (slug matches ^\d+-fix-) are investigations —
    // "I checked, the original work already landed correctly, nothing to
    // change" is a legitimate, correct, common outcome for them, not a
    // silent no-op bug. Applying this check to fix-plan jobs the same way as
    // original feature/bugfix PRDs produced a false-positive cascade
    // (2026-07-12: 523-fix-bounded-fix-plan-retry re-verified PRD 523, found
    // it already fully implemented and committed, correctly declined to make
    // a no-op commit, and printed a truthful PASS — but still got flagged
    // needs_review). Original PRDs are expected to build something new, so a
    // bare PASS with no commit from one is still a strong silent-failure
    // signal and stays covered by this check.
    const isFixPlanJob = /^\d+-fix-/.test(queueEntry?.slug || '');
    // A transcript-reported commit that is not reachable from the repo was
    // dropped (detached HEAD, off-branch); no no-commit exemption may excuse it.
    let unlandedTranscriptShas = [];
    if (sentinel === 'pass' && !commitEvidence && cwdIsGitRepo) {
      unlandedTranscriptShas = (transcriptCommitShas || [])
        .filter((sha) => !isAncestorCommit({ cwd: queueEntry?.cwd, sha }));
    }
    if (unlandedTranscriptShas.length > 0) {
      issues.push({
        verdict: 'run_commit_not_landed',
        reason: 'SCHEDULER_VERDICT: PASS but the transcript reports a commit that is not reachable from the repo: '
          + unlandedTranscriptShas.join(', '),
        priority: 1,
        downgradeTo: 'needs_review',
      });
    } else if (sentinel === 'pass' && !commitEvidence && !isFixPlanJob) {
      // EXEMPTION: `-merge-main` PRDs (see isMergeMainSlug) can genuinely and
      // correctly find nothing left to do when an out-of-band actor (a human,
      // another agent, a sibling scheduler job) already merged/updated the
      // target PR branch before this run started. Before flagging, independently
      // re-check the PR's real mergeable state via `gh` — if it confirms the
      // target is already clean, this is not a false PASS, it's a correct one.
      // Fails safe: any `gh` error falls straight through to the pass_no_commit
      // flag below, exactly as before this exemption existed.
      let mergeMainVerified = false;
      if (isMergeMainSlug(slug)) {
        const prNumber = extractMergeMainPrNumber(slug, prdFullText);
        if (prNumber != null) {
          const ghResult = checkMergeablePr({
            cwd: queueEntry?.cwd,
            prNumber,
            ...(ghExecImpl ? { execImpl: ghExecImpl } : {}),
          });
          if (ghResult.ok) {
            mergeMainVerified = true;
            return conclude(
              'pass_no_commit_target_verified',
              `SCHEDULER_VERDICT: PASS with no commit, but independently verified PR #${prNumber} is mergeable `
                + `(mergeStateStatus: ${ghResult.data.mergeStateStatus}) — target was already satisfied by an `
                + 'out-of-band actor before this run started',
              null,
              {
                ...(annotations.length ? { annotations } : {}),
                sentinel,
                verifiedPrNumber: prNumber,
                ghMergeState: ghResult.data,
              },
            );
          }
        }
      }
      // EXEMPTION: the SAME slug was already executed by a PRIOR run that
      // landed a commit, and that commit is still reachable from HEAD. "I
      // re-checked every AC item, found it all already implemented by an
      // earlier run of this exact PRD, declined to make a no-op commit, and
      // printed a truthful PASS" is correct, idempotent behavior — the
      // systemic false-failure class this exemption exists to catch.
      // (Incident: 812-workbench-review-nits-cleanup, 2026-07-31 — re-fired
      // ~24 min after its own prior run landed 00d891c; re-verified,
      // re-ran typecheck + 17 green tests, made no new commit, printed a
      // truthful PASS, and was parked in needs_review anyway.)
      let priorRunVerified = false;
      if (!mergeMainVerified && priorLandedCommit
        && isAncestorCommit({ cwd: queueEntry?.cwd, sha: priorLandedCommit })) {
        priorRunVerified = true;
        return conclude(
          'pass_no_commit_prior_run_verified',
          `SCHEDULER_VERDICT: PASS with no commit, but a prior run of this slug landed ${priorLandedCommit}, `
            + 'which is an ancestor of HEAD — the PRD\'s work is already in the tree, so this re-run correctly '
            + 'made no change',
          null,
          {
            ...(annotations.length ? { annotations } : {}),
            sentinel,
            priorLandedCommit,
          },
        );
      }
      // EXEMPTION: a PRD that DECLARES `deliverable: artifact` + `artifactPaths`
      // (all deliverables live in a git-excluded dir, so "no commit" is
      // correct). Reads the declared list from frontmatter — never scrapes
      // prose — and stat-checks each file on disk (non-empty, in the run
      // window). Paths resolve against queueEntry.cwd, then retry against the
      // run's worktree dir when the caller supplies one. Any doubt falls
      // through to pass_no_commit below. The commit guard separately requires
      // a clean tree for this verdict (scheduler.cjs commitGuardVerdict).
      let artifactVerified = false;
      if (!mergeMainVerified && !priorRunVerified) {
        let fm = null;
        try { fm = parsePrdFile(prdFullText).frontmatter; } catch { fm = null; }
        if (fm && fm.deliverable === 'artifact' && Array.isArray(fm.artifactPaths) && fm.artifactPaths.length > 0) {
          const check = artifactsCheck({
            cwd: [queueEntry?.cwd, worktreeDir],
            paths: fm.artifactPaths,
            startedAt: queueEntry?.startedAt,
            finishedAt: queueEntry?.finishedAt,
          });
          if (check.ok) {
            artifactVerified = true;
            return conclude(
              'pass_no_commit_artifact_verified',
              'SCHEDULER_VERDICT: PASS with no commit, but every declared artifact exists, is non-empty, and was '
                + `written inside the run window (${check.verified.map((v) => v.path).join(', ')})`,
              null,
              {
                ...(annotations.length ? { annotations } : {}),
                sentinel,
                verifiedArtifacts: check.verified,
              },
            );
          }
        }
      }
      if (!mergeMainVerified && !priorRunVerified && !artifactVerified) {
        issues.push({
          verdict: 'pass_no_commit',
          reason: 'SCHEDULER_VERDICT: PASS but no commit landed during the run window — the run claims success but produced no code change',
          priority: 1,
        });
      }
    }

    if (issues.length === 0) {
      const reason = annotations.length
        ? `no blocking issues (${annotations.length} annotation(s): ${annotations.map((a) => a.reason).join('; ')})`
        : 'no issues detected';
      return conclude('clean', reason, null, extras);
    }

    // Highest-priority outcome issue wins (stable sort keeps loop order on ties).
    issues.sort((a, b) => b.priority - a.priority);
    const top = issues[0];

    return conclude(top.verdict, top.reason, 'needs_review', extras);

  } catch (e) {
    return conclude(
      'verify_unavailable',
      `verifier threw: ${e?.message ?? String(e)}`,
      'needs_review',
    );
  }
}

module.exports = {
  verifyRun,
  // Exposed for unit tests.
  isPolicyDenial,
  checkDeps,
  parseLog,
  scanSentinel,
  scanHaltLine,
  scanSentinelReason,
  scanForeignWipPathsClaim,
  isMergeMainSlug,
  extractMergeMainPrNumber,
  checkMergeablePr,
  artifactsVerifiedOnDisk,
  isAncestorCommit,
  isGitRepo,
  hasAbandonedBackgroundTask,
};
