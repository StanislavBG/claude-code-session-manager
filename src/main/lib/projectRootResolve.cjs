'use strict';

/**
 * projectRootResolve.cjs — server-side project/Epic resolution for every
 * cwd-accepting ops-root entry point (PRD: worktree-cwd Epic-lookup hazard).
 *
 * Problem this closes. An agent running inside an Epic's git worktree has
 * `pwd` = `/tmp/session-manager-epic-worktrees/<hash>/<epicId>` and naturally
 * passes that as `cwd` to `scheduler_create_prd` / `feedback_open_session`.
 * `active-index.json` (the Epic registry) is git-tracked, so the worktree's
 * copy is a snapshot frozen at branch time — it usually does NOT contain the
 * very Epic the agent is running inside. Verified live 2026-09-01 on
 * starry-night-ships: main's index had 5 rows including the running Epic; the
 * worktree's copy had 1 row and did not contain it, so a naive per-cwd lookup
 * returns null and the write is refused with "create/approve an Epic first" —
 * reading to the human as "the Epic got lost", when it never did.
 *
 * `resolveProjectContext` fixes this at the API boundary, not by trying to
 * keep every cwd-accepting caller worktree-aware individually:
 *   1. Normalizes any supplied cwd through `activeSessions.projectRootOf`
 *      (worktree -> main tree, ops-internal path -> project root).
 *   2. When an `originClaudeSessionId` (or explicit `epicId`) is known,
 *      searches for the owning Epic first in the normalized cwd's own
 *      active-index, then across every project this machine has ever opened
 *      (`activeSessions.allProjectCwds`) — because the Epic's OWN project may
 *      not even be the cwd the agent guessed (e.g. a worktree whose gitdir
 *      pointer is stale/unresolvable, or a cross-project mixup).
 *   3. A resolved Epic's own project cwd (`epicCwd`) always wins over the
 *      supplied/hinted cwd when they differ — the Epic is the ground truth.
 *
 * Pure, synchronous, fs-only — no Electron deps — so it can be required from
 * the standalone scheduler-mcp-server.cjs process and from every ops-root
 * path helper a sibling PRD (ops-root-single-resolver) folds in later.
 */

const path = require('node:path');
const { projectRootOf, allProjectCwds } = require('../../../scripts/lib/activeSessions.cjs');
const { readActiveIndex } = require('./epicMint.cjs');
const { isEphemeralCwd } = require('./ephemeralCwd.cjs');

/**
 * resolveProjectContext({ cwd, originClaudeSessionId, epicId, originProjectRoot }, deps?)
 *   → { cwd, epicId, epicCwd, source }
 *
 * `cwd` — the caller-supplied cwd (may be inside a worktree/ops-internal path,
 *   or absent entirely when the caller is relying purely on Epic resolution).
 * `originClaudeSessionId` — the calling session's own claude session id
 *   (chatRunner.cjs's SM_CHAT_SESSION_ID / pty.cjs's tabId) — matched against
 *   each Epic's `claudeSessionId`.
 * `epicId` — an explicit already-known Epic id (e.g. a caller-supplied
 *   `sourcePromptId`) — matched against each Epic's `id`. Either identifier
 *   (or both) may be supplied; a match on either counts.
 * `originProjectRoot` — a trusted hint (e.g. SM_PROJECT_ROOT env, stamped by
 *   the process that actually knows the real project root) — normalized the
 *   same way as `cwd` and preferred over it when both are given, but still
 *   loses to a resolved Epic's own `epicCwd`.
 *
 * `source` records which path produced the returned `cwd`/`epicId`:
 *   'cwd'                — no Epic identifier given, or none resolved; cwd is
 *                          just the normalized supplied/hinted value.
 *   'epic-index'          — the Epic was found in the (single) normalized
 *                          base cwd's own active-index.
 *   'cross-project-scan'  — the Epic was found only by scanning other known
 *                          projects (or a duplicate id required tie-breaking).
 *
 * Never throws: an unresolvable cwd/hint/Epic id just yields a smaller
 * result, never an error — refusal is the caller's decision, not this
 * resolver's.
 */
function resolveProjectContext({ cwd, originClaudeSessionId, epicId: wantedEpicId, originProjectRoot } = {}, deps = {}) {
  const projectRootOfFn = deps.projectRootOf || projectRootOf;
  const allProjectCwdsFn = deps.allProjectCwds || allProjectCwds;
  const readActiveIndexFn = deps.readActiveIndex || readActiveIndex;
  const isEphemeralCwdFn = deps.isEphemeralCwd || isEphemeralCwd;
  const warn = deps.warn || console.warn;

  let baseCwd = null;
  if (cwd && typeof cwd === 'string') {
    baseCwd = projectRootOfFn(path.resolve(cwd));
  }
  if (originProjectRoot && typeof originProjectRoot === 'string') {
    const hintRoot = projectRootOfFn(path.resolve(originProjectRoot));
    // A trusted hint outranks the agent-supplied cwd, but a resolved Epic
    // (below) still outranks both.
    if (hintRoot) baseCwd = hintRoot;
  }

  const result = { cwd: baseCwd, epicId: null, epicCwd: null, source: 'cwd' };

  if (!originClaudeSessionId && !wantedEpicId) return result;

  const candidates = [];
  if (baseCwd) candidates.push(baseCwd);
  for (const p of allProjectCwdsFn()) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  const matches = [];
  for (const projectCwd of candidates) {
    const { sessions } = readActiveIndexFn(projectCwd);
    for (const session of Object.values(sessions)) {
      if (!session) continue;
      const idHit = wantedEpicId && session.id === wantedEpicId;
      const claudeHit = originClaudeSessionId && session.claudeSessionId === originClaudeSessionId;
      if (idHit || claudeHit) {
        matches.push({ projectCwd, epicId: session.id, status: session.status ?? null });
        break;
      }
    }
  }

  if (matches.length === 0) return result;

  let chosen = matches[0];
  if (matches.length > 1) {
    const score = (m) => (isEphemeralCwdFn(m.projectCwd) ? 0 : 2) + (m.status === 'active' ? 1 : 0);
    chosen = matches.reduce((best, m) => (score(m) > score(best) ? m : best), matches[0]);
    warn(
      `[projectRootResolve] Epic id ${chosen.epicId} matched in multiple projects: `
      + `${matches.map((m) => m.projectCwd).join(', ')} — choosing ${chosen.projectCwd} `
      + '(prefers a non-worktree/tmp project with status=active)',
    );
  }

  result.epicId = chosen.epicId;
  result.epicCwd = chosen.projectCwd;
  result.cwd = chosen.projectCwd;
  result.source = matches.length > 1
    ? 'cross-project-scan'
    : (chosen.projectCwd === baseCwd ? 'epic-index' : 'cross-project-scan');
  return result;
}

module.exports = { resolveProjectContext };
