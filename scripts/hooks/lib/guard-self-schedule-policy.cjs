/**
 * guard-self-schedule-policy.cjs — decision logic for
 * scripts/hooks/guard-self-schedule.cjs, split out so it can be `require()`d
 * in-process (by tests, notably) with no CLI-level side effects.
 *
 * guard-self-schedule.cjs itself runs its CLI as a require-time side effect
 * (stdin -> decision -> process.exit, not gated on `require.main === module`
 * — see its header for why). Requiring THIS module never reads stdin or
 * calls `process.exit`. `decide()` is fully I/O-free — it only reads
 * `payload` and `process.env.SM_SCHEDULER_JOB_SLUG` — so calling it directly
 * from a test is equivalent to the real CLI decision, without a child-process
 * spawn per case.
 */
'use strict';

const ALWAYS_DENY_TOOLS = new Set(['ScheduleWakeup', 'CronCreate']);
const BACKGROUNDABLE_AGENT_TOOLS = new Set(['Task', 'Agent']);

const STANDARDS_QUOTE = 'You ARE the executor — never re-queue or self-schedule.';
const STANDARDS_CITE = 'plugins/session-manager-dev/skills/develop/standards.md:85 (Execution discipline)';

function buildAllow() {
  return { continue: true };
}

function buildDeny(reason) {
  return {
    continue: true,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Decision function: PreToolUse payload in, hook-response object out. No
 * stdin/stdout and no `process.exit` — safe to call in-process (e.g. from
 * tests). Reads `process.env.SM_SCHEDULER_JOB_SLUG` at call time, not at
 * module-load time, so a test can set/restore it around each call.
 */
function decide(payload) {
  try {
    const jobSlug = process.env.SM_SCHEDULER_JOB_SLUG;
    if (!jobSlug) return buildAllow(); // interactive session — this guard is inert here

    const toolName = payload.tool_name;

    if (ALWAYS_DENY_TOOLS.has(toolName)) {
      const reason = [
        `Blocked: \`${toolName}\` from inside a headless scheduler-spawned run (job '${jobSlug}').`,
        `${STANDARDS_CITE}: "${STANDARDS_QUOTE}"`,
        'A headless run has no next turn — nothing will ever deliver this wakeup, so the job exits with its work stranded and parks in needs_review even if it was already correct.',
        'Do it now instead: commit what you have, then run any required review synchronously inline (call the reviewer and read its result in this same turn) before the finish protocol — never schedule it for later.',
      ].join(' ');
      return buildDeny(reason);
    }

    if (BACKGROUNDABLE_AGENT_TOOLS.has(toolName) && payload.tool_input && payload.tool_input.run_in_background) {
      const reason = [
        `Blocked: a backgrounded ${toolName} call (run_in_background: true) from inside a headless scheduler-spawned run (job '${jobSlug}').`,
        `${STANDARDS_CITE}: "${STANDARDS_QUOTE}"`,
        'A headless run has no later turn to collect a background agent\'s result, so waiting on it (ListAgents, Monitor, ScheduleWakeup) strands the job in needs_review with its work already done but uncommitted.',
        'Call it synchronously instead — omit run_in_background (or set it to false) and read its result in this same turn, before the finish protocol.',
      ].join(' ');
      return buildDeny(reason);
    }

    return buildAllow();
  } catch (e) {
    console.error(`[guard-self-schedule] internal error, failing open: ${e?.message}`);
    return buildAllow();
  }
}

/** Mirrors the CLI's stdin-JSON handling so it can be exercised without a spawn. */
function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`[guard-self-schedule] malformed stdin JSON, failing open: ${e?.message}`);
    return {};
  }
}

module.exports = { decide, parsePayload };
