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
}

module.exports = {
  OPS_ROOT_DIR,
  OWNERS,
  DELEGATIONS,
  parseOpsPath,
  checkOpsWrite,
  assertOpsWrite,
};
