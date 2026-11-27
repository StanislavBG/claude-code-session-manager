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
 *   - lib/epic/epicMint.cjs      (raw fs tmp+rename)
 *   - lib/scheduler/queueStore.cjs    (raw fs tmp+rename)
 *   - lib/telemetry/opsErrorLog.cjs   (raw fs append, JSONL error log)
 *   - lib/tasks/taskLedger.cjs        (raw fs append + atomicFs bodies)
 *   - lib/claude/agentSnapshot.cjs    (atomicFs, write-once snapshots)
 *   - lib/telemetry/webhookRegistry.cjs (atomicFs, 0600 subscriptions file)
 *   - lib/epic/epicPurge.cjs          (human-only Epic purge: deletes each
 *     namespace's files AS that namespace's owner — the one exception to
 *     keep-forever retention; it never borrows another owner's id)
 * Renderer callers declare their writer id through the IPC payload.
 */

const fs = require('node:fs');
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
  // Project Home owns the project-pages library: knowledge/<id>/ pages,
  // videos/<id>/ videos and videos/_character/. Written only via the
  // /admin/project-home/pages/write, /videos/write and /character/write
  // routes (project_page_write, project_video_write, project_character_write),
  // plus the two alias routes /admin/project-home/write (project_home_write ->
  // knowledge/overview/) and /admin/project-home/demo-video/write
  // (project_demo_video_write -> a project-demo entry under videos/<id>/),
  // all via config.cjs's writeTextAtomic.
  // See session-manager-operations/project-pages/README.md.
  'project-pages': 'project-home',
  // Structured per-tab error log lines (JSONL), tagged for tracing/analysis.
  'logs': 'logs',
  // Memory Clusters owns its own regenerable per-project cache (PRD 1389) —
  // memoryAggregate.cjs's clustering result, rebuilt on any explicit
  // refresh:true. See memory-clusters/README.md.
  'memory-clusters': 'memory-clusters',
  // Per-project UI state (PRD 1398) — small renderer prefs that used to live
  // in cwd-scoped or (worse) global localStorage keys. Written directly by
  // the renderer through the generic config:write-json IPC with writer:
  // 'ui-prefs'; no dedicated main-process module. See ui-prefs/README.md.
  'ui-prefs': 'ui-prefs',
  // The Task ledger: one summary JSONL line per Task event (a Task = one
  // headless claude -p run for this project) in tasks/<YYYY-MM-DD>.jsonl, plus
  // tasks/bodies/<taskId>.json prompt/output bodies. lib/tasks/taskLedger.cjs is
  // the ONLY writer; routes, IPC and history read through it. See tasks/README.md.
  'tasks': 'tasks',
  // Per-run plan records (validator + ship/deploy records), laid out as
  // plan-records/<epic-id>/<slug>.md. Machine-local runtime state: the
  // scheduler copies them out of job worktrees and prunes them after the Epic
  // completes. See plan-records/README.md.
  'plan-records': 'scheduler',
  // The per-Epic durable event log: events/<epicId>/events.jsonl, closed
  // {domain}.{action} kinds, summaries only. lib/epic/epicEventLog.cjs is the
  // ONLY writer. Keep forever. See session-manager-operations/AGENTS.md.
  'events': 'event-log',
  // Immutable, content-addressed AgentSnapshots: agents/snapshots/<sha256>.json,
  // written once each. lib/claude/agentSnapshot.cjs is the ONLY writer. Keep
  // forever. See session-manager-operations/AGENTS.md.
  'agents': 'agents',
  // Local webhook subscriptions (loopback URL, kinds filter, HMAC secret):
  // webhooks/subscriptions.json, mode 0600. lib/telemetry/webhookRegistry.cjs
  // is the ONLY writer. Runtime (holds secrets — never committed).
  'webhooks': 'webhooks',
  // Per-project website feedback inbox: reports from the embedded feedback
  // widget, which carry screenshots and reporter emails. Written only as the
  // 'feedback-inbox' writer. Runtime (personal data — never committed);
  // resolved/wontfix items pruned after feedbackInboxDays (opsRetentionSettings).
  'feedback-inbox': 'feedback-inbox',
  // Per-project Artifacts store: files agents made for human review, copied
  // out of job/Epic worktrees as artifacts/<epic-id>/<name> (or
  // artifacts/_tasks/<task-id>/<name>) plus each owner's index.json ledger.
  // lib/epic/artifactStore.cjs is the ONLY writer. Runtime (self-ignored);
  // pruned artifactsDays after the Epic completes.
  'artifacts': 'artifacts',
});

