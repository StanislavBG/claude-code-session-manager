#!/usr/bin/env node
/**
 * guard-prd-writes.cjs — PreToolUse hook that denies a raw Write/Edit/
 * NotebookEdit tool call whose target path falls under
 * `**\/session-manager-operations/scheduler/**`.
 *
 * Why this exists: opsOwnership.cjs's assertOpsWrite already enforces the
 * single-writer law for scheduler/ (see src/main/lib/opsOwnership.cjs), but
 * it can only guard the app's OWN in-process write helpers — it is
 * structurally incapable of stopping an agent that reaches for the Write
 * tool directly, which is exactly what CLAUDE.md itself documents as the
 * degraded last-resort path. A PreToolUse hook is the one lever that sits
 * OUTSIDE the app and can intercept that call before it ever touches disk:
 * the harness adjudicates the tool call, not the app.
 *
 * Together with the create-time provenance stamp (prdCreate.cjs's
 * buildPrdBody) and reconcile()'s quarantine of any PRD missing that stamp
 * (scheduler.cjs), this makes the scheduler_create_prd/scheduler_update_prd/
 * scheduler_archive_prd MCP tools the only path IN, from outside the app
 * (this hook) and from inside it (the provenance gate) alike.
 *
 * ── Install (per-project, NOT machine-wide) ─────────────────────────────
 * Add to this project's `.claude/settings.json` (not `~/.claude/settings.json`
 * — project scope only, so the guard applies to sessions run against THIS
 * repo, not every project on the machine):
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Write|Edit|NotebookEdit",
 *           "hooks": [
 *             { "type": "command", "command": "node scripts/hooks/guard-prd-writes.cjs" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * ── Adopting this hook in a DIFFERENT (non-session-manager) project ──────
 * DON'T HAND-WRITE THIS. Session Manager installs it: open New Session in
 * that project and press "Fix it" on the readiness banner's PRD-write-guard
 * row (src/main/lib/delegationReadiness.cjs's installPrdWriteGuard, which
 * merges into any existing hooks block instead of clobbering it).
 *
 * The standardized approach is REFERENCE, not vendor — do NOT copy this file
 * into the adopting repo. Vendoring drifts (it already did, with exactly one
 * adopter), and what is being guarded is session-manager-operations/scheduler/,
 * Session Manager's own territory inside someone else's repo, so the
 * enforcement logic belongs with the owner.
 *
 * This file lives in the session-manager repo, so a relative
 * `node scripts/hooks/guard-prd-writes.cjs` command only resolves when the
 * hook runs with THIS repo as cwd. Pasting that relative string into another
 * project yields a hook that exits non-zero WITHOUT code 2 — a non-blocking
 * error — so it silently guards nothing. Any other project's
 * `.claude/settings.json` must reference this file by its ABSOLUTE path:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Write|Edit|NotebookEdit",
 *           "hooks": [
 *             {
 *               "type": "command",
 *               "command": "node /home/bilko/Projects/session-manager/scripts/hooks/guard-prd-writes.cjs"
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * This is still opt-in per project, same as above — never auto-install this
 * into every project's settings without the human choosing to add it there.
 *
 * Roll out to another project by copying this file + the same settings.json
 * entry into that project — deliberately not published as a global/user-
 * scoped hook so a project can opt in individually (see this PRD's
 * Implementation notes: "scope the hook to the session-manager repo first").
 *
 * ── Uninstall ────────────────────────────────────────────────────────────
 * Remove the `PreToolUse` entry above from `.claude/settings.json`. The
 * script is inert with no settings.json entry pointing at it — deleting the
 * file itself is optional and has no other effect.
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 * - Reads a PreToolUse payload on stdin: { tool_name, tool_input, cwd, ... }.
 * - Reads (any tool that isn't a mutation, and any Read/Grep/Glob/Bash) is
 *   NEVER denied — this hook only inspects Write/Edit/NotebookEdit calls;
 *   everything else is allowed by construction (the matcher already scopes
 *   this hook to those three tools, but the tool_name check below is a
 *   second, defense-in-depth gate in case the matcher is ever widened).
 * - A fix-plan PRD (`NN-fix-*.md`) is exempt: scheduler.cjs's own
 *   spawnInvestigation probe writes that file directly by design (a trusted,
 *   scheduler-spawned internal loop, not an agent/human authoring a PRD) —
 *   see scheduler.cjs's isFixPlanSlug and reconcile()'s matching exemption.
 * - Fails OPEN: any internal error (malformed stdin JSON, an unreadable
 *   payload, an unexpected shape) is logged to stderr and allowed through —
 *   a broken guard must never brick the whole Write/Edit tool.
 */
'use strict';

const path = require('node:path');

const SCHEDULER_SEGMENT = `${path.sep}session-manager-operations${path.sep}scheduler${path.sep}`;
const FIX_PLAN_RE = /^\d+-fix-.*\.md$/;

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
    console.error(`[guard-prd-writes] malformed stdin JSON, failing open: ${e?.message}`);
    return allow();
  }

  try {
    const toolName = payload.tool_name;
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
      return allow();
    }

    const rawPath = targetPathFor(toolName, payload.tool_input);
    if (!rawPath || typeof rawPath !== 'string') return allow();

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

    if (!absPath.includes(SCHEDULER_SEGMENT)) return allow();

    const base = path.basename(absPath);
    if (FIX_PLAN_RE.test(base)) return allow();

    const suggested = suggestedToolFor(toolName, absPath);
    const reason = [
      `Direct ${toolName} to a session-manager-operations/scheduler/ path is blocked.`,
      `PRDs must be authored through the scheduler API, not a raw file write — use the "${suggested}" MCP tool instead.`,
      'If the Session Manager app is not running (the admin API this MCP tool talks to only exists while it is), the degraded fallback documented in the develop skill applies: hand-write the file as a last resort and say so visibly in your report.',
    ].join(' ');
    return deny(reason);
  } catch (e) {
    console.error(`[guard-prd-writes] internal error, failing open: ${e?.message}`);
    return allow();
  }
}

main().catch((e) => {
  console.error(`[guard-prd-writes] unhandled error, failing open: ${e?.message}`);
  allow();
});
