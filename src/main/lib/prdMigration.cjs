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

module.exports = { migratePrds };
