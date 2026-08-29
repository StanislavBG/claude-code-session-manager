/**
 * First-boot seeder for the bundled `session-manager-dev` plugin.
 *
 * The plugin (its 10 dev skills) ships inside the npx distribution. To make it
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
 * Fire-and-forget: called post-window from index.cjs. Errors are logged, never
 * thrown. Kill-switch: SM_SEED_DEV_PLUGIN_DISABLE=1.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { install } = require('./pluginInstall.cjs');

const PLUGIN_SLUG = 'session-manager-dev';
const MARKETPLACE = { add: 'bundled', name: 'session-manager' };
const ENABLED_KEY = `${PLUGIN_SLUG}@${MARKETPLACE.name}`;
const MAX_ATTEMPTS = 3; // give a transient first-boot failure a few chances

function markerPath() {
  return path.join(os.homedir(), '.claude', 'session-manager', '.dev-plugin-seeded');
}

/** Read the marker → { done:boolean, attempts:number }. Absent = fresh. */
function readMarker() {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf8').trim();
    const m = JSON.parse(raw);
    return { done: !!m.done, attempts: Number(m.attempts) || 0 };
  } catch {
    return { done: false, attempts: 0 };
  }
}

function alreadyEnabled() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const enabled = JSON.parse(raw)?.enabledPlugins;
    return !!(enabled && enabled[ENABLED_KEY]);
  } catch {
    return false; // settings absent/unparseable — treat as not-enabled.
  }
}

function writeMarker(state) {
  try {
    const p = markerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...state, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    console.warn('[seedDevPlugin] could not write marker:', err?.message ?? err);
  }
}

async function seedDevPlugin({ logger = console, writeLog = () => {} } = {}) {
  if (process.env.SM_SEED_DEV_PLUGIN_DISABLE === '1') return;
  const marker = readMarker();
  if (marker.done) return;                       // succeeded before — leave it alone.
  if (marker.attempts >= MAX_ATTEMPTS) return;   // gave up — manual install only.

  try {
    if (alreadyEnabled()) {
      writeMarker({ done: true, attempts: marker.attempts });
      return;
    }
    logger.log?.('[seedDevPlugin] installing bundled session-manager-dev plugin…');
    const r = await install({ slug: PLUGIN_SLUG, marketplace: MARKETPLACE });
    if (r.ok) {
      logger.log?.('[seedDevPlugin] installed session-manager-dev@session-manager');
      writeMarker({ done: true, attempts: marker.attempts });
    } else {
      // Failure: bump the attempt counter so the next boot can retry (bounded).
      logger.warn?.(`[seedDevPlugin] install failed (exit ${r.exitCode})${r.error ? ` — ${r.error}` : ''}; attempt ${marker.attempts + 1}/${MAX_ATTEMPTS}`);
      writeLog({
        scope: 'seed-dev-plugin',
        level: 'error',
        message: 'install failed',
        meta: { exitCode: r.exitCode, error: r.error, attempt: marker.attempts + 1, maxAttempts: MAX_ATTEMPTS },
      });
      writeMarker({ done: false, attempts: marker.attempts + 1 });
    }
  } catch (err) {
    logger.warn?.('[seedDevPlugin] error:', err?.message ?? err);
    writeLog({
      scope: 'seed-dev-plugin',
      level: 'error',
      message: 'seed error',
      meta: { error: err?.message ?? String(err), attempt: marker.attempts + 1, maxAttempts: MAX_ATTEMPTS },
    });
    writeMarker({ done: false, attempts: marker.attempts + 1 });
  }
}

module.exports = { seedDevPlugin, markerPath, MAX_ATTEMPTS };
