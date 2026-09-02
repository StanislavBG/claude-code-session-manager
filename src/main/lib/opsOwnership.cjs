'use strict';

/**
 * opsOwnership.cjs — THE SINGLE-WRITER LAW for a project's operations root.
 *
 * Every per-project operational namespace under
 * `<projectCwd>/session-manager-operations/<namespace>/` has exactly ONE
 * owning surface that may write to it. Everyone else reads. Reads are never
 * restricted — consistency here is about who may *mutate* state, not who may
 * see it.
 *
 * Why: these folders ARE the app's source of truth (Epics, PRDs, queue state,
 * the Brief). When two surfaces write the same folder, they race through
 * separate read-modify-write cycles and the later rename silently wins — the
 * same class of bug that already produced live queue.json rows whose
 * sourcePromptId and sourceTabId disagree. One writer per namespace removes
 * the race by construction instead of by convention.
 *
 * The law is FAIL-CLOSED: a write into the ops root by an undeclared writer,
 * or into a namespace with no declared owner, is refused. Adding a new
 * namespace or a new writer is therefore a deliberate edit to this file — the
 * ownership map is reviewable in one place rather than implied by whichever
 * modules happen to call fs.writeFile.
 *
 * Enforcement points (every write path into the ops root calls assertOpsWrite):
 *   - config.cjs writeTextAtomic / writeBinaryAtomic / writeJson / writeJsonSync
 *   - lib/epicMint.cjs      (raw fs tmp+rename)
 *   - lib/queueStore.cjs    (raw fs tmp+rename)
 *   - lib/opsErrorLog.cjs   (raw fs append, JSONL error log)
 * Renderer callers declare their writer id through the IPC payload.
 */

const path = require('node:path');

const OPS_ROOT_DIR = 'session-manager-operations';

/**
 * namespace → the one writer id allowed to mutate it.
 *
 * Writer ids name a SURFACE (the tab/feature that owns the data), not a
 * module — several modules may implement one surface, but they all write as
 * that surface, and a surface owns its folder outright.
 */
const OWNERS = Object.freeze({
  // Epics own the PromptSession store: active-index.json + per-Epic archives.
  'prompt-sessions': 'epics',
  // The Scheduler owns PRD sources, per-Epic PRD dirs, and queue/history shards.
  'scheduler': 'scheduler',
  // Project Home owns the synthesized Brief (generate + hand-edit).
  'project-brief': 'project-home',
  // Structured per-tab error log lines (JSONL), tagged for tracing/analysis.
  'logs': 'logs',
  // Host on Bilko.run tab's deterministic bundle prep (dist/index.html +
  // dist/manifest.json only — publish-state.json and anything the
  // bilko-host-publisher Epic authors beyond dist/ is agent-Write-tool
  // output, same unenforceable-by-construction class as project-pages/output.
  'bilko-host': 'bilko-host',
});

/**
 * Narrow, explicit exceptions to single-writer. Each entry names a second
 * writer, the exact file it may touch, and why the owner can't do it itself.
 * Anything not listed here is refused — a delegation must be argued for in
 * code review, not discovered later in a race.
 */
const DELEGATIONS = Object.freeze({
  'prompt-sessions': Object.freeze([
    Object.freeze({
      writer: 'scheduler',
      // Only this one file, and only its top level.
      file: 'active-index.json',
      reason:
        'The scheduler appends prd_created/response events to the Epic that '
        + 'spawned a job (promptSessionEvents.cjs, PRD 814) and mints/joins an '
        + 'Epic when a PRD is created (epicMint.cjs). Both happen in the main '
        + 'process with no renderer attached, so the Epics surface cannot '
        + 'perform them. Serialized per-path by each module\'s own write lock.',
    }),
  ]),
});

/**
 * Split an absolute path into { inOps, namespace, relative }.
 * `namespace` is the segment directly under session-manager-operations/;
 * `relative` is the remainder (posix-joined), '' when the path IS the
 * namespace dir. Returns inOps:false for any path outside an ops root.
 *
 * Complexity: O(n) in path segments.
 */
function parseOpsPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return { inOps: false, namespace: null, relative: null };
  const segs = absPath.split(path.sep).filter(Boolean);
  const idx = segs.lastIndexOf(OPS_ROOT_DIR);
  if (idx === -1) return { inOps: false, namespace: null, relative: null };
  const rest = segs.slice(idx + 1);
  // A write to the ops root itself carries no namespace — nobody owns it.
  if (rest.length === 0) return { inOps: true, namespace: null, relative: '' };
  return { inOps: true, namespace: rest[0], relative: rest.slice(1).join('/') };
}

/** True when `writer` may write `relative` inside `namespace` by delegation. */
function isDelegated(namespace, relative, writer) {
  const entries = DELEGATIONS[namespace];
  if (!entries) return false;
  return entries.some((d) => d.writer === writer && d.file === relative);
}

/**
 * Decide whether `writer` may write `absPath`. Pure — returns a verdict
 * rather than throwing, so it can be unit-tested and so callers choose their
 * own failure mode.
 *
 * Paths outside any ops root are allowed here unconditionally: they are
 * governed by config.cjs's validateWrite boundary, which is a separate
 * question (may this process write here at all) from ownership (which surface
 * owns this state).
 */
function checkOpsWrite(absPath, writer) {
  const { inOps, namespace, relative } = parseOpsPath(absPath);
  if (!inOps) return { ok: true, error: null };

  if (!namespace) {
    return { ok: false, error: `${OPS_ROOT_DIR}/ itself has no owner — write inside a namespace folder` };
  }

  const owner = OWNERS[namespace];
  if (!owner) {
    return {
      ok: false,
      error:
        `no declared owner for ${OPS_ROOT_DIR}/${namespace}/ — `
        + `add it to OWNERS in lib/opsOwnership.cjs before writing there`,
    };
  }

  if (!writer) {
    return {
      ok: false,
      error:
        `write to ${OPS_ROOT_DIR}/${namespace}/ did not declare a writer `
        + `(owner is '${owner}')`,
    };
  }

  if (writer === owner) return { ok: true, error: null };
  if (isDelegated(namespace, relative, writer)) return { ok: true, error: null };

  return {
    ok: false,
    error:
      `'${writer}' may not write ${OPS_ROOT_DIR}/${namespace}/${relative} — `
      + `that namespace is owned by '${owner}' (single-writer law, `
      + `lib/opsOwnership.cjs). Read it freely; route writes through the owner.`,
  };
}

/** Throwing wrapper used at each enforcement point. */
function assertOpsWrite(absPath, writer) {
  const verdict = checkOpsWrite(absPath, writer);
  if (!verdict.ok) throw new Error(verdict.error);
  // Ownership is one question; WHERE the ops root lives is another. A writer
  // that bypasses the path helpers below and builds its own absolute path can
  // still aim at an ephemeral project root (a worktree, os.tmpdir()) — refuse
  // that here too so the single-writer gate is also the last line against the
  // worktree-cwd hazard (PRD 1082; incidents 2026-08-30, 2026-09-01).
  const { inOps } = parseOpsPath(absPath);
  if (inOps) {
    const segs = absPath.split(path.sep);
    const idx = segs.lastIndexOf(OPS_ROOT_DIR);
    const projectRoot = segs.slice(0, idx).join(path.sep) || path.sep;
    const { isEphemeralCwd } = require('./ephemeralCwd.cjs');
    if (isEphemeralCwd(projectRoot)) {
      const err = new Error(
        `refusing to write ${OPS_ROOT_DIR}/ state under an ephemeral project root `
        + `(tmpdir or linked git worktree): "${projectRoot}" — see lib/opsOwnership.cjs resolveProjectRoot`,
      );
      err.ephemeral = true;
      throw err;
    }
  }
}

