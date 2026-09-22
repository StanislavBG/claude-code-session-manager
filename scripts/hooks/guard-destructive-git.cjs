#!/usr/bin/env node
/**
 * guard-destructive-git.cjs — PreToolUse hook that denies a `Bash` tool call
 * whose command would run a destructive git operation (stash/reset --hard/
 * checkout --/restore/clean -f|-d|-x/add -A|./--all/commit -a) against a
 * SHARED working tree.
 *
 * Why this exists: standards.md tells an executor never to stash/reset/clean
 * a tree it shares with other in-flight jobs or a human's own WIP, but prose
 * is something a model under pressure can fail to weigh. Two real incidents
 * on 2026-09-01 happened with that rule already written down: live trading
 * config stashed and never restored (social-signals-trader), and ~1,400 lines
 * across four PRDs stashed plus three files deleted from disk (starry-night-
 * ships). A PreToolUse hook is the one lever that sits OUTSIDE the model and
 * can refuse the call before it ever reaches git — see guard-prd-writes.cjs's
 * header for the fuller argument for why a hook, not a rule, is the fix.
 *
 * ── Scope: shared trees only ─────────────────────────────────────────────
 * A scheduler job or Epic running inside its OWN linked worktree
 * (`sm-job/<slug>` / `sm-epic/<epicId>`, minted by src/main/lib/gitWorktree.cjs)
 * owns that checkout exclusively — destroying it harms nobody, so every one
 * of the operations above is permitted there. This hook only denies when the
 * command's cwd is the shared base tree (or any other tree not recognized as
 * one of ours). Detection intentionally duplicates just gitWorktree.cjs's two
 * branch-prefix constants and its worktree-root path shape (see
 * WORKTREE_ROOTS/BRANCH_PREFIXES below) rather than requiring that module —
 * this script runs standalone, outside the app's process, and must not pull
 * the whole main-process require graph into a hook invoked on every Bash call.
 * src/main/lib/gitWorktree.cjs stays the source of truth for those constants;
 * if it ever renames the prefixes or root folder names, update them here too.
 *
 * ── Fail-closed on ambiguous parsing ─────────────────────────────────────
 * Command strings can hide a destructive git call inside `sh -c '...'`,
 * chained with `&&`/`;`/`|`/newlines, or preceded by env assignments / `git -C
 * <dir>`. This hook parses those shapes explicitly. When a segment cannot be
 * confidently tokenized (e.g. an unterminated quote) AND it textually mentions
 * `git`, the DEFAULT is to DENY, not allow — the inverse of guard-prd-writes.cjs's
 * fail-OPEN contract. That asymmetry is deliberate: guard-prd-writes guards a
 * narrow, low-consequence path (a hand-written PRD file) where a false deny
 * merely inconveniences an executor that has a real MCP tool alternative
 * anyway; this hook guards irreversible loss of a human's or a sibling job's
 * uncommitted work, where a false ALLOW is the one outcome with no undo. Any
 * OTHER internal error (malformed stdin JSON, an unexpected payload shape)
 * still fails open — a broken guard must never brick the whole Bash tool.
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
 *           "matcher": "Bash",
 *           "hooks": [
 *             { "type": "command", "command": "node scripts/hooks/guard-destructive-git.cjs" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * ── Adopting this hook in a DIFFERENT (non-session-manager) project ──────
 * DON'T HAND-WRITE THIS. Session Manager installs it: open New Session in
 * that project and press "Fix it" on the readiness banner's destructive-git-
 * guard row (src/main/lib/delegationReadiness.cjs's installDestructiveGitGuard,
 * which merges into any existing hooks block instead of clobbering it).
 *
 * Adopted by REFERENCE through the stable shim
 * `~/.claude/session-manager/hooks/guard-destructive-git.cjs`, written by
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
 * - Only inspects `Bash` calls; every other tool_name is allowed by
 *   construction (the matcher already scopes this hook to Bash, but the
 *   tool_name check below is a second, defense-in-depth gate in case the
 *   matcher is ever widened).
 * - Read-only git (`status`, `diff`, `log`, `show`, `stash list`, `stash
 *   show`, `rev-parse`, plain `git add <path>`, `git commit -m ...`) is
 *   never touched by the rules below and always passes through.
 */
'use strict';

const { decide, parsePayload } = require('./lib/guard-destructive-git-policy.cjs');

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
  console.error(`[guard-destructive-git] unhandled error, failing open: ${e?.message}`);
  emit({ continue: true });
});
