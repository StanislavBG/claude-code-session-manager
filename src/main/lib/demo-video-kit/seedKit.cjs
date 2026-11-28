/**
 * Boot-time seeder for the demo-video kit.
 *
 * Copies the kit's runnable modules to a stable per-machine folder,
 * `~/.claude/session-manager/demo-video-kit/`, so the demo-video persona can
 * `require()` them from any project's cwd (the app's own install path changes
 * with every npx hash dir). A `KIT_VERSION` stamp file records which kit
 * version is installed; files are overwritten only when the stamp differs, so
 * a normal boot is one small read. Bump KIT_VERSION whenever any kit file
 * changes. KIT_DIGEST pins the kit files' bytes; seedKit.test.cjs fails when
 * the digest drifts, so a kit edit cannot ship without a bump.
 *
 * Fire-and-forget from index.cjs: errors are logged, never thrown.
 * Kill-switch: SM_SEED_DEMO_VIDEO_KIT_DISABLE=1.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { schedulerHome } = require('../scheduler/schedulerPaths.cjs');
const { writeTextAtomic } = require('../util/atomicFs.cjs');

const KIT_VERSION = '47';
// sha256 of kitDigest(__dirname). Update together with a KIT_VERSION bump.
const KIT_DIGEST = 'fbd7c7f8fa0e2bf006c0f3f6a0f3d91ca946a3666b42a77448f62f8f544a9300';
const KIT_FILES = Object.freeze(['checks.cjs', 'sound.cjs', 'capture.cjs', 'frames.cjs', 'character.cjs', 'playwrightLoader.cjs', 'export.cjs', 'kind-tiktok.md', 'kind-marketing.md', 'cast.md', 'project-home-html.md', 'resumableRun.cjs', 'voiceLibrary.cjs', 'voiceLane.cjs', 'kokoroSay.cjs', 'projectSounds.cjs', 'standalone.cjs']);
const STAMP_FILE = 'KIT_VERSION';

/** The single list of kit files (paths relative to the kit dir) the seeder copies. */
function kitFiles() {
  return [...KIT_FILES];
}

/** Pure: sha256 hex over kitFiles() sorted by relative path, each as path + NUL + bytes. */
function kitDigest(srcDir) {
  const h = crypto.createHash('sha256');
  for (const f of kitFiles().sort()) {
    h.update(f);
    h.update(Buffer.from([0]));
    h.update(fs.readFileSync(path.join(srcDir, f)));
  }
  return h.digest('hex');
}

function kitDestDir() {
  return path.join(schedulerHome(), 'demo-video-kit');
}

async function seedDemoVideoKit({ logger = console, writeLog = () => {}, destDir = kitDestDir(), srcDir = __dirname, kitVersion = KIT_VERSION } = {}) {
  if (process.env.SM_SEED_DEMO_VIDEO_KIT_DISABLE === '1') return { seeded: false, reason: 'disabled' };
  try {
    const stampPath = path.join(destDir, STAMP_FILE);
    let installed = null;
    try { installed = fs.readFileSync(stampPath, 'utf8').trim(); } catch { /* no stamp yet */ }
    const files = kitFiles();
    const filesPresent = files.every((f) => fs.existsSync(path.join(destDir, f)));
    if (installed === String(kitVersion) && filesPresent) return { seeded: false, reason: 'current' };

    fs.mkdirSync(destDir, { recursive: true });
    for (const f of files) {
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

module.exports = { seedDemoVideoKit, kitDestDir, kitFiles, kitDigest, KIT_VERSION, KIT_DIGEST, KIT_FILES };
