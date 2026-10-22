/**
 * scheduler/prdPaths.cjs — per-project PRD dir resolution (PRD 808): candidate/
 * archived dir lookup, slug containment, archive-on-complete, boot migration and
 * queue-backup sweep. Extracted verbatim from scheduler.cjs; internal calls go
 * through module.exports (spy seam).
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
const logs = require('../logs.cjs');
const { SCHEDULE_SLUG_RE } = require('../ipcSchemas.cjs');
const { DEFAULT_PROJECT_CWD } = require('../lib/scheduler/schedulerBatch.cjs');
const { resolvePrdsDirs, resolveArchivedPrdsDirs, resolvePrdWriteDir, listEpicPrdDirs, resolveEpicPrdWriteDir, isSafeEpicId, listArchivedPrdDirs, ancestorEpicPrdDirs, ancestorEpicArchivedPrdDirs } = require('../lib/prd/prdLocations.cjs');
const { migratePrds, consolidateFlatPrds, legacyAdoptExistingPrds } = require('../lib/prd/prdMigration.cjs');
const { opsPath } = require('../lib/opsOwnership.cjs');
const { allProjectCwds, projectRootOf } = require('../lib/activeSessions.cjs');

/**
 * Every PRD-source directory currently in play: the legacy global dir (still
 * searched so a not-yet-migrated file is never invisible) plus every active
 * project's own PRDs dir. Used by scans that enumerate PRDs across projects
 * (reconcile, list-prds, lint, rescan).
 */
function candidatePrdsDirs() {
  return [schedulerPaths.prdsRoot(), ...resolvePrdsDirs()];
}

/**
 * Every `prds-archived/` dir across every project (the sibling-of-source
 * layout archiveCompletedPrd writes into — see that function's comment).
 * Used only by list-prds so the PRDs/Runs tabs can show an Epic's REAL
 * historical PRD count, not just its currently-pending one. Deliberately
 * excludes the flat legacy PRDS_ARCHIVE_DIR (manual `schedule:archive-prd`
 * timestamped-subdir layout) — that path is for a different, unused-by-
 * any-renderer manual archive flow, not Epic-scoped completion archiving.
 */
function candidateArchivedPrdsDirs() {
  return resolveArchivedPrdsDirs();
}

/**
 * Resolve an archived PRD's real terminal outcome for `schedule:list-prds`:
 * its live queue.json row (if the job hasn't aged out yet), else its
 * history.jsonl row, else 'completed' — archiveCompletedPrd only ever
 * archives a job whose effective status is 'completed' (a 'failed' job's
 * PRD source stays in the live prds/ dir), so 'completed' is a safe
 * default, not a guess; the live/history lookups are defensive in case
 * that archiving invariant ever changes. Exported as a pure function (no
 * IPC/fs) so this fallback chain is unit-testable without an Electron
 * harness.
 */
function resolveArchivedPrdStatus(slug, liveStatusBySlug, histBySlug) {
  const resolved = liveStatusBySlug.get(slug) ?? histBySlug.get(slug)?.status ?? 'completed';
  return resolved === 'failed' ? 'failed' : 'completed';
}

/** The PRD-source directory for a given job cwd (falls back to DEFAULT_PROJECT_CWD). */
function prdDirForCwd(cwd) {
  return resolvePrdWriteDir(cwd || DEFAULT_PROJECT_CWD);
}

/**
 * Absolute path to `<job's project PRDs dir>/<job.slug>.md`. Resolves to
 * `resolvePrdWriteDir(cwd)` — the RETIRED flat
 * `<cwd>/session-manager-operations/scheduler/prds/` dir, which holds only
 * zero-byte `.reserved-NNN` stubs and no PRD source for any Epic-scoped PRD
 * (see resolveNotifyPrd's and resolveVerifyPrdPath's doc comments, PRD 985
 * and 991). Do NOT reach for this in new code — use `findPrdDir(slug)` (via
 * `resolveVerifyPrdPath`/`resolveNotifyPrd`, or directly for a fresh path)
 * instead. The one legitimate remaining caller is executeJob's `prdPath`
 * (~line 2235), which only falls back to this AFTER `findPrdDir` already
 * came up empty — a real miss, not a resolution shortcut — matching this
 * function's genuinely-legacy semantics rather than a bug. (PRD 991 also
 * removed the two verify call sites and buildInvestigationPrompt's
 * originalBody read from this list — all three now go through
 * resolveVerifyPrdPath instead.)
 */
