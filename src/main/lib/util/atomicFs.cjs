'use strict';

/**
 * atomicFs.cjs — canonical tmp+rename file-IO primitives, extracted out of
 * config.cjs so non-Electron modules (lib/*.cjs) can reuse the exact same
 * atomic-write recipe without importing config.cjs's electron-adjacent
 * validation layer. NO electron import here, intentionally — this module is
 * pure Node and must stay requirable from any process.
 *
 * Recipe (unchanged from the original config.cjs copies this consolidates):
 * write to `<file>.tmp-<pid>-<ts>-<rand>` in the SAME directory, then rename
 * over the real path. mkdir -p the parent first. On write/rename failure,
 * best-effort unlink the tmp file before rethrowing.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function tmpPathFor(file) {
  return `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * opts.mode: optional POSIX permission bits applied to the tmp file before
 * rename (chmod'd explicitly too — some platforms ignore the mode arg on
 * writeFile when the file pre-exists).
 * opts.fsync: fsync the tmp file's fd before rename (durability for callers
 * that need the write to survive a crash immediately after it returns).
 */
async function writeTextAtomic(file, text, opts = {}) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    const handle = await fsp.open(tmp, 'w', opts.mode);
    try {
      await handle.writeFile(text, 'utf8');
      if (opts.mode) {
        try { await handle.chmod(opts.mode); } catch { /* umask may have already applied it */ }
      }
      if (opts.fsync) await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* tmp never created or already gone */ }
    throw e;
  }
}

function writeTextAtomicSync(file, text, opts = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    const fd = fs.openSync(tmp, 'w', opts.mode);
    try {
      fs.writeSync(fd, text, null, 'utf8');
      if (opts.mode) {
        try { fs.chmodSync(tmp, opts.mode); } catch { /* umask may have already applied it */ }
      }
      if (opts.fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp never created or already gone */ }
    throw e;
  }
}

function serializeJson(obj, { space = 2, newline = true } = {}) {
  const json = JSON.stringify(obj, null, space);
  return newline ? `${json}\n` : json;
}

async function writeJsonAtomic(file, obj, opts = {}) {
  await writeTextAtomic(file, serializeJson(obj, opts), opts);
}

function writeJsonAtomicSync(file, obj, opts = {}) {
  writeTextAtomicSync(file, serializeJson(obj, opts), opts);
}

async function readJsonOr(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    if (raw.trim() === '') return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readJsonOrSync(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim() === '') return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // exists but owned by someone else
  }
}

/**
 * Remove orphaned `<file>.tmp-<pid>-<ts>-<rand>` files left by crashed
 * writers. Direct children of `dir` only (no recursion); a file goes only when
 * its mtime is older than `olderThanMs` AND its embedded pid is not alive.
 * `.corrupt-*` / `.bak*` forensics never match. Never throws.
 */
function sweepStaleTmpFiles(dir, { olderThanMs = 3600000, isPidAlive = defaultIsPidAlive } = {}) {
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed };
  }
  const now = Date.now();
  for (const name of names) {
    try {
      const m = /\.tmp-(\d+)-/.exec(name);
      if (!m) continue;
      if (/\.(corrupt|bak)/.test(name)) continue;
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs <= olderThanMs) continue;
      if (isPidAlive(Number(m[1]))) continue;
      fs.unlinkSync(full);
      removed.push(full);
    } catch { /* per-file errors are skipped */ }
  }
  return { removed };
}

module.exports = {
  sweepStaleTmpFiles,
  tmpPathFor,
  writeTextAtomic,
  writeTextAtomicSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
  readJsonOr,
  readJsonOrSync,
};
