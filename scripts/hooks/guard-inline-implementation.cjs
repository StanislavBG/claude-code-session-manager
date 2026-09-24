#!/usr/bin/env node
/**
 * guard-inline-implementation.cjs — PreToolUse hook that denies a raw
 * Write/Edit/NotebookEdit tool call against application source (`src/`,
 * `scripts/`, `plugins/`, `bin/`) when the calling session resolves to an
 * Epic whose Mission tag is `feature` or `bug`.
 *
 * Why this exists: CLAUDE.md already tells an Actor to decompose feature/bug
 * work into scheduled PRDs via /develop rather than implementing inline, but
 * a prompt-level instruction is advisory — nothing stops an Epic from
 * reaching for the Write tool directly anyway. guard-prd-writes.cjs proved
 * the lever: a PreToolUse hook sits OUTSIDE the app and can intercept the
 * tool call before it touches disk, which an in-app ownership check
 * structurally cannot do. This is the sibling guard for the same reason,
 * applied to application source instead of scheduler/ PRDs.
 *
 * This is a NUDGE, not an ownership law — unlike guard-prd-writes.cjs (which
 * is deliberately fail-closed), this hook fails OPEN twice over: on any
 * internal error, and whenever the calling Epic can't be resolved to a
 * feature/bug tag at all. A false deny blocks a human who deliberately asked
 * for an inline fix, which is worse than an occasional missed catch.
 *
 * ── Escape hatches ───────────────────────────────────────────────────────
 * - Set `SM_ALLOW_INLINE_IMPLEMENTATION=1` in the environment the session
 *   runs under to allow everything, for the whole process.
 * - Set a truthy `allowInlineImplementation` field on the Epic's record in
 *   `session-manager-operations/prompt-sessions/active-index.json` to allow
 *   everything for that one Epic only.
 *
 * ── Install (per-project, NOT machine-wide) ─────────────────────────────
 * Adopted by REFERENCE through the stable shim
 * `~/.claude/session-manager/hooks/guard-inline-implementation.cjs`, written by
 * src/main/lib/guardShims.cjs (installed by src/main/lib/delegationReadiness.cjs's
 * installInlineImplementationGuard(), via "Fix it" on the New Epic readiness
 * banner). Never vendor: do not copy this file or hardcode an absolute path to it.
 * The example below is THIS repo's own `.claude/settings.json` (relative command,
 * cwd = repo root); add the command alongside guard-prd-writes.cjs in the SAME
 * `Write|Edit|NotebookEdit` matcher's `hooks` array:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Write|Edit|NotebookEdit",
 *           "hooks": [
 *             { "type": "command", "command": "node scripts/hooks/guard-prd-writes.cjs" },
 *             { "type": "command", "command": "node scripts/hooks/guard-inline-implementation.cjs" }
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
 * - Reads a PreToolUse payload on stdin: { session_id, tool_name, tool_input,
 *   cwd, ... }.
 * - Only inspects Write/Edit/NotebookEdit; every other tool is allowed by
 *   construction.
 * - Resolves `session_id` against `claudeSessionId` in
 *   `<cwd>/session-manager-operations/prompt-sessions/active-index.json`'s
 *   `sessions` map. An unresolvable session is ALLOWED — this hook only ever
 *   denies when it can positively confirm a feature/bug Epic.
 * - Only denies when the resolved Epic's `tag` is exactly `feature` or `bug`.
 *   Any other tag (`discussion`, `build`, etc.) is ALLOWED.
 * - Only denies when the target path resolves under the project's `src/`,
 *   `scripts/`, `plugins/`, or `bin/` directories. Paths outside the project
 *   cwd, and anything under `session-manager-operations/`, are ALLOWED.
 * - Fails OPEN: any internal error (malformed stdin JSON, unreadable index,
 *   unexpected shape) is logged to stderr and allowed through.
 */
'use strict';

const { decide, parsePayload } = require('./lib/guard-inline-implementation-policy.cjs');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
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
  console.error(`[guard-inline-implementation] unhandled error, failing open: ${e?.message}`);
  emit({ continue: true });
});