function prdPathForJob(job) {
  return path.join(module.exports.prdDirForCwd(job && job.cwd), `${job && job.slug}.md`);
}

/**
 * Absolute path to a job's archived-twin `<slug>.md`. Resolves to the first
 * archive dir (across the flat legacy layout and every Epic's own sibling
 * archive — see listArchivedPrdDirs) that actually contains the slug, falling
 * back to the flat `prds-archived/<slug>.md` path when none do (this fallback
 * is only ever used for its string value — logging/note text in
 * prdArchivedSkipResult — never as an existence check).
 */
function archivedPrdPathForJob(job) {
  const slug = job && job.slug;
  const flatPath = path.join(module.exports.prdDirForCwd(job && job.cwd), '..', 'prds-archived', `${slug}.md`);
  for (const dir of listArchivedPrdDirs((job && job.cwd) || DEFAULT_PROJECT_CWD)) {
    const candidate = module.exports.safeSlugPathIn(dir, slug);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return flatPath;
}

/**
 * True if a job's PRD has already been archived — in the flat legacy
 * `prds-archived/` dir OR in the Epic-scoped sibling archive dir every new
 * PRD actually lands in (archiveCompletedPrd archives into the source PRD's
 * OWN parent's prds-archived/, which for an Epic PRD is inside that Epic).
 * A queue entry whose PRD moved to either is stale — the work already
 * shipped — not a genuine missing-PRD failure.
 */
async function archivedTwinExists(job) {
  const slug = job && job.slug;
  const dirs = [...listArchivedPrdDirs((job && job.cwd) || DEFAULT_PROJECT_CWD)];
  // Epic-in-non-git-parent case (see prdLocations.ancestorEpicDirs' header
  // comment): job.cwd's own project never sees the ancestor Epic's archive
  // dir via listArchivedPrdDirs, so also walk up from job.cwd for this
  // job's EXACT epicId.
  if (job && job.cwd && job.epicId) {
    dirs.push(...ancestorEpicArchivedPrdDirs(job.cwd, job.epicId));
  }
  for (const dir of dirs) {
    const candidate = module.exports.safeSlugPathIn(dir, slug);
    if (!candidate) continue;
    try {
      await fsp.access(candidate);
      return true;
    } catch { /* not here — try the next archive dir */ }
  }
  return false;
}

/**
 * Search every candidate PRD dir for `<slug>.md` (legacy dir first, then
 * each active project's dir). Returns the containing dir, or null if the
 * slug isn't found anywhere. Used by slug-only callers (IPC handlers) that
 * don't have a job's cwd on hand.
 */
async function findPrdDir(slug) {
  for (const dir of module.exports.candidatePrdsDirs()) {
    try {
      await fsp.access(path.join(dir, `${slug}.md`));
      return dir;
    } catch { /* not here — try the next candidate dir */ }
  }
  return null;
}

/**
 * Deterministic, scan-free candidate PRD dirs for a job, derived only from
 * `job.cwd` (projectRootOf-normalized): the exact `job.epicId` Epic dir (when
 * the id is safe and the dir exists), then every Epic prds dir of the project,
 * then the project's own prds dir. Ordered, deduplicated; [] when job.cwd is
 * missing or not absolute. All paths are built with path.join.
 */
async function jobScopedPrdDirs(job) {
  const cwd = job && job.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [];
  const root = projectRootOf(cwd);
  const out = [];
  const add = (dir) => { if (dir && !out.includes(dir)) out.push(dir); };
  if (isSafeEpicId(job.epicId)) {
    try {
      const exact = resolveEpicPrdWriteDir(root, job.epicId);
      if (fs.existsSync(exact)) add(exact);
    } catch { /* unsafe epicId — skip the exact dir */ }
  }
  for (const dir of listEpicPrdDirs(root)) add(dir);
  add(module.exports.prdDirForCwd(root));
  return out;
}

async function dirHasSlug(dir, slug) {
  try {
    await fsp.access(path.join(dir, `${slug}.md`));
    return true;
  } catch { return false; }
}

/**
 * Job-aware widening of findPrdDir: tries the job's exact Epic dir from
 * jobScopedPrdDirs first, then the ordinary global candidate search, then the
 * remaining job-scoped dirs, then a stored absolute PRD path on the row (if
 * the queue schema ever carries one — checked defensively), then walks up
 * to 3 ancestor directories above `job.cwd` for that EXACT `job.epicId`'s
 * `prds` dir (prdLocations.ancestorEpicPrdDirs).
 *
 * The job-scoped lookup is what keeps a live PRD resolvable when its project
 * has fallen out of allProjectCwds (a transcript-tail heuristic), which would
 * otherwise hide it from findPrdDir (incident: Rabbits-Game
 * 41-bunny-run-cycle-art, 2026-10-20, retired as `prd-missing`).
 *
 * The ancestor walk fixes the incident where an Epic lives in a non-git
 * PARENT folder P (P/session-manager-operations/scheduler/epics/<epicId>/
 * prds/*.md) but its PRDs' frontmatter `cwd` is the sub-repo P/repo — P is
 * never itself a tracked project cwd, so candidatePrdsDirs() never visits it.
 * epicId is matched exactly (never a glob); every path is built with
 * path.join, never string concatenation with user input.
 */
async function findPrdDirForJob(job) {
  const slug = job && job.slug;
  const scoped = typeof slug === 'string' && slug && path.basename(slug) === slug
    ? await module.exports.jobScopedPrdDirs(job) : [];
  const exactDir = scoped.length && isSafeEpicId(job.epicId)
    ? opsPath(job.cwd, 'scheduler', 'epics', job.epicId, 'prds')
    : null;
  if (exactDir && scoped[0] === exactDir && await dirHasSlug(exactDir, slug)) return exactDir;
  const viaGlobalSearch = await module.exports.findPrdDir(slug);
  if (viaGlobalSearch) return viaGlobalSearch;
  for (const dir of scoped) {
    if (await dirHasSlug(dir, slug)) return dir;
  }
  if (job && typeof job.prdPath === 'string' && job.prdPath) {
    try {
      await fsp.access(job.prdPath);
      return path.dirname(job.prdPath);
    } catch { /* stored path stale — fall through to the ancestor walk */ }
  }
  if (job && job.cwd && job.epicId) {
    for (const dir of ancestorEpicPrdDirs(job.cwd, job.epicId)) {
      if (await dirHasSlug(dir, slug)) return dir;
    }
  }
  return null;
}

/**
 * Resolve `<dir>/<slug>.md` for a directory already known to contain (or be
 * about to receive) the slug, and enforce path containment. Returns the
 * absolute path on success, null on slug-escape attempts. The zod schema
 * for slugs already blocks `..` because the SLUG_RE excludes `/`, but
 * defense-in-depth: a second containment check after path.resolve costs
 * nothing and catches future regex laxity.
 */
function safeSlugPathIn(dir, slug) {
  const resolved = path.resolve(path.join(dir, `${slug}.md`));
  if (!resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

/**
 * Realpath of a PRDs dir for the symlink-containment re-checks below, or null
 * when `dir` or any component between it and its project cwd (the parent of
 * `session-manager-operations`) is a symlink. Why: comparing a file's realpath
 * against the RAW dir rejected every PRD under a symlinked path (macOS tmpdir
 * /var → /private/var), but trusting realpath(dir) alone lets a rogue job swap
 * `epics/<id>/prds` for a symlink to e.g. ~/.claude and write there. Symlinks
 * ABOVE the project cwd (a symlinked home or project folder) stay allowed.
 */
async function realPrdsDir(dir) {
  const marker = `${path.sep}session-manager-operations${path.sep}`;
  const idx = (dir + path.sep).lastIndexOf(marker);
  const stop = idx === -1 ? path.dirname(dir) : dir.slice(0, idx);
  for (let p = dir; p.length > stop.length; p = path.dirname(p)) {
    const st = await fsp.lstat(p).catch(() => null);
    if (st && st.isSymbolicLink()) return null;
  }
  try { return await fsp.realpath(dir); } catch { return null; }
}

/**
 * Locate an EXISTING `<slug>.md` across every candidate PRD dir and return
 * its safe, containment-checked absolute path — or null if the slug isn't
 * found anywhere (or would escape its containing dir).
 */
async function safeSlugPath(slug) {
  const dir = await module.exports.findPrdDir(slug);
  if (!dir) return null;
  return module.exports.safeSlugPathIn(dir, slug);
}

/**
 * The two distinct failure modes safeSlugPath collapses into one nullable
 * return (the defect this fixes — see the PRD that added this helper's
 * Goal): a slug that fails SCHEDULE_SLUG_RE is a caller mistake ("invalid
 * slug"), while a well-formed slug that exists in no candidate PRD dir is a
 * lookup miss ("unknown slug") — an agent retrying the first as if it were
 * the second (or vice versa) burns a turn on the wrong fix. Returns
 * `{ ok: true, path }` or `{ ok: false, reason: 'invalid-slug' | 'not-found' }`.
 * `cwd`, if given, narrows the search to that one project's own PRD dirs
 * (prdDirForCwd + its Epic-scoped dirs — same pattern as getPrdParsed);
 * omitted, it searches every candidate dir machine-wide via findPrdDir.
 */
async function resolveSlugOrReason(slug, cwd) {
  if (!SCHEDULE_SLUG_RE.test(slug)) return { ok: false, reason: 'invalid-slug' };
  if (cwd) {
    for (const dir of [module.exports.prdDirForCwd(cwd), ...listEpicPrdDirs(cwd)]) {
      const p = module.exports.safeSlugPathIn(dir, slug);
      if (!p) continue;
      try {
        await fsp.access(p);
        return { ok: true, path: p };
      } catch { /* not in this dir — try the next candidate */ }
    }
    return { ok: false, reason: 'not-found' };
  }
  const dir = await module.exports.findPrdDir(slug);
  if (!dir) return { ok: false, reason: 'not-found' };
  const p = module.exports.safeSlugPathIn(dir, slug);
  if (!p) return { ok: false, reason: 'not-found' };
  return { ok: true, path: p };
}

/**
 * Shared row-match predicate for a reset-job request: slugs carry no cwd
 * salt, so two different projects can independently produce the identical
 * slug. Both the renderer-facing `schedule:reset-job` IPC handler and
 * remote.resetJob (admin/MCP) go through this one predicate so a cwd-bearing
 * caller always resets THAT project's job, never just any row matching the
 * string.
 */
function jobMatchesSlugAndCwd(j, slug, cwd) {
  return j.slug === slug && (!cwd || j.cwd === cwd);
}

/** Actionable message for `resolveSlugOrReason`'s 'not-found' reason. */
function unknownSlugMessage(slug) {
  return `unknown slug "${slug}": no PRD file with that name in any known project — call scheduler_list_prds (optionally with cwd) to see what exists`;
}

/**
 * Move a completed job's `<slug>.md` out of its PRD dir into that dir's
 * sibling `prds-archived/`, so a finished slug can't be re-fired by the
 * scheduler. Sibling-of-source (not the hard-coded legacy PRDS_ARCHIVE_DIR)
 * so a per-project PRD (`<cwd>/session-manager-operations/scheduler/prds/`)
 * archives into that SAME project's `prds-archived/`, not the global legacy
 * one — PRDS_ARCHIVE_DIR only happens to coincide with this for the legacy
 * PRDS_DIR. Mirrors the `schedule:clear-queue` archive logic (same
 * containment check). Non-throwing: a missing source file (already archived
 * or already gone) is a silent no-op, and any other error is logged as a
 * warning — an archive failure must never break job-completion bookkeeping.
 */
async function archiveCompletedPrd(slug, cwd) {
  try {
    const srcDir = (await module.exports.findPrdDir(slug)) ?? module.exports.prdDirForCwd(cwd);
    const src = module.exports.safeSlugPathIn(srcDir, slug);
    if (!src) return;
    const archiveDir = path.join(srcDir, '..', 'prds-archived');
    await fsp.mkdir(archiveDir, { recursive: true });
    const dst = path.join(archiveDir, `${slug}.md`);
    await fsp.rename(src, dst);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'archiveCompletedPrd: rename failed', meta: { slug, error: e?.message } });
    }
  }
}

