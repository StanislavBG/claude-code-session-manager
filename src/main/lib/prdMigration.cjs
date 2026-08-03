/**
 * prdMigration.cjs — one-time, idempotent move of PRD source .md files out
 * of the legacy global `~/.claude/session-manager/scheduled-plans/prds/`
 * into each PRD's own project's `<cwd>/session-manager-operations/scheduler/prds/`
 * (PRD 808, first of the 808→809→810→811 chain).
 *
 * Idempotent: once a file has been moved out of legacyPrdsDir it is simply
 * absent on the next run — nothing left to move, so a repeat run is a
 * no-op fs.readdir + early return. Files whose frontmatter has no parseable
 * `cwd` are left in place (never silently dropped) and reported back as
 * `strandedCount` so the caller can log a warning — see `migratePrds`'s
 * `unresolved` return field, surfaced by scheduler.cjs's boot safety-net.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const { resolvePrdWriteDir } = require('./prdLocations.cjs');
const { projectQueuePath } = require('./queueStore.cjs');
const { expandHome } = require('./expandHome.cjs');

/**
 * Move every `.md` file in legacyPrdsDir whose frontmatter `cwd` resolves to
 * an on-disk directory into that project's PRDs dir (renamed, not copied).
 * Files with missing/unparseable/non-existent `cwd` are left untouched.
 *
 * Returns { moved, skipped, unresolved } where:
 *   - moved: number of files successfully relocated
 *   - skipped: number of files already gone (race with a concurrent mover)
 *   - unresolved: [{ file, reason }] for every .md left behind in legacyPrdsDir
 */
async function migratePrds(legacyPrdsDir) {
  let entries;
  try {
    entries = await fsp.readdir(legacyPrdsDir);
  } catch {
    return { moved: 0, skipped: 0, unresolved: [] };
  }

  let moved = 0;
  let skipped = 0;
  const unresolved = [];

  for (const name of entries) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const src = path.join(legacyPrdsDir, name);

    let raw;
    try {
      raw = await fsp.readFile(src, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') { skipped++; continue; }
      unresolved.push({ file: name, reason: `read failed: ${e?.message}` });
      continue;
    }

    const { fm } = splitFrontmatter(raw);
    const rawCwd = fm.cwd && fm.cwd.trim();
    if (!rawCwd) {
      unresolved.push({ file: name, reason: 'no cwd in frontmatter' });
      continue;
    }
    const cwd = expandHome(rawCwd);
    if (!fs.existsSync(cwd)) {
      unresolved.push({ file: name, reason: `cwd does not exist on disk: ${rawCwd}` });
      continue;
    }

    const destDir = resolvePrdWriteDir(cwd);
    const dst = path.join(destDir, name);
    try {
      await fsp.mkdir(destDir, { recursive: true });
      await fsp.rename(src, dst);
      moved++;
    } catch (e) {
      if (e?.code === 'ENOENT') { skipped++; continue; }
      unresolved.push({ file: name, reason: `move failed: ${e?.message}` });
    }
  }

  return { moved, skipped, unresolved };
}

/**
 * consolidateFlatPrds(cwd) — one-time, idempotent retirement of the legacy
 * FLAT per-project PRD dir (`scheduler/prds/`) now that new PRDs are always
 * epic-scoped (`scheduler/epics/<id>/prds/`, CLAUDE.md domain model).
 *
 * Every `.md` in the flat dir moves to the sibling `prds-archived/` for later
 * special processing (per 2026-07-31 decision: "new PRDs only; consolidate
 * existing into prds-archived"). Queue rows pointing at moved files are
 * reaped by the existing archived-twin retirement (11ad3d8). Dotfiles
 * (.max-allocated-group, .reserved-*) stay — NN allocation still uses them.
 * Name collisions in prds-archived/ get a `-legacy-<n>` suffix, never an
 * overwrite. Idempotent: an emptied flat dir is a no-op readdir.
 *
 * LIVE JOBS ARE NEVER ARCHIVED (PRD 992). The scheduler still scans this flat
 * dir as a PRD *source* (prdLocations.cjs's resolvePrdsDirs, "scan sources
 * alongside the legacy flat dir"), so a file sitting here can legitimately
 * have a pending/running job. Archiving it out from under that job strands the
 * queue row with no resolvable source. Observed live 2026-08-02:
 * `980-fix-chat-typed-event-renderers.md` sat in this dir with status
 * `running` — a restart in that window would have moved its source mid-run.
 * Such files are left in place and reported as `skipped`, mirroring how the
 * sibling migratePrds() reports `unresolved` rather than dropping anything.
 *
 * Returns { moved, failed: [{ file, reason }], skipped: [{ file, reason }] }.
 */

/** Job statuses that mean "this PRD's source must survive". `needs_review` is
 *  live on purpose: it is awaiting human action and will be re-read. */
const LIVE_JOB_STATUSES = new Set(['pending', 'running', 'needs_review', 'investigating']);

/**
 * Slugs with a live job in this project's own queue shard.
 *
 * Returns null when liveness cannot be determined (unreadable/unparseable
 * queue.json) — the caller then FAILS CLOSED and archives nothing, since it
 * cannot prove a file is safe to move. A merely ABSENT queue.json is not an
 * error: a project with no scheduler state has no jobs, so an empty set is
 * the correct answer and consolidation proceeds normally.
 */
async function liveSlugsForCwd(cwd) {
  let raw;
  try {
    raw = await fsp.readFile(projectQueuePath(cwd), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return new Set(); // fresh project — nothing queued
    return null; // unreadable — caller fails closed
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt — caller fails closed
  }
  const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  const live = new Set();
  for (const job of jobs) {
    if (job && typeof job.slug === 'string' && LIVE_JOB_STATUSES.has(job.status)) {
      live.add(job.slug);
    }
  }
  return live;
}

/** A queue job's slug is its PRD filename minus the `.md` suffix. */
function slugForPrdFile(name) {
  return name.slice(0, -3);
}

async function consolidateFlatPrds(cwd, opts = {}) {
  const flatDir = resolvePrdWriteDir(cwd);
  const archiveDir = path.join(path.dirname(flatDir), 'prds-archived');
  let entries;
  try {
    entries = await fsp.readdir(flatDir);
  } catch {
    return { moved: 0, failed: [], skipped: [] };
  }

  const liveSlugs = opts.liveSlugs !== undefined ? opts.liveSlugs : await liveSlugsForCwd(cwd);

  let moved = 0;
  const failed = [];
  const skipped = [];

  // Fail closed: liveness unknown means every file might belong to a live job.
  if (liveSlugs === null) {
    for (const name of entries) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      skipped.push({ file: name, reason: 'queue state unreadable — cannot prove no live job' });
    }
    return { moved: 0, failed, skipped };
  }

  for (const name of entries) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    if (liveSlugs.has(slugForPrdFile(name))) {
      skipped.push({ file: name, reason: 'live queue job — source must survive' });
      continue;
    }
    const src = path.join(flatDir, name);
    try {
      await fsp.mkdir(archiveDir, { recursive: true });
      let dst = path.join(archiveDir, name);
      for (let n = 1; fs.existsSync(dst); n++) {
        dst = path.join(archiveDir, `${name.slice(0, -3)}-legacy-${n}.md`);
      }
      await fsp.rename(src, dst);
      moved++;
    } catch (e) {
      if (e?.code === 'ENOENT') continue; // raced with a concurrent mover
      failed.push({ file: name, reason: e?.message ?? 'move failed' });
    }
  }
  return { moved, failed, skipped };
}

module.exports = { migratePrds, consolidateFlatPrds, LIVE_JOB_STATUSES };
