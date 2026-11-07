// @ts-check
'use strict';

/**
 * claudeConfig.cjs — registry of Claude Code's JSON config files plus a
 * key-scoped patch(). patch() re-reads the file fresh under a per-file lock,
 * sets (or deletes) ONE key path and writes atomically, so a stale renderer
 * draft can never clobber keys the CLI (or another writer) changed meanwhile.
 * Writes go through config.cjs writeJson => validatePath + validateWrite +
 * lib/util/atomicFs.cjs. No IPC here.
 */

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const config = require('../config.cjs');

/** @typedef {'user'|'project'|'local'} Scope */
/** @typedef {{ scopes: Scope[], resolve: (scope: string, home: string, cwd?: string|null) => string|null }} FileSpec */

/** @type {Record<string, FileSpec>} */
const REGISTRY = {
  settings: {
    scopes: ['user', 'project', 'local'],
    resolve: (scope, home, cwd) => {
      if (scope === 'user') return path.join(home, '.claude', 'settings.json');
      if (!cwd) return null;
      if (scope === 'project') return path.join(cwd, '.claude', 'settings.json');
      if (scope === 'local') return path.join(cwd, '.claude', 'settings.local.json');
      return null;
    },
  },
  claudeJson: {
    scopes: ['user'],
    resolve: (scope, home) => (scope === 'user' ? path.join(home, '.claude.json') : null),
  },
  mcpJson: {
    scopes: ['project'],
    resolve: (scope, _home, cwd) => (scope === 'project' && cwd ? path.join(cwd, '.mcp.json') : null),
  },
};

/**
 * @param {{ fileId: string, scope: string, cwd?: string|null, home?: string }} p
 * @returns {string}
 */
function resolvePath({ fileId, scope, cwd, home }) {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, fileId)) {
    throw new Error(`claudeConfig: unknown fileId "${fileId}"`);
  }
  const spec = REGISTRY[fileId];
  if (!/** @type {string[]} */ (spec.scopes).includes(scope)) {
    throw new Error(`claudeConfig: file "${fileId}" does not support scope "${scope}"`);
  }
  const abs = spec.resolve(scope, home || os.homedir(), cwd);
  if (!abs) throw new Error(`claudeConfig: cannot resolve "${fileId}" at scope "${scope}" without a cwd`);
  return abs;
}

/**
 * Read + parse. Missing file => {}. Invalid JSON / non-object => throws naming the path.
 * @param {string} abs
 * @returns {Promise<Record<string, any>>}
 */
async function readParsed(abs) {
  let text;
  try {
    text = await fsp.readFile(abs, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return {};
    throw e;
  }
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`claudeConfig: ${abs} is not valid JSON (${/** @type {Error} */ (e).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`claudeConfig: ${abs} does not contain a JSON object`);
  }
  return parsed;
}

/**
 * @param {{ fileId: string, scope: string, cwd?: string|null, home?: string }} p
 * @returns {Promise<{ path: string, data: Record<string, any> }>}
 */
async function read(p) {
  const abs = resolvePath(p);
  return { path: abs, data: await readParsed(abs) };
}

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/** @param {string|string[]} keyPath */
function toSegments(keyPath) {
  const segs = Array.isArray(keyPath) ? keyPath : String(keyPath).split('.');
  if (!segs.length || segs.some((s) => typeof s !== 'string' || s === '')) {
    throw new Error('claudeConfig: keyPath must be non-empty');
  }
  if (segs.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) {
    throw new Error('claudeConfig: forbidden keyPath segment');
  }
  return segs;
}

/**
 * Set one key path (value === undefined deletes it) under the per-file lock.
 * @param {{ fileId: string, scope: string, cwd?: string|null, keyPath: string|string[], value: any, home?: string }} p
 * @returns {Promise<{ ok: true, path: string, data: Record<string, any> }>}
 */
async function patch(p) {
  const abs = resolvePath(p);
  const segs = toSegments(p.keyPath);
  return withLock(abs, async () => {
    const data = await readParsed(abs);
    let node = data;
    if (p.value === undefined) {
      for (let i = 0; i < segs.length - 1; i++) {
        const next = node[segs[i]];
        if (!next || typeof next !== 'object') { node = /** @type {any} */ (null); break; }
        node = next;
      }
      if (node) delete node[segs[segs.length - 1]];
    } else {
      for (let i = 0; i < segs.length - 1; i++) {
        const next = node[segs[i]];
        if (!next || typeof next !== 'object' || Array.isArray(next)) node[segs[i]] = {};
        node = node[segs[i]];
      }
      node[segs[segs.length - 1]] = p.value;
    }
    await config.writeJson(abs, data);
    return { ok: /** @type {const} */ (true), path: abs, data };
  });
}

module.exports = { REGISTRY, read, patch };