/**
 * namespace -> its git class, one entry per namespace Session Manager defines.
 *  - 'runtime': machine-local state, never committed. Each dir self-ignores
 *    with its own `*` .gitignore (ensureRuntimeIgnores).
 *  - 'tracked': the project's own authored output (Project Home pages and
 *    videos, the Brief, docs), committed like docs. Session Manager never
 *    writes an ignore file there; a project that wants it out of git adds its
 *    own rule.
 * A folder not listed here (feedback/, retired 2026-08-02, or any folder a
 * project made itself) belongs to the project: a project's feedback/ is its
 * own folder, and Session Manager never writes, ignores, bans from commits or
 * untracks it.
 */
const GIT_CLASS = Object.freeze({
  scheduler: 'runtime',
  'prompt-sessions': 'runtime',
  logs: 'runtime',
  'ui-prefs': 'runtime',
  'memory-clusters': 'runtime',
  tasks: 'runtime',
  'plan-records': 'runtime',
  events: 'runtime',
  agents: 'runtime',
  webhooks: 'runtime',
  'feedback-inbox': 'runtime',
  artifacts: 'runtime',
  'project-brief': 'tracked',
  'project-pages': 'tracked',
  architecture: 'tracked',
  'design-mocks': 'tracked',
  HUMAN_LEARN: 'tracked',
  manual: 'tracked',
  reviews: 'tracked',
  // Human-written steering for the weekly MD consolidation; code only reads it.
  'md-network': 'tracked',
});

/**
 * Machine-local RUNTIME namespaces, derived from GIT_CLASS. Every consumer
 * (self-ignore sweep, worktree carry, finish-protocol commit ban, health,
 * runtime-state untrack) reads this list. This repo's root .gitignore lists
 * each one too (plus its own retired feedback/ folder, which is not runtime).
 */
const RUNTIME_NAMESPACES = Object.freeze(
  Object.keys(GIT_CLASS).filter((ns) => GIT_CLASS[ns] === 'runtime'),
);

/** Writer id for the per-namespace self-ignore file. */
const RUNTIME_IGNORE_WRITER = 'runtime-ignore';

/**
 * Narrow, explicit exceptions to single-writer. Each entry names a second
 * writer, the exact file it may touch, and why the owner can't do it itself.
 * Anything not listed here is refused — a delegation must be argued for in
 * code review, not discovered later in a race.
 */
