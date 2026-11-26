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
const os = require('os');
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
 *   pluginName: string, laws: string, requires: PackRequires, source: 'shipped'|'plugin',
 *   skills: string[] }} Pack
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
    source: 'shipped',
    skills: listSkillsIn(path.join(dir, 'skills'), pluginName),
  };
}

/** Folder names under `skillsDir` holding a SKILL.md; prefixed `<prefix>:` when given. Never throws.
 *  @param {string} skillsDir @param {string} [prefix] @returns {string[]} */
function listSkillsIn(skillsDir, prefix) {
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
      .map((e) => (prefix ? `${prefix}:${e.name}` : e.name))
      .sort();
  } catch { return []; }
}

/** Loose ~/.claude/skills folders: visible but not equippable (not in a pack).
 *  @param {{ home?: string }} [opts] @returns {string[]} */
function listUnpackedSkills({ home = os.homedir() } = {}) {
  return listSkillsIn(path.join(home, '.claude', 'skills'));
}

/** @param {string} dir @param {string} id @returns {Pack} */
function readPluginPack(dir, id) {
  const plugin = readJson(path.join(dir, '.claude-plugin', 'plugin.json'), '.claude-plugin/plugin.json');
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) throw new Error('.claude-plugin/plugin.json must be an object');
  const pluginName = typeof plugin.name === 'string' && plugin.name ? plugin.name : id;
  return {
    id,
    label: id,
    description: typeof plugin.description === 'string' ? plugin.description : '',
    dir,
    pluginName,
    laws: '',
    requires: {},
    source: 'plugin',
    skills: listSkillsIn(path.join(dir, 'skills'), pluginName),
  };
}

/** Installed Claude Code plugins from installed_plugins.json. Never throws.
 *  @param {string} file @returns {{ packs: Pack[], errors: PackError[] }} */
function listPluginPacks(file) {
  /** @type {Pack[]} */ const packs = [];
  /** @type {PackError[]} */ const errors = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') errors.push({ dir: file, error: `cannot read installed_plugins.json: ${/** @type {Error} */ (e).message}` });
    return { packs, errors };
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    errors.push({ dir: file, error: `installed_plugins.json is not valid JSON: ${/** @type {Error} */ (e).message}` });
    return { packs, errors };
  }
  const plugins = data && typeof data === 'object' ? data.plugins : null;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    errors.push({ dir: file, error: 'installed_plugins.json has no plugins object' });
    return { packs, errors };
  }
  for (const [key, installs] of Object.entries(plugins)) {
    const id = key.split('@')[0];
    const list = Array.isArray(installs) ? installs : [];
    const last = list[list.length - 1];
    const installPath = last && typeof last.installPath === 'string' ? last.installPath : '';
    if (!installPath) { errors.push({ dir: file, error: `plugin "${key}" has no installPath` }); continue; }
    try {
      if (!fs.statSync(installPath).isDirectory()) throw new Error('not a directory');
    } catch { errors.push({ dir: installPath, error: `plugin "${key}" installPath is missing` }); continue; }
    try { packs.push(readPluginPack(installPath, id)); } catch (e) {
      errors.push({ dir: installPath, error: String((e && /** @type {Error} */ (e).message) || e) });
    }
  }
  return { packs, errors };
}

/**
 * List every pack under `packsDir`. Never throws.
 * Installed plugins are added unless `packsDir` is given without `home`/`pluginsFile`
 * (a fixture-only call must not read the real ~/.claude).
 * @param {{ packsDir?: string, home?: string, pluginsFile?: string }} [opts]
 * @returns {{ packs: Pack[], errors: PackError[] }}
 */
function listPacks({ packsDir, home, pluginsFile } = {}) {
  const withPlugins = packsDir === undefined || home !== undefined || pluginsFile !== undefined;
  const r = listShipped(packsDir === undefined ? bundledPacksDir() : packsDir);
  if (!withPlugins) return r;
  const file = pluginsFile || path.join(home || os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const pl = listPluginPacks(file);
  for (const p of pl.packs) {
    if (r.packs.some((x) => x.id === p.id)) r.errors.push({ dir: p.dir, error: `plugin id "${p.id}" collides with a shipped pack; shipped pack kept` });
    else r.packs.push(p);
  }
  r.errors.push(...pl.errors);
  r.packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return r;
}

/** @param {string} packsDir @returns {{ packs: Pack[], errors: PackError[] }} */
function listShipped(packsDir) {
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
 * @param {{ packsDir?: string, home?: string, pluginsFile?: string }} [opts]
 * @returns {Pack|null}
 */
function getPack(id, opts) {
  return listPacks(opts).packs.find((p) => p.id === id) || null;
}

module.exports = { listPacks, listUnpackedSkills, getPack, bundledPacksDir, PACK_LAWS_CHAR_CAP };
