/**
 * First-boot seeder for the bundled `session-manager-dev` plugin.
 *
 * The plugin (3 skills under plugins/session-manager-dev/skills: builder, develop, send-feedback) ships inside the npx distribution. To make it
 * a true default, the app installs it on first launch from its own bundled
 * marketplace (offline — no GitHub/registry). Idempotent two ways:
 *
 *   1. A marker file (`~/.claude/session-manager/.dev-plugin-seeded`) records
 *      seed state. Once the install SUCCEEDS we write `done` and never touch it
 *      again, so a deliberate uninstall stays uninstalled. A FAILED attempt only
 *      bumps an attempt counter and retries on the next few boots — a transient
 *      first-boot failure (e.g. `claude` not yet on PATH, briefly offline) must
 *      not permanently skip the default plugin. After MAX_ATTEMPTS we give up
 *      (manual install via the Plugins library button is always available).
 *   2. Before attempting, we check settings.json `enabledPlugins` — if the
 *      plugin is already enabled (e.g. installed by hand), we just write the
 *      marker and skip the install.
 *
 * Stay-current pass (`upgradeIfStale`, like seedAgentPersonas' upgrade pass): runs on EVERY
 * call, independent of the done-marker. If the plugin is installed AND enabled at a version
 * older than the bundled plugin.json version, it runs the claude CLI marketplace update +
 * plugin update. Never acts when not installed, disabled (a deliberate disable stays), or
 * versions are equal/newer. Failures are logged, never thrown.
 *
 * Fire-and-forget: called post-window from index.cjs. Errors are logged, never
 * thrown. Kill-switch: SM_SEED_DEV_PLUGIN_DISABLE=1.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { install, update, bundledMarketplaceDir } = require('./pluginInstall.cjs');

const PLUGIN_SLUG = 'session-manager-dev';
const MARKETPLACE = { add: 'bundled', name: 'session-manager' };
const ENABLED_KEY = `${PLUGIN_SLUG}@${MARKETPLACE.name}`;
const MAX_ATTEMPTS = 3; // give a transient first-boot failure a few chances

function markerPath(home = os.homedir()) {
  return path.join(home, '.claude', 'session-manager', '.dev-plugin-seeded');
}

/** Read the marker → { done:boolean, attempts:number }. Absent = fresh. */
function readMarker(home) {
  try {
    const raw = fs.readFileSync(markerPath(home), 'utf8').trim();
    const m = JSON.parse(raw);
    return { done: !!m.done, attempts: Number(m.attempts) || 0 };
  } catch {
    return { done: false, attempts: 0 };
  }
}

function alreadyEnabled(home = os.homedir()) {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const enabled = JSON.parse(raw)?.enabledPlugins;
    return !!(enabled && enabled[ENABLED_KEY]);
  } catch {
    return false; // settings absent/unparseable — treat as not-enabled.
  }
}

function writeMarker(state, home) {
  try {
    const p = markerPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...state, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    console.warn('[seedDevPlugin] could not write marker:', err?.message ?? err);
  }
}

