/**
 * Boot-time seeder for the demo-video kit.
 *
 * Copies the kit's runnable modules to a stable per-machine folder,
 * `~/.claude/session-manager/demo-video-kit/`, so the demo-video persona can
 * `require()` them from any project's cwd (the app's own install path changes
 * with every npx hash dir). A `KIT_VERSION` stamp file records which kit
 * version is installed; files are overwritten only when the stamp differs, so
 * a normal boot is one small read. Bump KIT_VERSION whenever any kit file
 * changes behaviour.
 *
 * Fire-and-forget from index.cjs: errors are logged, never thrown.
 * Kill-switch: SM_SEED_DEMO_VIDEO_KIT_DISABLE=1.
 */
const fs = require('node:fs');
const path = require('node:path');
const { schedulerHome } = require('../scheduler/schedulerPaths.cjs');
const { writeTextAtomic } = require('../util/atomicFs.cjs');

const KIT_VERSION = '1';
const KIT_FILES = ['checks.cjs', 'sound.cjs', 'capture.cjs', 'frames.cjs', 'character.cjs'];
const STAMP_FILE = 'KIT_VERSION';

function kitDestDir() {
  return path.join(schedulerHome(), 'demo-video-kit');
}

async function seedDemoVideoKit({ logger = console, writeLog = () => {}, destDir = kitDestDir(), srcDir = __dirname, kitVersion = KIT_VERSION } = {}) {
  if (process.env.SM_SEED_DEMO_VIDEO_KIT_DISABLE === '1') return { seeded: false, reason: 'disabled' };
  try {
    const stampPath = path.join(destDir, STAMP_FILE);
    let installed = null;
    try { installed = fs.readFileSync(stampPath, 'utf8').trim(); } catch { /* no stamp yet */ }
    const filesPresent = KIT_FILES.every((f) => fs.existsSync(path.join(destDir, f)));
    if (installed === String(kitVersion) && filesPresent) return { seeded: false, reason: 'current' };

    fs.mkdirSync(destDir, { recursive: true });
    for (const f of KIT_FILES) {
      await writeTextAtomic(path.join(destDir, f), fs.readFileSync(path.join(srcDir, f), 'utf8'));
    }
    // Stamp last: a crash mid-copy leaves the old/no stamp, so the next boot retries.
    await writeTextAtomic(stampPath, `${kitVersion}\n`);
    logger.log?.(`[seedDemoVideoKit] installed kit v${kitVersion} at ${destDir}`);
    return { seeded: true, reason: installed === null ? 'fresh' : 'updated' };
  } catch (err) {
    logger.warn?.('[seedDemoVideoKit] error:', err?.message ?? err);
    writeLog({ scope: 'seed-demo-video-kit', level: 'error', message: 'seed error', meta: { error: err?.message ?? String(err) } });
    return { seeded: false, reason: 'error' };
  }
}

module.exports = { seedDemoVideoKit, kitDestDir, KIT_VERSION, KIT_FILES };
