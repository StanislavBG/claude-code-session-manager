'use strict';

/**
 * planRecordHarvest.cjs — copy the plan records a job wrote inside its git
 * worktree (`<ops>/plan-records/<epic-id>/*.md`, never committed) into the
 * main checkout's `plan-records/<epic-id>/`, writing as the namespace owner
 * ('scheduler'), so they survive worktree teardown without a commit.
 *
 * Never throws: every refusal is reported in `skipped` with a reason.
 */

const fs = require('node:fs');
const path = require('node:path');
const { OPS_ROOT_DIR, opsPath, checkOpsWrite, assertOpsWrite } = require('../opsOwnership.cjs');
const { writeTextAtomicSync, writeJsonAtomic } = require('../util/atomicFs.cjs');

const NAMESPACE = 'plan-records';
const WRITER = 'scheduler';
const MAX_BYTES = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]+\.md$/;
const EPIC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

const DECLARED_PREFIX = `${OPS_ROOT_DIR}/${NAMESPACE}/`;
const CROSS_EPIC_EXISTS = 'exists in another Epic folder; not overwritten';
const SYMLINKED_PARENT = 'symlinked parent refused';

/**
 * refusedParent(chain) → { path, reason } | null
 * lstat-checks each source parent in order (outermost first) without ever
 * following a link. A symlink anywhere in the chain is refused; a missing
 * entry ends the check (nothing below it exists to copy); any other lstat
 * error is refused too, so an unreadable parent never lets a pass through.
 * @param {string[]} chain @param {typeof fs} [fsImpl]
 * @returns {{ path: string, reason: string } | null}
 */