// ─── THE ONE ops-root resolver (PRD 1082) ─────────────────────────────────
//
// Every namespace used to compute its own path with a bare
// `path.join(cwd, 'session-manager-operations', ...)`, each one independently
// trusting its `cwd`. The worktree / ops-internal cwd hazard therefore had to
// be fixed one call site at a time (activeSessions 2026-08-30, PRDs 1073,
// 1074, 1081). This is the single choke point every reader and writer of the
// ops root goes through instead — normalize what can be normalized, refuse
// what cannot — so the next stray cwd is caught by construction, not by
// incident. `scripts/ops-sweep.cjs` lints that no other file in src/main/
// spells the ops-root literal.
//
// Normalization is `activeSessions.projectRootOf`: an ops-internal path is
// truncated to the project above it, a linked git worktree is mapped to its
// main tree via the `.git` file's `gitdir:` pointer, and a subdirectory of a
// git repo resolves to that repo's root. A plain directory with no enclosing
// `.git` is returned unchanged (byte-identical to the old join). A nested
// project that IS its own git repo (e.g. Apple/01-Shapes-Foundation) keeps its
// own root — the walk stops at the first `.git` it meets.

/**
 * resolveProjectRoot(cwd, { opsInternal }) → absolute project root.
 *
 * Throws on a missing/non-string/relative cwd (a caller that cannot name an
 * absolute project has no business touching that project's state), and
 * throws a tagged `err.ephemeral = true` when the normalized root is still
 * inside os.tmpdir() or is a linked worktree root (ephemeralCwd.cjs).
 *
 * `opsInternal` — 'normalize' (default): a cwd inside session-manager-
 * operations/ is truncated up to its project, the reader-friendly behaviour
 * activeSessions already has. 'refuse': throw instead — the fail-closed
 * posture a WRITER wants (queueStore.projectStateDir), since silently
 * redirecting a write target is riskier than refusing it.
 */
function resolveProjectRoot(cwd, { opsInternal = 'normalize' } = {}) {
  if (!cwd || typeof cwd !== 'string') throw new Error('resolveProjectRoot: cwd is required');
  if (!path.isAbsolute(cwd)) {
    throw new Error(`resolveProjectRoot: cwd must be an absolute path, got "${cwd}"`);
  }
  if (opsInternal === 'refuse' && cwd.split(path.sep).includes(OPS_ROOT_DIR)) {
    throw new Error(
      `resolveProjectRoot: cwd must be a project root, not a path inside ${OPS_ROOT_DIR}/, got "${cwd}"`,
    );
  }
  // Lazy: activeSessions → gitWorktree → (lazily) config.cjs → this module.
  const { projectRootOf } = require('../../../scripts/lib/activeSessions.cjs');
  const { isEphemeralCwd } = require('./ephemeralCwd.cjs');
  const root = projectRootOf(cwd);
  if (isEphemeralCwd(root)) {
    const err = new Error(
      `resolveProjectRoot: refusing ephemeral cwd (tmpdir or linked git worktree), got "${cwd}"`,
    );
    err.ephemeral = true;
    throw err;
  }
  return root;
}

/** resolveOpsRoot(cwd, opts) → `<projectRoot>/session-manager-operations`. */
function resolveOpsRoot(cwd, opts) {
  return path.join(resolveProjectRoot(cwd, opts), OPS_ROOT_DIR);
}

/**
 * opsPath(cwd, ...segments) → `<projectRoot>/session-manager-operations/<segments>`.
 * The only sanctioned way to build a path inside a project's ops root.
 */
function opsPath(cwd, ...segments) {
  return path.join(resolveOpsRoot(cwd), ...segments);
}

module.exports = {
  OPS_ROOT_DIR,
  OWNERS,
  DELEGATIONS,
  parseOpsPath,
  checkOpsWrite,
  assertOpsWrite,
  resolveProjectRoot,
  resolveOpsRoot,
  opsPath,
};
