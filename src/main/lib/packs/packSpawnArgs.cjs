'use strict';
/**
 * packSpawnArgs.cjs — turn an Epic's selected context-pack ids into Claude CLI
 * arguments. Pure and never throws; both spawn paths (chat turns, PRD jobs) call it.
 *
 *   pluginDirArgs — ['--plugin-dir', <abs dir>, ...], one per known pack, in order, deduped
 *   laws          — the packs' always-on rules as one `--append-system-prompt` text ('' if none)
 *   unknown       — ids not in the catalog, or whose requires.platform ≠ platform
 *
 * A directory only ever comes from a catalog entry — an id is never joined into a path.
 */
const { listPacks } = require('./packCatalog.cjs');

const LAWS_HEADER = '# Context packs for this session';

/** @param {unknown} p */
function isUsablePack(p) {
  if (!p || typeof p !== 'object') return false;
  const o = /** @type {Record<string, unknown>} */ (p);
  return typeof o.id === 'string' && typeof o.dir === 'string' && o.dir.length > 0;
}

/**
 * @param {{ packIds?: unknown, catalog?: unknown, platform?: string }} [opts]
 * @returns {{ pluginDirArgs: string[], laws: string, unknown: string[] }}
 */
function composePackSpawnArgs({ packIds, catalog, platform = process.platform } = {}) {
  /** @type {string[]} */ const pluginDirArgs = [];
  /** @type {string[]} */ const unknown = [];
  /** @type {string[]} */ const lawSections = [];
  if (!Array.isArray(packIds) || packIds.length === 0) return { pluginDirArgs, laws: '', unknown };

  let entries = catalog;
  if (entries === undefined) {
    try { entries = listPacks().packs; } catch { entries = []; }
  }
  /** @type {Map<string, any>} */ const byId = new Map();
  if (Array.isArray(entries)) {
    for (const p of entries) if (isUsablePack(p) && !byId.has(p.id)) byId.set(p.id, p);
  }

  const seen = new Set();
  for (const raw of packIds) {
    const id = String(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const pack = typeof raw === 'string' ? byId.get(raw) : undefined;
    const need = pack && pack.requires && typeof pack.requires === 'object' ? pack.requires.platform : undefined;
    if (!pack || (need && need !== platform)) { unknown.push(id); continue; }
    pluginDirArgs.push('--plugin-dir', pack.dir);
    const laws = typeof pack.laws === 'string' ? pack.laws.trim() : '';
    if (laws) lawSections.push(`## ${typeof pack.label === 'string' && pack.label ? pack.label : pack.id} pack`, laws);
  }

  const laws = lawSections.length ? [LAWS_HEADER, ...lawSections].join('\n\n') : '';
  return { pluginDirArgs, laws, unknown };
}

module.exports = { composePackSpawnArgs, LAWS_HEADER };