/**
 * One-time, idempotent migration (PRD 808): move every PRD source .md file
 * still sitting in the legacy global PRDS_DIR into its own project's
 * `<cwd>/session-manager-operations/scheduler/prds/`, based on that PRD's
 * own frontmatter `cwd`. Runs at every boot — a no-op fs.readdir once
 * nothing is left to move. Files migratePrds couldn't resolve (missing/
 * unparseable cwd, cwd not on disk) are left in place and logged as a
 * warning — never silently dropped — so a human can fix the frontmatter.
 */
/**
 * consolidateAllFlatPrds(cwds) — run consolidateFlatPrds() over every given
 * project cwd, logging outcomes. Called from TWO places: once at boot (over
 * every historical project, via runPrdMigration below) AND at the top of
 * every reconcile() call (over every project reconcile itself would
 * otherwise scan), BEFORE reconcile scans the flat dir for PRD sources. The
 * reconcile()-level call is what makes "anything written to the retired flat
 * prds/ dir is swept into prds-archived/ without being executed" actually
 * true regardless of which of reconcile's several callers (tickQueue's poll,
 * job completion, the schedule:rescan/schedule:adopt-prd IPC handlers,
 * broadcast()'s coalescer, rescheduleTimer) triggers the pass — schedule:state
 * no longer reconciles on read. A PRD dropped in the flat dir has no
 * queue row yet at that point, so it is never in LIVE_JOB_STATUSES and this
 * sweep archives it before reconcile can ever turn it into a pending job.
 */
