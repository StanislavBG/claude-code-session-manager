// @ts-check
/**
 * effectiveSettings.cjs — the ONE main-process resolver for Claude Code settings.
 *
 * Precedence (high → low): managed > local > project > user. Merge rules mirror
 * src/renderer/lib/mergeScopes.ts: objects deep-merge, arrays accumulate across scopes
 * (low → high order, so callers can dedupe keeping first sight), scalars/mixed → highest wins.
 * Missing or invalid files are skipped and reported in `errors` (never thrown).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** @typedef {'managed'|'user'|'project'|'local'} SettingsScope */

/** Scopes low → high precedence. */
const SCOPE_ORDER = /** @type {SettingsScope[]} */ (['user', 'project', 'local', 'managed']);

/** @param {string} [platform] */
function managedSettingsPath(platform = process.platform) {
  return platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';
}

/** @param {unknown} v @returns {'array'|'object'|'scalar'} */
function kindOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v !== null && typeof v === 'object') return 'object';
  return 'scalar';
}

/**
 * Merge entries (LOW → HIGH precedence) into one value + per-leaf winner map.
 * @param {{scope: SettingsScope, data: any}[]} entries
 * @returns {{ merged: Record<string, any>, winnerByKey: Record<string, SettingsScope> }}
 */
function mergeLayers(entries) {
  /** @type {Record<string, SettingsScope>} */
  const winnerByKey = {};
  /** @param {{scope: SettingsScope, data: any}[]} scoped @param {string[]} p @returns {any} */
  const walk = (scoped, p) => {
    if (scoped.every((s) => kindOf(s.data) === 'object')) {
      /** @type {Record<string, any>} */
      const out = {};
      const keys = new Set(scoped.flatMap((s) => Object.keys(s.data)));
      for (const k of keys) {
        out[k] = walk(
          scoped.filter((s) => Object.prototype.hasOwnProperty.call(s.data, k)).map((s) => ({ scope: s.scope, data: s.data[k] })),
          [...p, k],
        );
      }
      return out;
    }
    const top = scoped[scoped.length - 1];
    winnerByKey[p.join('.')] = top.scope;
    if (scoped.every((s) => kindOf(s.data) === 'array')) return scoped.flatMap((s) => s.data);
    return top.data;
  };
  const live = entries.filter((e) => kindOf(e.data) === 'object');
  return { merged: live.length ? walk(live, []) : {}, winnerByKey };
}

/**
 * Highest-precedence value of `key` among layered settings ({user,project,local,managed}) that
 * passes `pred`; an invalid value in a higher layer falls through to the next one.
 * @param {Record<string, any> | null | undefined} layers
 * @param {string} key
 * @param {(v: any) => boolean} pred
 */
function pickByPrecedence(layers, key, pred) {
  for (const scope of [...SCOPE_ORDER].reverse()) {
    const s = layers && layers[scope];
    if (s && typeof s === 'object' && pred(s[key])) return s[key];
  }
  return undefined;
}

/**
 * @param {{ home?: string, cwd?: string|null, fs?: any, platform?: string, managedPath?: string }} [opts]
 *   `cwd` is the project root (whose `.claude/` holds project + local settings); omit for user/managed only.
 * @returns {{ merged: Record<string, any>, winnerByKey: Record<string, SettingsScope>,
 *   layers: Partial<Record<SettingsScope, any>>, errors: { file: string, scope: SettingsScope, error: string }[] }}
 */
function effectiveSettings(opts = {}) {
  const fsImpl = opts.fs || fs;
  const home = opts.home || os.homedir();
  const cwd = opts.cwd ? path.resolve(opts.cwd) : null;
  /** @type {{scope: SettingsScope, file: string}[]} */
  const files = [{ scope: 'user', file: path.join(home, '.claude', 'settings.json') }];
  if (cwd) files.push({ scope: 'project', file: path.join(cwd, '.claude', 'settings.json') });
  files.push({ scope: 'local', file: path.join(home, '.claude', 'settings.local.json') });
  if (cwd) files.push({ scope: 'local', file: path.join(cwd, '.claude', 'settings.local.json') });
  files.push({ scope: 'managed', file: opts.managedPath || managedSettingsPath(opts.platform) });

  /** @type {{ file: string, scope: SettingsScope, error: string }[]} */
  const errors = [];
  /** @type {Partial<Record<SettingsScope, any>>} */
  const layers = {};
  /** @type {{scope: SettingsScope, data: any}[]} */
  const entries = [];
  for (const { scope, file } of files) {
    try {
      const data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      if (kindOf(data) !== 'object') throw new Error('not a JSON object');
      entries.push({ scope, data });
      layers[scope] = layers[scope] ? mergeLayers([{ scope, data: layers[scope] }, { scope, data }]).merged : data;
    } catch (e) {
      errors.push({ file, scope, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Stable sort by scope rank (same-scope files keep file order: home-local below project-local).
  entries.sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope));
  const { merged, winnerByKey } = mergeLayers(entries);
  return { merged, winnerByKey, layers, errors };
}

module.exports = { effectiveSettings, mergeLayers, pickByPrecedence, managedSettingsPath, SCOPE_ORDER };
