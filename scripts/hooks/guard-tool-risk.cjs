#!/usr/bin/env node
/**
 * guard-tool-risk.cjs — PreToolUse hook that refuses a Bash or MCP call whose
 * resolved risk mark is `irreversible`, `money` or `public` inside a headless
 * scheduler job, unless the job's PRD clears it.
 *
 * Marks live in two Claude config layers, read and matched only through
 * src/main/lib/claude/toolRiskMarks.cjs:
 *   System  = ~/.claude/tool-risk.json
 *   Project = <SM_PROJECT_ROOT>/.claude/tool-risk.json (the main checkout —
 *             never payload.cwd, which in a job is a worktree it can rewrite)
 * A matching Project rule beats every System rule.
 *
 * Why a hook and not a prompt: a sentence in a job's prompt saying "don't
 * publish" is advice the model can talk itself past; PRD 460/479/1204 (see
 * guard-self-schedule.cjs) showed prose rules fail in headless runs. A
 * PreToolUse hook sits outside the model and refuses the call before it runs
 * — verified on CLI 2.1.325 to block both Bash and MCP calls even under
 * --dangerously-skip-permissions, with permissionDecisionReason reaching the
 * model verbatim.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 * - Headless (env SM_SCHEDULER_JOB_SLUG, or SM_TOOL_RISK_HEADLESS=1): a
 *   blocking mark is denied unless an entry of the JSON array in
 *   SM_SCHEDULER_JOB_RISK_TOOLS (the PRD's riskTools) matches the call.
 *   A marks file that exists but is invalid denies every Bash/MCP call (fail
 *   closed). Write/Edit/NotebookEdit of any tool-risk.json is denied — marks
 *   are human-owned and edited in Settings.
 * - Interactive: inert, unless the Project layer sets `interactive: true`;
 *   then a blocking mark is denied in a Chat turn (SM_CHAT_SESSION_ID set —
 *   a -p turn has no approval surface, and the CLI turns 'ask' into a generic
 *   auto-deny) and answered with 'ask' in a Terminal session.
 * - Any other internal error fails open with a stderr line, like
 *   guard-self-schedule.cjs.
 *
 * ── Install ──────────────────────────────────────────────────────────────
 * Listed in guardShims.cjs's GUARD_NAMES, so it gets a stable shim at
 * ~/.claude/session-manager/hooks/guard-tool-risk.cjs. It is NOT a New Epic
 * readiness item: the scheduler injects it into job spawns. To run it by hand:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Bash|mcp__.*|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch",
 *           "hooks": [
 *             { "type": "command", "command": "node ~/.claude/session-manager/hooks/guard-tool-risk.cjs" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 * Reads a PreToolUse payload on stdin ({ tool_name, tool_input, cwd, ... })
 * and writes one hook-response JSON object on stdout; always exits 0.
 * Decision logic: scripts/hooks/lib/guard-tool-risk-policy.cjs.
 */
'use strict';

const { decide, parsePayload } = require('./lib/guard-tool-risk-policy.cjs');

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

function emit(result) {
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  return emit(decide(parsePayload(raw), process.env));
}

// Runs as a require-time side effect, NOT gated on `require.main === module`
// — see src/main/lib/guardShims.cjs's header: the installed shim invokes this
// script via a plain `require()`, so gating on `require.main` would silently
// stop the shim from ever running the guard.
main().catch((e) => {
  console.error(`[guard-tool-risk] unhandled error, failing open: ${e?.message}`);
  emit({ continue: true });
});