async function consolidateAllFlatPrds(cwds, skipCwds) {
  for (const cwd of cwds) {
    if (skipCwds?.has(cwd)) continue; // torn shard: its PRDs are not ours to touch this pass
    try {
      const c = await consolidateFlatPrds(cwd);
      if (c.moved > 0) {
        console.log(`[scheduler] flat-PRD consolidation: archived ${c.moved} file(s) in ${cwd}`);
      }
      for (const f of c.failed) {
        logs.writeLine({
          level: 'warn', scope: 'scheduler',
          message: `flat-PRD consolidation: could not archive ${f.file}`,
          meta: { cwd, reason: f.reason },
        });
      }
      // Deliberately left behind because a live job still points at them
      // (PRD 992). Logged so a permanently-stuck flat PRD is visible rather
      // than looking like a clean consolidation.
      for (const s of c.skipped ?? []) {
        logs.writeLine({
          level: 'info', scope: 'scheduler',
          message: `flat-PRD consolidation: left ${s.file} in place`,
          meta: { cwd, reason: s.reason },
        });
      }
    } catch (e) {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'flat-PRD consolidation failed', meta: { cwd, error: e?.message } });
    }
  }
}

async function runPrdMigration() {
  let result;
  try {
    result = await migratePrds(schedulerPaths.prdsRoot());
  } catch (e) {
    logs.writeLine({ level: 'error', scope: 'scheduler', message: 'PRD migration failed', meta: { error: e?.message } });
    return null;
  }
  console.log(`[scheduler] PRD migration: moved ${result.moved}, skipped ${result.skipped}`);
  if (result.unresolved.length > 0) {
    logs.writeLine({
      level: 'warn',
      scope: 'scheduler',
      message: `PRD migration: ${result.unresolved.length} file(s) left in legacy dir`,
      meta: { legacyDir: schedulerPaths.prdsRoot(), unresolved: result.unresolved },
    });
    for (const u of result.unresolved) {
      console.warn(`[scheduler] PRD migration: left ${u.file} in legacy dir (${u.reason})`);
    }
  }

  // Phase 2 (2026-07-31 domain-model decision): the flat per-project
  // `scheduler/prds/` dir is retired — new PRDs are epic-scoped, and anything
  // still sitting flat consolidates into `prds-archived/` for later special
  // processing. Queue rows for moved files are reaped by the archived-twin
  // retirement. Idempotent per project; failures are logged, never fatal.
  // (This boot-time pass is redundant with the one reconcile() now also runs
  // on every pass, but stays here so a fresh boot's very first log line
  // still reports the initial sweep — see consolidateAllFlatPrds's own
  // comment for why reconcile() is the load-bearing call site.)
  //
  // Deferred off scheduler.init()'s synchronous critical path: allProjectCwds()
  // is a synchronous ~270ms directory scan, and awaiting it inline here
  // competed with the renderer's first IPC round trips (schedule.state,
  // billing.fetch, teams.list) for the event loop during boot. Dropping the
  // await doesn't weaken the consolidation guarantee — consolidateAllFlatPrds
  // also runs at the top of every reconcile() (see its own comment above),
  // and a flat PRD can only ever execute via tickQueue, which always
  // reconciles first, so nothing dropped in the flat dir can run before a
  // reconcile() pass sweeps it regardless of whether this boot-time pass has
  // finished yet.
  setImmediate(() => {
    module.exports.consolidateAllFlatPrds(allProjectCwds()).catch((e) => {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'deferred flat-PRD consolidation failed', meta: { error: e?.message } });
    });
  });

  // Rollout migration for the PRD-authoring-lockdown feature: stamp every
  // pre-existing PRD as legacy-adopted BEFORE reconcile() ever runs its
  // provenance gate against it. Must run every boot (idempotent, cheap
  // scan-and-skip) rather than once — a project opened for the first time
  // after this shipped still has pre-existing unstamped PRDs the very first
  // time reconcile() sees them.
  try {
    const adopted = await legacyAdoptExistingPrds();
    if (adopted.stamped > 0) {
      console.log(`[scheduler] legacy-adopt migration: stamped ${adopted.stamped} pre-existing PRD(s) as createdVia=legacy-adopted`);
    }
    for (const f of adopted.failed) {
      logs.writeLine({ level: 'warn', scope: 'scheduler', message: 'legacy-adopt migration: could not stamp PRD', meta: f });
    }
  } catch (e) {
    logs.writeLine({ level: 'error', scope: 'scheduler', message: 'legacy-adopt migration failed', meta: { error: e?.message } });
  }

  return result;
}