function refusedParent(chain, fsImpl = fs) {
  for (const p of chain) {
    let st;
    try {
      st = fsImpl.lstatSync(p);
    } catch (e) {
      if (e && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
      return { path: p, reason: `cannot check parent: ${errMsg(e)}` };
    }
    if (st.isSymbolicLink()) return { path: p, reason: SYMLINKED_PARENT };
  }
  return null;
}

/**
 * destExists(dest) → true when anything (file, folder, symlink — never
 * followed) sits at `dest`. Any lstat error other than ENOENT counts as
 * existing, so an unreadable destination is never overwritten.
 * @param {string} dest @param {typeof fs} [fsImpl]
 */
function destExists(dest, fsImpl = fs) {
  try {
    fsImpl.lstatSync(dest);
    return true;
  } catch (e) {
    return !(e && /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT');
  }
}

/**
 * parseDeclaredPath(p) → { folder, name } | { reason }
 * A declared record must be exactly
 * `session-manager-operations/plan-records/<epic-folder>/<name>.md` (posix,
 * repo-relative), with no `..` segment and no NUL byte.
 */
function parseDeclaredPath(p) {
  if (typeof p !== 'string' || !p) return { reason: 'declared path is not a string' };
  if (p.includes('\0')) return { reason: 'declared path contains a NUL byte' };
  const posix = p.replace(/\\/g, '/');
  if (posix.split('/').includes('..')) return { reason: 'declared path contains ..' };
  if (path.posix.isAbsolute(posix)) return { reason: 'declared path is absolute' };
  const norm = path.posix.normalize(posix);
  if (!norm.startsWith(DECLARED_PREFIX)) return { reason: 'declared path is not under plan-records/' };
  const parts = norm.slice(DECLARED_PREFIX.length).split('/');
  if (parts.length !== 2) return { reason: 'declared path must be plan-records/<epic-folder>/<name>.md' };
  const [folder, name] = parts;
  if (!EPIC_ID_RE.test(folder)) return { reason: 'declared epic folder not allowed' };
  if (!NAME_RE.test(name)) return { reason: 'name not allowed' };
  return { folder, name };
}

/**
 * harvestPlanRecords({ worktreeDir, projectRoot, epicId, declaredPaths, fsImpl })
 *   → { copied: string[], skipped: { path, reason }[] }
 * Copies every record in the job's own `plan-records/<epicId>/` folder, plus
 * each well-formed `declaredPaths` entry (the PRD's frontmatter
 * artifactPaths), whose folder may be a different Epic's — create-only there:
 * an existing destination in another Epic's folder is never overwritten.
 * `copied` holds destination absolute paths.
 */
function harvestPlanRecords({ worktreeDir, projectRoot, epicId, declaredPaths = [], fsImpl = fs } = {}) {
  /** @type {string[]} */
  const copied = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  /** @type {Set<string>} source paths already handled */
  const seen = new Set();

  /**
   * Copy one record `src` to `plan-records/<folder>/<name>` in the main
   * checkout with every safety check. Returns false when `missingReason` is
   * set and the source does not exist (reported with that reason).
   * @param {string} src @param {string} folder @param {string} name
   * @param {string} [missingReason]
   * @param {boolean} [createOnly] another Epic's folder: never overwrite an
   *   existing destination (checked with lstat, so a symlink counts as existing)
   */
  function copyOne(src, folder, name, missingReason, createOnly = false) {
    seen.add(src);
    try {
      if (!NAME_RE.test(name)) { skipped.push({ path: src, reason: 'name not allowed' }); return; }
      let st;
      try {
        st = fsImpl.lstatSync(src);
      } catch (e) {
        if (missingReason && e && e.code === 'ENOENT') { skipped.push({ path: src, reason: missingReason }); return; }
        throw e;
      }
      if (st.isSymbolicLink()) { skipped.push({ path: src, reason: 'symlink' }); return; }
      if (st.isDirectory()) { skipped.push({ path: src, reason: 'directory' }); return; }
      if (!st.isFile()) { skipped.push({ path: src, reason: 'not a regular file' }); return; }
      if (st.size > MAX_BYTES) { skipped.push({ path: src, reason: `oversize (${st.size} > ${MAX_BYTES} bytes)` }); return; }

      const destDir = path.resolve(opsPath(projectRoot, NAMESPACE, folder));
      const dest = path.resolve(opsPath(projectRoot, NAMESPACE, folder, name));
      if (path.dirname(dest) !== destDir) { skipped.push({ path: src, reason: 'destination escapes plan-records folder' }); return; }
      if (dest === src) return;
      const verdict = checkOpsWrite(dest, WRITER);
      if (!verdict.ok) { skipped.push({ path: src, reason: `write refused: ${verdict.error}` }); return; }
      assertOpsWrite(dest, WRITER);

      const text = fsImpl.readFileSync(src, 'utf8');
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) { skipped.push({ path: src, reason: 'oversize after read' }); return; }
      if (createOnly && destExists(dest, fsImpl)) { skipped.push({ path: src, reason: CROSS_EPIC_EXISTS }); return; }
      writeTextAtomicSync(dest, text);
      copied.push(dest);
    } catch (e) {
      skipped.push({ path: src, reason: `copy failed: ${errMsg(e)}` });
    }
  }

  try {
    // An unsafe epicId only disqualifies pass 1 (the job's own folder); each
    // declared path is validated on its own in pass 2.
    const ownFolderSafe = typeof epicId === 'string' && EPIC_ID_RE.test(epicId);
    if (!ownFolderSafe) skipped.push({ path: String(epicId), reason: 'unsafe epicId' });
    if (typeof worktreeDir !== 'string' || !path.isAbsolute(worktreeDir)
      || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
      skipped.push({ path: String(worktreeDir), reason: 'worktreeDir and projectRoot must be absolute paths' });
      return { copied, skipped };
    }
    if (path.resolve(worktreeDir) === path.resolve(projectRoot)) return { copied, skipped };
    const wtRoot = path.resolve(worktreeDir);
    const opsSrc = path.join(wtRoot, OPS_ROOT_DIR);
    const recordsSrc = path.join(opsSrc, NAMESPACE);

    // Pass 1: everything in the job's own plan-records/<epicId>/ folder.
    folderPass: {
      if (!ownFolderSafe) break folderPass;
      const srcDir = path.join(recordsSrc, epicId);
      let destDir;
      try {
        destDir = path.resolve(opsPath(projectRoot, NAMESPACE, epicId));
      } catch (e) {
        skipped.push({ path: srcDir, reason: `destination refused: ${errMsg(e)}` });
        break folderPass;
      }
      if (destDir === srcDir) break folderPass;
      // Never read through a symlinked session-manager-operations/,
      // plan-records/ or epic folder: it could point outside the worktree.
      const refused = refusedParent([opsSrc, recordsSrc, srcDir], fsImpl);
      if (refused) { skipped.push(refused); break folderPass; }
      let srcStat;
      try {
        srcStat = fsImpl.lstatSync(srcDir);
      } catch {
        break folderPass; // no records written by this job in its own folder
      }
      if (!srcStat.isDirectory()) {
        skipped.push({ path: srcDir, reason: 'source is not a directory' });
        break folderPass;
      }
      let names;
      try {
        names = fsImpl.readdirSync(srcDir).map(String).sort();
      } catch (e) {
        skipped.push({ path: srcDir, reason: `cannot list source: ${errMsg(e)}` });
        break folderPass;
      }
      for (const name of names) copyOne(path.join(srcDir, name), epicId, name);
    }

    // Pass 2: records the PRD declared in frontmatter artifactPaths.
    const declared = Array.isArray(declaredPaths) ? declaredPaths : [];
    // The shared parents are checked once; a symlink there refuses the pass.
    const sharedRefused = declared.length ? refusedParent([opsSrc, recordsSrc], fsImpl) : null;
    if (sharedRefused) skipped.push(sharedRefused);
    for (const p of sharedRefused ? [] : declared) {
      const parsed = parseDeclaredPath(p);
      if (!('folder' in parsed)) { skipped.push({ path: String(p), reason: parsed.reason }); continue; }
      const src = path.join(recordsSrc, parsed.folder, parsed.name);
      if (seen.has(src)) continue;
      // Pass 1 refuses a symlinked/non-directory own folder; hold every
      // declared folder to the same rule so a declaration cannot bypass it.
      const folderDir = path.dirname(src);
      const folderRefused = refusedParent([folderDir], fsImpl);
      if (folderRefused) { seen.add(src); skipped.push(folderRefused); continue; }
      let folderStat = null;
      try { folderStat = fsImpl.lstatSync(folderDir); } catch { /* missing: copyOne reports */ }
      if (folderStat && (folderStat.isSymbolicLink() || !folderStat.isDirectory())) {
        seen.add(src);
        skipped.push({ path: src, reason: 'declared epic folder is not a directory' });
        continue;
      }
      // Another Epic's folder is create-only: a job may add a record there
      // (a validator writing into the Epic it validates) but never overwrite one.
      copyOne(src, parsed.folder, parsed.name, 'declared plan record not found in worktree', parsed.folder !== epicId);
    }
  } catch (e) {
    skipped.push({ path: String(worktreeDir), reason: `harvest failed: ${errMsg(e)}` });
  }
  return { copied, skipped };
}

/**
 * saveValidatorVerdicts({ cwd, epicId, validateSlug, record, write, appendEvent })
 *   → Promise<string> (the written path)
 * Writes `plan-records/<epicId>/<validateSlug>.verdicts.json` as the namespace
 * owner, then appends one `validator.verdict` { validateSlug, verdicts:
 * [{ prd, verdict }] } event to the Epic's event log. A write failure rejects
 * (the caller logs it); an event-log append failure is logged, never thrown.
 */
async function saveValidatorVerdicts({
  cwd, epicId, validateSlug, record, write = writeJsonAtomic, appendEvent = null,
} = {}) {
  const file = opsPath(cwd, NAMESPACE, epicId, `${validateSlug}.verdicts.json`);
  assertOpsWrite(file, WRITER);
  await write(file, record);
  try {
    const append = appendEvent || require('../epic/epicEventLog.cjs').appendEpicEvent;
    const rows = Array.isArray(record && record.verdicts) ? record.verdicts : [];
    await append(cwd, epicId, {
      kind: 'validator.verdict',
      validateSlug,
      verdicts: rows
        .filter((v) => v && typeof v === 'object')
        .map((v) => ({ prd: String(v.prd ?? ''), verdict: String(v.verdict ?? '') })),
    });
  } catch (e) {
    console.error('[planRecordHarvest] validator.verdict event append failed', epicId, validateSlug, errMsg(e));
  }
  return file;
}

module.exports = { harvestPlanRecords, saveValidatorVerdicts, MAX_BYTES, NAME_RE, EPIC_ID_RE };
