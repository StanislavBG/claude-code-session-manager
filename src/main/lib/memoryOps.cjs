'use strict';

/**
 * Memory page actions over an already-resolved memory folder: verify (touch),
 * archive / restore (move to / from `<dir>/.archive/`) and listArchived.
 * Claude Code's native files stay the only truth — no new frontmatter fields.
 * Every path goes through config.validatePath + validateWrite before any mutation.
 * Top-level in lib/ (not a domain subfolder): sits beside memoryIndex/memorySlug,
 * which it composes.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config.cjs');
const { addIndexLine, removeIndexLines } = require('./memoryIndex.cjs');
const { MEMORY_SLUG_RE } = require('./memorySlug.cjs');

const fsp = fs.promises;
const INDEX_NAME = 'MEMORY.md';
const ARCHIVE_DIR = '.archive';

function checkName(name) {
  if (typeof name !== 'string' || name === INDEX_NAME || !MEMORY_SLUG_RE.test(name)) {
    throw new Error('invalid memory name');
  }
}

/** Validate a path for writing; returns the symlink-resolved path. */
function guard(abs) {
  const real = config.validatePath(abs);
  config.validateWrite(real);
  return real;
}

async function exists(abs) {
  try { await fsp.lstat(abs); return true; } catch { return false; }
}

async function readIndex(dir) {
  const r = await config.readText(path.join(dir, INDEX_NAME));
  return r.exists ? r.text : null;
}

/** Set atime/mtime to now; content untouched. */
async function verify(dir, name) {
  try {
    checkName(name);
    const real = guard(path.join(dir, name));
    const now = new Date();
    await fsp.utimes(real, now, now);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Move `<dir>/<name>` into `<dir>/.archive/` and drop its index line(s). */
async function archive(dir, name) {
  try {
    checkName(name);
    const src = guard(path.join(dir, name));
    const archDir = guard(path.join(dir, ARCHIVE_DIR));
    const dest = guard(path.join(archDir, name));
    if (!(await exists(src))) throw new Error('memory not found');
    if (await exists(dest)) throw new Error('archived copy already exists');
    await fsp.mkdir(archDir, { recursive: true });
    await fsp.rename(src, dest);
    const text = await readIndex(dir);
    if (text !== null) {
      const next = removeIndexLines(text, name);
      if (next !== text) await config.writeTextAtomic(path.join(dir, INDEX_NAME), next);
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Move an archived memory back and re-add its index line. */
async function restore(dir, name) {
  try {
    checkName(name);
    const dest = guard(path.join(dir, name));
    const src = guard(path.join(dir, ARCHIVE_DIR, name));
    if (!(await exists(src))) throw new Error('archived memory not found');
    if (await exists(dest)) throw new Error('memory already exists');
    await fsp.rename(src, dest);
    const head = (await fsp.readFile(dest, 'utf8')).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const d = head && head[1].match(/^\s*description:\s*"?(.*?)"?\s*$/m);
    const hook = d ? d[1].trim() : '';
    const text = (await readIndex(dir)) || '';
    const next = addIndexLine(text, { file: name, title: name.replace(/\.md$/, ''), hook });
    if (next !== text) await config.writeTextAtomic(path.join(dir, INDEX_NAME), next);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Names in `<dir>/.archive/`; a missing folder is an empty list. */
async function listArchived(dir) {
  try {
    const real = config.validatePath(path.join(dir, ARCHIVE_DIR));
    const entries = await fsp.readdir(real, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isFile() && MEMORY_SLUG_RE.test(e.name))
      .map((e) => e.name)
      .sort();
    return { names, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { names: [], error: null };
    return { names: [], error: e.message };
  }
}

module.exports = { verify, archive, restore, listArchived };
