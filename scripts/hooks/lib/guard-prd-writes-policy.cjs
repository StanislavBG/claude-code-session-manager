/**
 * guard-prd-writes-policy.cjs — decision logic for
 * scripts/hooks/guard-prd-writes.cjs, split out so it can be `require()`d
 * in-process (by tests, notably) with no CLI-level side effects.
 *
 * guard-prd-writes.cjs itself runs its CLI as a require-time side effect
 * (stdin -> decision -> process.exit, not gated on `require.main === module`
 * — see its header for why). Requiring THIS module never reads stdin or
 * calls `process.exit`. `decide()` is fully I/O-free — it only does path
 * arithmetic on `payload` — so calling it directly from a test is equivalent
 * to the real CLI decision, without a child-process spawn per case.
 */
'use strict';

const path = require('node:path');

const SCHEDULER_SEGMENT = `${path.sep}session-manager-operations${path.sep}scheduler${path.sep}`;
const FIX_PLAN_RE = /^\d+-fix-.*\.md$/;

/** Extract the single filesystem path a Write/Edit/NotebookEdit call targets. */
function targetPathFor(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolName === 'NotebookEdit') return toolInput.notebook_path ?? null;
  return toolInput.file_path ?? null;
}

/** MCP tool name to point the agent at, based on the attempted operation. */
function suggestedToolFor(toolName, absPath) {
  const isArchived = absPath.includes(`${path.sep}prds-archived${path.sep}`);
  if (isArchived) return 'mcp__session-manager-scheduler__scheduler_archive_prd';
  // Write = the file doesn't exist yet from the agent's point of view (a
  // brand-new PRD); Edit/NotebookEdit = mutating an existing file in place.
  if (toolName === 'Write') return 'mcp__session-manager-scheduler__scheduler_create_prd';
  return 'mcp__session-manager-scheduler__scheduler_update_prd';
}

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
 * tests), and fully I/O-free.
 */
function decide(payload) {
  try {
    const toolName = payload.tool_name;
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
      return buildAllow();
    }

    const rawPath = targetPathFor(toolName, payload.tool_input);
    if (!rawPath || typeof rawPath !== 'string') return buildAllow();

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

    if (!absPath.includes(SCHEDULER_SEGMENT)) return buildAllow();

    const base = path.basename(absPath);
    if (FIX_PLAN_RE.test(base)) return buildAllow();

    const suggested = suggestedToolFor(toolName, absPath);
    const reason = [
      `Direct ${toolName} to a session-manager-operations/scheduler/ path is blocked.`,
      `PRDs must be authored through the scheduler API, not a raw file write — use the "${suggested}" MCP tool instead.`,
      'If the Session Manager app is not running (the admin API this MCP tool talks to only exists while it is), the degraded fallback documented in the develop skill applies: hand-write the file as a last resort and say so visibly in your report.',
    ].join(' ');
    return buildDeny(reason);
  } catch (e) {
    console.error(`[guard-prd-writes] internal error, failing open: ${e?.message}`);
    return buildAllow();
  }
}

/** Mirrors the CLI's stdin-JSON handling so it can be exercised without a spawn. */
function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`[guard-prd-writes] malformed stdin JSON, failing open: ${e?.message}`);
    return {};
  }
}

module.exports = { decide, parsePayload };
