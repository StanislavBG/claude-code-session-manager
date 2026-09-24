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
 * Adopted by REFERENCE through the stable shim
 * `~/.claude/session-manager/hooks/guard-prd-writes.cjs`, written by
 * src/main/lib/guardShims.cjs (installed by src/main/lib/delegationReadiness.cjs).
 * The shim carries no guard logic — it reads `app-root.json` and require()s this
 * file from the currently running app, so an app upgrade never breaks an adopter.
 * Never vendor: do not copy this file into another repo, and do not hardcode an
 * absolute path to it in another project's `.claude/settings.json`.
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

const { decide, parsePayload } = require('./lib/guard-prd-writes-policy.cjs');

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
  return emit(decide(parsePayload(raw)));
}

// Runs as a require-time side effect, NOT gated on `require.main === module`
// — see src/main/lib/guardShims.cjs's header: the installed shim invokes this
// script via a plain `require()`, so gating on `require.main` would silently
// stop the shim from ever running the guard.
main().catch((e) => {
  console.error(`[guard-prd-writes] unhandled error, failing open: ${e?.message}`);
  emit({ continue: true });
});
