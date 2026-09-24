/**
 * guard-inline-implementation-policy.cjs — decision logic for
 * scripts/hooks/guard-inline-implementation.cjs, split out so it can be
 * `require()`d in-process (by tests, notably) with no CLI-level side effects.
 *
 * guard-inline-implementation.cjs itself runs its CLI as a require-time side
 * effect (stdin -> decision -> process.exit, not gated on
 * `require.main === module` — see its header for why). Requiring THIS module
 * never reads stdin or calls `process.exit`, so it's safe to load from a test
 * process — but `decide()` is not I/O-free: it reads
 * `<cwd>/session-manager-operations/prompt-sessions/active-index.json` off
 * disk and, when the Epic runs in a linked worktree, shells out to a real
 * `git rev-parse` to resolve the ops root (see `resolveOpsRootCwd` below).
 * Calling it directly from a test still removes the outer CLI-process spawn
 * per case, exercising real filesystem/git behavior instead of mocking it.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// Pure fs helper only — deliberately NOT gitWorktree (keeps this guard light).
const { nearestGitEntry } = require('../../../src/main/lib/cwdClassify.cjs');

const SOURCE_DIRS = ['src', 'scripts', 'plugins', 'bin'];
const DENY_TAGS = new Set(['feature', 'bug']);

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

/**
 * The PreToolUse payload's `cwd` is the CLI process's actual spawn cwd. For
 * an Epic running in its default isolated `git worktree` (gitWorktree.cjs,
 * epicSpawnCwd.cjs — "both the Terminal PTY and headless Chat spawn cwd
 * resolve to it"), that is a throwaway checkout under os.tmpdir(), which
 * never contains `session-manager-operations/` — the ops root always lives
 * in the real project tree (see gitWorktree.cjs's "ops-root hazard" header:
 * "spawn cwd = worktree dir, ops-root cwd = real project cwd, always").
 * Resolve back to the real project cwd via git's shared `.git` dir before
 * giving up, so this guard isn't silently inert for every Epic running in
 * its default worktree.
 */
function resolveOpsRootCwd(rawCwd) {
  if (fs.existsSync(path.join(rawCwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'))) {
    return rawCwd;
  }
  try {
    // Only a `.git` FILE (linked worktree) needs git to find the shared dir; a
    // `.git` directory IS the project root, so skip the spawn.
    const entry = nearestGitEntry(rawCwd);
    if (!entry) return rawCwd;
    if (!entry.isFile) return entry.dir;
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: rawCwd, encoding: 'utf8', timeout: 5000 },
    ).trim();
    if (!commonDir) return rawCwd;
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  } catch {
    return rawCwd;
  }
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
 * tests) — but does real filesystem reads and, in the linked-worktree case, a
 * real `git rev-parse` spawn (see `resolveOpsRootCwd`).
 */
function decide(payload) {
  try {
    if (process.env.SM_ALLOW_INLINE_IMPLEMENTATION === '1') return buildAllow();

    const toolName = payload.tool_name;
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
      return buildAllow();
    }

    const rawPath = targetPathFor(toolName, payload.tool_input);
    if (!rawPath || typeof rawPath !== 'string') return buildAllow();

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

    if (!isApplicationSource(cwd, absPath)) return buildAllow();

    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    const opsRootCwd = resolveOpsRootCwd(cwd);
    const epic = resolveEpicTag(opsRootCwd, sessionId);
    if (!epic) return buildAllow(); // unresolvable session — allow by construction

    if (epic.allowInlineImplementation) return buildAllow();
    if (!DENY_TAGS.has(epic.tag)) return buildAllow();

    const reason = [
      `Direct ${toolName} to application source ("${path.relative(cwd, absPath)}") is discouraged inside a "${epic.tag}" Epic.`,
      'Feature and bug work should be decomposed and queued via /develop rather than implemented inline, so it runs through the scheduler with acceptance criteria and review.',
      'If this inline edit is deliberate, set SM_ALLOW_INLINE_IMPLEMENTATION=1 in the environment, or set allowInlineImplementation: true on this Epic\'s record in active-index.json, and retry.',
    ].join(' ');
    return buildDeny(reason);
  } catch (e) {
    console.error(`[guard-inline-implementation] internal error, failing open: ${e?.message}`);
    return buildAllow();
  }
}

/** Mirrors the CLI's stdin-JSON handling so it can be exercised without a spawn. */
function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`[guard-inline-implementation] malformed stdin JSON, failing open: ${e?.message}`);
    return {};
  }
}

module.exports = { decide, parsePayload };
