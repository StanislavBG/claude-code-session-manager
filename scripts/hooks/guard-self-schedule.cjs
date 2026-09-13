#!/usr/bin/env node
/**
 * guard-self-schedule.cjs — PreToolUse hook that denies `ScheduleWakeup`,
 * `CronCreate`, and any backgrounded `Task`/`Agent` invocation
 * (`run_in_background` truthy) from INSIDE a scheduler-spawned headless
 * `claude -p` run.
 *
 * Why this exists: standards.md's Execution discipline section already says,
 * in prose, "You ARE the executor — never re-queue or self-schedule" — and
 * spells out the ScheduleWakeup/background-agent case explicitly. Prose has
 * now failed three times: PRD 460 invoked `/develop` and exited 0 having done
 * nothing; PRD 479 landed its commit, then backgrounded `/code-review --fix`
 * + `/security-review` and called ScheduleWakeup to "wait" for them; PRD 1204
 * (2026-09-13) did the same with the `code-review` skill's 8-agent fan-out —
 * correct, committed-ready work sat in a `ListAgents` wait loop until the
 * reaper terminalized the row, work still uncommitted. A headless run has no
 * later turn: nothing ever delivers the wakeup or collects the background
 * agent's result, so the process just exits and the job parks in
 * `needs_review` even when the underlying work was right. A PreToolUse hook
 * is the one lever that sits OUTSIDE the model and can refuse the call before
 * it schedules anything — see guard-prd-writes.cjs's header for the fuller
 * argument for why a hook, not a rule, is the fix.
 *
 * ── Scope: headless scheduler runs ONLY ──────────────────────────────────
 * Detection is purely env-based: `scheduler.cjs`'s `executeJob` stamps every
 * spawned job's child process (and everything it inherits its env to,
 * including PreToolUse hook subprocesses) with `SM_SCHEDULER_JOB_SLUG` — the
 * same marker `scheduler-mcp-server.cjs` already reads to refuse a self-queue
 * `scheduler_create_prd` call, and `prdCreate.cjs` reads to pick the
 * non-interactive default for a disposition prompt. When that env var is
 * absent (an interactive Epic's Terminal/Chat session), this hook allows
 * everything — an interactive Epic must keep full, unrestricted use of
 * ScheduleWakeup and background agents; that is a legitimate, common pattern
 * this guard must never touch.
 *
 * Unlike `SM_SCHEDULER_JOB_MAY_QUEUE` (which exempts an `architect` persona's
 * job so it may still call `scheduler_create_prd`), this guard does NOT carve
 * out any persona. Every headless job — whatever its `agentType` — runs as a
 * single, un-resumable process; scheduling a wakeup or backgrounding a review
 * agent is equally structurally wrong no matter who the job is running as.
 *
 * ── Fail-open everywhere else ─────────────────────────────────────────────
 * Any internal error (malformed stdin JSON, an unexpected payload shape) is
 * logged to stderr and allowed through — a broken guard must never brick the
 * whole tool. This mirrors guard-prd-writes.cjs, not guard-destructive-git.cjs's
 * fail-closed-on-ambiguity stance: unlike an irreversible git operation, a
 * parse failure here just means the run keeps whatever behavior it already
 * had, which is the safer default for a guard scoped this narrowly.
 *
 * ── Install ───────────────────────────────────────────────────────────────
 * Registered in `guardShims.cjs`'s `GUARD_NAMES` and auto-installed by
 * `delegationReadiness.cjs`'s `ensureGuardsInstalled` (the New Epic readiness
 * banner's silent self-heal path) exactly like the other three guards, via
 * the same stable shim (`~/.claude/session-manager/hooks/guard-self-schedule.cjs`)
 * — never a hard-coded ephemeral `npx` app path. Add to a project's
 * `.claude/settings.json` (project scope only):
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "ScheduleWakeup|CronCreate|Task|Agent",
 *           "hooks": [
 *             { "type": "command", "command": "node scripts/hooks/guard-self-schedule.cjs" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * ── Uninstall ────────────────────────────────────────────────────────────
 * Remove this hook's entry from `.claude/settings.json`. The script is inert
 * with no settings.json entry pointing at it.
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 * - Reads a PreToolUse payload on stdin: { tool_name, tool_input, ... }.
 * - Allowed by construction whenever `process.env.SM_SCHEDULER_JOB_SLUG` is
 *   unset — the whole point of this guard is to be provably inert outside a
 *   headless scheduler run.
 * - Denies `ScheduleWakeup` and `CronCreate` unconditionally when the marker
 *   is present.
 * - Denies `Task`/`Agent` (the harness's own tool name for the Agent tool is
 *   `Task` — see classifyTranscriptLine.cjs, which checks both names for the
 *   same reason) only when `tool_input.run_in_background` is truthy. An
 *   inline/synchronous call (absent or explicitly `false`) is always allowed
 *   — standards.md sanctions running a review pass synchronously, inline,
 *   before the finish protocol.
 * - Every other tool (including the `Skill` tool generally) is allowed by
 *   construction — this guard only ever inspects the four names above.
 */
'use strict';

const ALWAYS_DENY_TOOLS = new Set(['ScheduleWakeup', 'CronCreate']);
const BACKGROUNDABLE_AGENT_TOOLS = new Set(['Task', 'Agent']);

const STANDARDS_QUOTE = 'You ARE the executor — never re-queue or self-schedule.';
const STANDARDS_CITE = 'plugins/session-manager-dev/skills/develop/standards.md:85 (Execution discipline)';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Fail open if stdin never closes/errors for some reason.
    process.stdin.on('error', () => resolve(data));
  });
}

function allow() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    continue: true,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`[guard-self-schedule] malformed stdin JSON, failing open: ${e?.message}`);
    return allow();
  }

  try {
    const jobSlug = process.env.SM_SCHEDULER_JOB_SLUG;
    if (!jobSlug) return allow(); // interactive session — this guard is inert here

    const toolName = payload.tool_name;

    if (ALWAYS_DENY_TOOLS.has(toolName)) {
      const reason = [
        `Blocked: \`${toolName}\` from inside a headless scheduler-spawned run (job '${jobSlug}').`,
        `${STANDARDS_CITE}: "${STANDARDS_QUOTE}"`,
        'A headless run has no next turn — nothing will ever deliver this wakeup, so the job exits with its work stranded and parks in needs_review even if it was already correct.',
        'Do it now instead: commit what you have, then run any required review synchronously inline (call the reviewer and read its result in this same turn) before the finish protocol — never schedule it for later.',
      ].join(' ');
      return deny(reason);
    }

    if (BACKGROUNDABLE_AGENT_TOOLS.has(toolName) && payload.tool_input && payload.tool_input.run_in_background) {
      const reason = [
        `Blocked: a backgrounded ${toolName} call (run_in_background: true) from inside a headless scheduler-spawned run (job '${jobSlug}').`,
        `${STANDARDS_CITE}: "${STANDARDS_QUOTE}"`,
        'A headless run has no later turn to collect a background agent\'s result, so waiting on it (ListAgents, Monitor, ScheduleWakeup) strands the job in needs_review with its work already done but uncommitted.',
        'Call it synchronously instead — omit run_in_background (or set it to false) and read its result in this same turn, before the finish protocol.',
      ].join(' ');
      return deny(reason);
    }

    return allow();
  } catch (e) {
    console.error(`[guard-self-schedule] internal error, failing open: ${e?.message}`);
    return allow();
  }
}

main().catch((e) => {
  console.error(`[guard-self-schedule] unhandled error, failing open: ${e?.message}`);
  allow();
});