/** Compare dotted numeric versions (pre-release suffixes ignored). <0, 0, >0. */
function compareSemver(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Pure check: is the registered 'session-manager' marketplace source missing on disk or
 * different from `expectedDir`? Not registered at all → false (a deliberate uninstall stays).
 * (Own reader: delegationReadiness's readDevMarketplacePath is not exported.)
 */
function marketplaceIsStale({ homeDir = os.homedir(), expectedDir = bundledMarketplaceDir() } = {}) {
  const m = readJson(path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json'))?.[MARKETPLACE.name];
  const p = m?.source?.path ?? m?.installLocation;
  if (typeof p !== 'string' || !p) return false;
  if (path.resolve(p) !== path.resolve(expectedDir)) return true;
  return !fs.existsSync(p);
}

/** True only when settings.json explicitly sets the plugin to false. */
function deliberatelyDisabled(home) {
  return readJson(path.join(home, '.claude', 'settings.json'))?.enabledPlugins?.[ENABLED_KEY] === false;
}

function bundledVersion() {
  const m = readJson(path.join(__dirname, '..', '..', 'plugins', PLUGIN_SLUG, '.claude-plugin', 'plugin.json'));
  return typeof m?.version === 'string' ? m.version : null;
}

/**
 * Stay-current pass. Update the installed plugin when older than the bundled one.
 * Never throws. Deps injectable for tests.
 */
async function upgradeIfStale({
  logger = console,
  writeLog = () => {},
  home = os.homedir(),
  bundledVersion: bundled = bundledVersion(),
  runUpdate = update,
} = {}) {
  if (process.env.SM_SEED_DEV_PLUGIN_DISABLE === '1') return;
  try {
    const entries = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins?.[ENABLED_KEY];
    const installedVersion = Array.isArray(entries) ? entries[0]?.version : null;
    if (!installedVersion || !bundled) return;                        // not installed / no bundle
    const enabled = readJson(path.join(home, '.claude', 'settings.json'))?.enabledPlugins;
    if (!enabled?.[ENABLED_KEY]) return;                              // deliberate disable stays
    if (compareSemver(installedVersion, bundled) >= 0) return;        // current or newer
    logger.log?.(`[seedDevPlugin] updating ${ENABLED_KEY} ${installedVersion} → ${bundled}`);
    const r = await runUpdate({ slug: PLUGIN_SLUG, marketplaceName: MARKETPLACE.name });
    if (!r?.ok) {
      writeLog({
        scope: 'seed-dev-plugin',
        level: 'error',
        message: 'upgrade failed',
        meta: { exitCode: r?.exitCode, error: r?.error, from: installedVersion, to: bundled },
      });
    }
  } catch (err) {
    writeLog({
      scope: 'seed-dev-plugin',
      level: 'error',
      message: 'upgrade error',
      meta: { error: err?.message ?? String(err) },
    });
  }
}

async function seedDevPlugin({
  logger = console,
  writeLog = () => {},
  home = os.homedir(),
  expectedDir = bundledMarketplaceDir(),
  runInstall = install,
  runUpdate = update,
} = {}) {
  if (process.env.SM_SEED_DEV_PLUGIN_DISABLE === '1') return;
  await upgradeIfStale({ logger, writeLog, home, runUpdate });
  const marker = readMarker(home);
  // Repair: the registered marketplace dir vanished or points at an older package dir.
  const repair = marker.done && !deliberatelyDisabled(home) && marketplaceIsStale({ homeDir: home, expectedDir });
  if (marker.done && !repair) return;            // succeeded before — leave it alone.
  if (!marker.done && marker.attempts >= MAX_ATTEMPTS) return;   // gave up — manual install only.

  try {
    if (!repair && alreadyEnabled(home)) {
      writeMarker({ done: true, attempts: marker.attempts }, home);
      return;
    }
    logger.log?.(`[seedDevPlugin] ${repair ? 're-registering' : 'installing'} bundled session-manager-dev plugin…`);
    const r = await runInstall({ slug: PLUGIN_SLUG, marketplace: MARKETPLACE });
    if (r.ok) {
      logger.log?.('[seedDevPlugin] installed session-manager-dev@session-manager');
      writeMarker({ done: true, attempts: marker.attempts }, home);
    } else {
      // Failure: bump the attempt counter so the next boot can retry (bounded).
      logger.warn?.(`[seedDevPlugin] install failed (exit ${r.exitCode})${r.error ? ` — ${r.error}` : ''}; attempt ${marker.attempts + 1}/${MAX_ATTEMPTS}`);
      writeLog({
        scope: 'seed-dev-plugin',
        level: 'error',
        message: 'install failed',
        meta: { exitCode: r.exitCode, error: r.error, attempt: marker.attempts + 1, maxAttempts: MAX_ATTEMPTS },
      });
      writeMarker({ done: false, attempts: marker.attempts + 1 }, home);
    }
  } catch (err) {
    logger.warn?.('[seedDevPlugin] error:', err?.message ?? err);
    writeLog({
      scope: 'seed-dev-plugin',
      level: 'error',
      message: 'seed error',
      meta: { error: err?.message ?? String(err), attempt: marker.attempts + 1, maxAttempts: MAX_ATTEMPTS },
    });
    writeMarker({ done: false, attempts: marker.attempts + 1 }, home);
  }
}

module.exports = { seedDevPlugin, upgradeIfStale, marketplaceIsStale, compareSemver, markerPath, MAX_ATTEMPTS };