const DELEGATIONS_BASE = {
  // Each runtime namespace (GIT_CLASS 'runtime', all owned) carries its own
  // `.gitignore` (content `*`) so the project's root .gitignore needs no edit.
  // Only that one file, only ensureRuntimeIgnores writes it. Tracked and
  // project-owned folders get no delegation.
  ...Object.fromEntries(RUNTIME_NAMESPACES.map((ns) => [ns, []])),
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
};
for (const ns of RUNTIME_NAMESPACES) {
  DELEGATIONS_BASE[ns] = Object.freeze([
    ...DELEGATIONS_BASE[ns],
    Object.freeze({
      writer: RUNTIME_IGNORE_WRITER,
      file: '.gitignore',
      reason:
        'Self-ignore so machine-local runtime state is never captured by a '
        + 'sweeping `git add` in a managed project (ensureRuntimeIgnores).',
    }),
  ]);
}
const DELEGATIONS = Object.freeze(DELEGATIONS_BASE);

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
    // Fail closed: an owner-less folder (a project's own feedback/, say) is
    // the project's, never Session Manager's — no writer, no delegation.
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
    // classifyCwd fails closed on a non-absolute absPath (returns
    // innermostOpsRoot: null) — path.dirname(null) throws a raw, untagged
    // TypeError, which would crash this "last line of defense" instead of
    // producing the graceful, catchable refusal every other branch here
    // gives. A caller that skips the absolute-path helpers (opsPath/
    // resolveProjectRoot) and hands assertOpsWrite a relative fragment
    // containing an OPS_ROOT_DIR segment must still fail closed, not crash.
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
      const err = new Error(
        `refusing to write ${OPS_ROOT_DIR}/ state: absPath must be absolute, got "${absPath}"`,
      );
      err.unknownCwd = true;
      throw err;
    }
    // innermostOpsRoot (lastIndexOf) is the fact THIS gate keys on; activeSessions
    // truncates at the outermost instead — cwdClassify returns both, unified in
    // neither direction.
    const { classifyCwd } = require('./cwdClassify.cjs');
    const projectRoot = path.dirname(classifyCwd(absPath).innermostOpsRoot);
    const { kind, reason } = classifyCwd(projectRoot);
    if (kind === 'ephemeral' || kind === 'worktree') {
      const err = new Error(
        `refusing to write ${OPS_ROOT_DIR}/ state under an ephemeral project root `
        + `(tmpdir or linked git worktree): "${projectRoot}" — see lib/opsOwnership.cjs resolveProjectRoot`,
      );
      err.ephemeral = true;
      throw err;
    }
    if (kind === 'unknown') {
      // Fail closed on the unprovable case (worktree .git file whose admin
      // back-reference is gone, garbled .git file): the exact shape behind the
      // lost-Epics incidents. WRITES only — reads and dispatch stay open.
      const err = new Error(
        `refusing to write ${OPS_ROOT_DIR}/ state under "${projectRoot}": project identity `
        + `cannot be proven (${reason}) — see lib/cwdClassify.cjs`,
      );
      err.unknownCwd = true;
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
  // Lazy: cwdClassify → schedulerPaths; ephemeralCwd → cwdClassify.
  const { classifyCwd } = require('./cwdClassify.cjs');
  const { isEphemeralCwd } = require('./ephemeralCwd.cjs');
  // `unknown` deliberately does NOT throw here: reads and dispatch must keep
  // working; assertOpsWrite is the choke point that refuses the WRITE.
  const root = classifyCwd(cwd).projectRoot;
  // refuseMissingInTmp:false — a MISSING path is not a write target this
  // resolver can refuse; readers need its path, and existence-aware callers
  // report it themselves (see ephemeralCwd.cjs). Existing tmpdir roots and
  // linked worktrees are still refused below.
  if (isEphemeralCwd(root, { refuseMissingInTmp: false })) {
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

/**
 * ensureRuntimeIgnore(projectRoot, ns) → the `.gitignore` path written, or null.
 * When `<projectRoot>/session-manager-operations/<ns>/` is a directory with no
 * `.gitignore` file, write one containing `*` (which also ignores itself).
 * Null when the file already exists or the namespace dir is absent. Throws on
 * a non-runtime `ns`, an ownership refusal, or an IO error (including a
 * non-file sitting at the `.gitignore` path). Never creates the namespace dir.
 * `projectRoot` must already be resolved (resolveProjectRoot/projectRootOf).
 */
function ensureRuntimeIgnore(projectRoot, ns) {
  if (!RUNTIME_NAMESPACES.includes(ns)) {
    throw new Error(`'${ns}' is not a runtime namespace (RUNTIME_NAMESPACES in lib/opsOwnership.cjs)`);
  }
  const dir = path.join(projectRoot, OPS_ROOT_DIR, ns);
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { /* absent */ }
  if (!isDir) return null;
  const file = path.join(dir, '.gitignore');
  let st = null;
  try { st = fs.statSync(file); } catch { /* absent */ }
  if (st && st.isFile()) return null;
  const verdict = checkOpsWrite(file, RUNTIME_IGNORE_WRITER);
  if (!verdict.ok) throw new Error(verdict.error);
  const { writeTextAtomicSync } = require('./util/atomicFs.cjs');
  writeTextAtomicSync(file, '*\n');
  return file;
}

/**
 * ensureRuntimeIgnoreForPath(absPath) → the `.gitignore` path written, or null.
 * For a path inside a RUNTIME namespace of an ops root (innermost
 * session-manager-operations segment, same rule as parseOpsPath), create the
 * namespace dir if missing and self-ignore it. Null for a path outside any ops
 * root, in an authored namespace, or that IS the namespace `.gitignore`.
 * Throws on refusal or IO error.
 */
function ensureRuntimeIgnoreForPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  const resolved = path.resolve(absPath);
  const segs = resolved.split(path.sep);
  const idx = segs.lastIndexOf(OPS_ROOT_DIR);
  if (idx === -1) return null;
  const ns = segs[idx + 1];
  if (!ns || !RUNTIME_NAMESPACES.includes(ns)) return null;
  const rest = segs.slice(idx + 2).filter(Boolean);
  if (rest.length === 1 && rest[0] === '.gitignore') return null;
  const projectRoot = segs.slice(0, idx).join(path.sep) || path.sep;
  fs.mkdirSync(path.join(projectRoot, OPS_ROOT_DIR, ns), { recursive: true });
  return ensureRuntimeIgnore(projectRoot, ns);
}

/**
 * ensureRuntimeIgnores(projectRoot) → string[] of `.gitignore` paths written.
 * ensureRuntimeIgnore for every runtime namespace, each isolated: one
 * namespace's failure never stops the others. After the loop, throws one
 * Error naming every failed namespace and its reason. Idempotent.
 */
function ensureRuntimeIgnores(projectRoot) {
  const written = [];
  const failures = [];
  for (const ns of RUNTIME_NAMESPACES) {
    try {
      const file = ensureRuntimeIgnore(projectRoot, ns);
      if (file) written.push(file);
    } catch (e) {
      failures.push(`${ns}: ${(e && e.message) || String(e)}`);
    }
  }
  if (failures.length) throw new Error(`runtime self-ignore failed: ${failures.join('; ')}`);
  return written;
}

module.exports = {
  GIT_CLASS,
  RUNTIME_NAMESPACES,
  RUNTIME_IGNORE_WRITER,
  ensureRuntimeIgnore,
  ensureRuntimeIgnoreForPath,
  ensureRuntimeIgnores,
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