// Matches only numbered timestamp backups (queue.json.bak-<epoch>), not the
// bare `queue.json.bak` single-shot copy some older code paths left behind.
const QUEUE_BAK_RE = /^queue\.json\.bak-\d+$/;
const QUEUE_BAK_KEEP = 5;

/**
 * Sweeps accumulated queue.json.bak-<epoch> files down to the newest
 * QUEUE_BAK_KEEP, deleting the rest. Runs at boot. `entries` comes from
 * fs.readdir(ROOT), so every candidate path is already contained in ROOT.
 */
async function sweepQueueBackups() {
  let entries;
  try {
    entries = await fsp.readdir(schedulerPaths.scheduledPlansRoot());
  } catch {
    return;
  }
  const baks = entries.filter((f) => QUEUE_BAK_RE.test(f));
  if (baks.length <= QUEUE_BAK_KEEP) return;

  baks.sort((a, b) => {
    const ta = Number(a.slice('queue.json.bak-'.length));
    const tb = Number(b.slice('queue.json.bak-'.length));
    return tb - ta; // newest (largest epoch) first
  });
  const toDelete = baks.slice(QUEUE_BAK_KEEP);
  let removed = 0;
  for (const f of toDelete) {
    try {
      await fsp.unlink(path.join(schedulerPaths.scheduledPlansRoot(), f));
      removed++;
    } catch (e) {
      console.warn('[scheduler] backup sweep: unlink failed', f, e?.message);
    }
  }
  if (removed > 0) {
    console.log(`[scheduler] backup sweep: removed ${removed} old queue.json.bak-* file(s), kept ${QUEUE_BAK_KEEP}`);
  }
}

module.exports = {
  candidatePrdsDirs,
  candidateArchivedPrdsDirs,
  resolveArchivedPrdStatus,
  prdDirForCwd,
  prdPathForJob,
  archivedPrdPathForJob,
  archivedTwinExists,
  findPrdDir,
  findPrdDirForJob,
  jobScopedPrdDirs,
  safeSlugPathIn,
  realPrdsDir,
  safeSlugPath,
  resolveSlugOrReason,
  jobMatchesSlugAndCwd,
  unknownSlugMessage,
  archiveCompletedPrd,
  consolidateAllFlatPrds,
  runPrdMigration,
  sweepQueueBackups,
};
