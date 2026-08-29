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
 * Add to this project's `.claude/settings.json` (not `~/.claude/settings.json`
 * — project scope only). Add the command alongside guard-prd-writes.cjs in
 * the SAME `Write|Edit|NotebookEdit` matcher's `hooks` array:
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

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIRS = ['src', 'scripts', 'plugins', 'bin'];
const DENY_TAGS = new Set(['feature', 'bug']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function targetPathFor(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolName === 'NotebookEdit') return toolInput.notebook_path ?? null;
  return toolInput.file_path ?? null;
}

function isApplicationSource(cwd, absPath) {
  const rel = path.relative(cwd, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false; // outside cwd
  const topLevel = rel.split(path.sep)[0];
  return SOURCE_DIRS.includes(topLevel);
}

function resolveEpicTag(cwd, sessionId) {
  if (!sessionId) return null;
  const indexPath = path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  if (!fs.existsSync(indexPath)) return null;
  const raw = fs.readFileSync(indexPath, 'utf8');
  const index = JSON.parse(raw);
  const sessions = index && typeof index === 'object' ? index.sessions : null;
  if (!sessions || typeof sessions !== 'object') return null;
  for (const record of Object.values(sessions)) {
    if (record && record.claudeSessionId === sessionId) return record;
  }
  return null;
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
    console.error(`[guard-inline-implementation] malformed stdin JSON, failing open: ${e?.message}`);
    return allow();
  }

  try {
    if (process.env.SM_ALLOW_INLINE_IMPLEMENTATION === '1') return allow();

    const toolName = payload.tool_name;
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
      return allow();
    }

    const rawPath = targetPathFor(toolName, payload.tool_input);
    if (!rawPath || typeof rawPath !== 'string') return allow();

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

    if (!isApplicationSource(cwd, absPath)) return allow();

    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    const epic = resolveEpicTag(cwd, sessionId);
    if (!epic) return allow(); // unresolvable session — allow by construction

    if (epic.allowInlineImplementation) return allow();
    if (!DENY_TAGS.has(epic.tag)) return allow();

    const reason = [
      `Direct ${toolName} to application source ("${path.relative(cwd, absPath)}") is discouraged inside a "${epic.tag}" Epic.`,
      'Feature and bug work should be decomposed and queued via /develop rather than implemented inline, so it runs through the scheduler with acceptance criteria and review.',
      'If this inline edit is deliberate, set SM_ALLOW_INLINE_IMPLEMENTATION=1 in the environment, or set allowInlineImplementation: true on this Epic\'s record in active-index.json, and retry.',
    ].join(' ');
    return deny(reason);
  } catch (e) {
    console.error(`[guard-inline-implementation] internal error, failing open: ${e?.message}`);
    return allow();
  }
}

main().catch((e) => {
  console.error(`[guard-inline-implementation] unhandled error, failing open: ${e?.message}`);
  allow();
});
