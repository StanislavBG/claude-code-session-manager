'use strict';
/**
 * packCatalog.cjs — the one reader of Session Manager's shipped context packs.
 *
 * A pack is a Claude Code plugin directory under `plugins/packs/<id>/` plus:
 *   - `sm-pack.json`  — { id, label, description, requires?: { platform? } }
 *   - `laws.md`       — optional always-on rules (≤ PACK_LAWS_CHAR_CAP chars)
 *   - `.claude-plugin/plugin.json` — the plugin manifest `claude --plugin-dir` loads
 *
 * Spawn code and the New Session card share this one catalog. It never throws:
 * a malformed pack becomes an `{ dir, error }` entry, never a crash. No caching.
 */
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const PACK_LAWS_CHAR_CAP = 2000;

const PackManifestSchema = z.object({
  id: z.string().max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case'),
  label: z.string().min(1).max(60),
  description: z.string().max(300),
  requires: z.object({
    platform: z.enum(['darwin', 'linux', 'win32']).optional(),
  }).optional(),
});

/**
 * @typedef {{ platform?: 'darwin'|'linux'|'win32' }} PackRequires
 * @typedef {{ id: string, label: string, description: string, dir: string,
 *   pluginName: string, laws: string, requires: PackRequires }} Pack
 * @typedef {{ dir: string, error: string }} PackError
 */

/** Absolute path to the shipped packs: the package root (same as
 *  pluginInstall.cjs bundledMarketplaceDir()) + plugins/packs. */
function bundledPacksDir() {
  return path.join(__dirname, '..', '..', '..', '..', 'plugins', 'packs');
}

/** @param {string} file @param {string} what */
function readJson(file, what) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`${what} missing`); }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${what} is not valid JSON: ${/** @type {Error} */ (e).message}`); }
}

/** @param {string} dir @returns {Pack} */
function readPack(dir) {
  const parsed = PackManifestSchema.safeParse(readJson(path.join(dir, 'sm-pack.json'), 'sm-pack.json'));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`sm-pack.json invalid: ${msg}`);
  }
  const m = parsed.data;
  if (m.id !== path.basename(dir)) throw new Error(`sm-pack.json id "${m.id}" must equal its directory name "${path.basename(dir)}"`);

  const plugin = readJson(path.join(dir, '.claude-plugin', 'plugin.json'), '.claude-plugin/plugin.json');
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) throw new Error('.claude-plugin/plugin.json must be an object');
  const pluginName = plugin.name;
  if (typeof pluginName !== 'string' || !pluginName) throw new Error('.claude-plugin/plugin.json has no name');
  if (pluginName.startsWith('claude')) throw new Error(`plugin name "${pluginName}" must not start with "claude"`);
  if (plugin.defaultEnabled === false) throw new Error('plugin.json sets defaultEnabled:false — an inline --plugin-dir plugin would not load');

  let laws = '';
  const lawsFile = path.join(dir, 'laws.md');
  if (fs.existsSync(lawsFile)) laws = fs.readFileSync(lawsFile, 'utf8').trim();
  if (laws.length > PACK_LAWS_CHAR_CAP) throw new Error(`laws.md is ${laws.length} chars, over the ${PACK_LAWS_CHAR_CAP} cap`);

  return {
    id: m.id,
    label: m.label,
    description: m.description,
    dir,
    pluginName,
    laws,
    requires: m.requires ? { ...m.requires } : {},
  };
}

/**
 * List every pack under `packsDir`. Never throws.
 * @param {{ packsDir?: string }} [opts]
 * @returns {{ packs: Pack[], errors: PackError[] }}
 */
function listPacks({ packsDir = bundledPacksDir() } = {}) {
  /** @type {Pack[]} */ const packs = [];
  /** @type {PackError[]} */ const errors = [];
  const root = path.resolve(packsDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code !== 'ENOENT') errors.push({ dir: root, error: `cannot read packs directory: ${/** @type {Error} */ (e).message}` });
    return { packs, errors };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    try {
      packs.push(readPack(dir));
    } catch (e) {
      errors.push({ dir, error: String((e && /** @type {Error} */ (e).message) || e) });
    }
  }
  packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { packs, errors };
}

/**
 * @param {string} id
 * @param {{ packsDir?: string }} [opts]
 * @returns {Pack|null}
 */
function getPack(id, opts) {
  return listPacks(opts).packs.find((p) => p.id === id) || null;
}

module.exports = { listPacks, getPack, bundledPacksDir, PACK_LAWS_CHAR_CAP };
