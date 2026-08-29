/**
 * First-boot seeder for the bundled Agent personas (Architect, Dev Lead).
 *
 * On a fresh install `~/.claude/agents/` is empty, so the Agent Library has
 * nothing to offer — no persona to select for an Epic's Actor. This seeder
 * copies the personas bundled at `src/seed/agents/*.md` into `~/.claude/agents/`
 * on first boot, one file per persona, and NEVER overwrites a file that
 * already exists there (hand-edited or user-authored personas win).
 *
 * Idempotent the same way as seedDevPlugin.cjs:
 *   1. A marker file (`~/.claude/session-manager/.agent-personas-seeded`)
 *      records seed state. Once seeding SUCCEEDS we write `done` and never
 *      touch it again. A FAILED attempt only bumps an attempt counter and
 *      retries on the next few boots (bounded by MAX_ATTEMPTS), so a
 *      transient first-boot failure doesn't permanently skip the personas.
 *
 * Fire-and-forget: called post-window from index.cjs. Errors are logged,
 * never thrown. Kill-switch: SM_SEED_AGENT_PERSONAS_DISABLE=1.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PERSONAS = ['architect', 'dev-lead'];
const MAX_ATTEMPTS = 3; // give a transient first-boot failure a few chances

function bundledSourceDir() {
  return path.join(__dirname, '..', 'seed', 'agents');
}

function destAgentsDir() {
  return path.join(os.homedir(), '.claude', 'agents');
}

function markerPath() {
  return path.join(os.homedir(), '.claude', 'session-manager', '.agent-personas-seeded');
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

function writeMarker(state) {
  try {
    const p = markerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...state, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    console.warn('[seedAgentPersonas] could not write marker:', err?.message ?? err);
  }
}

async function seedAgentPersonas({ logger = console } = {}) {
  if (process.env.SM_SEED_AGENT_PERSONAS_DISABLE === '1') return;
  const marker = readMarker();
  if (marker.done) return;                       // succeeded before — leave it alone.
  if (marker.attempts >= MAX_ATTEMPTS) return;   // gave up — manual copy only.

  try {
    const srcDir = bundledSourceDir();
    const destDir = destAgentsDir();
    fs.mkdirSync(destDir, { recursive: true });

    for (const name of PERSONAS) {
      const src = path.join(srcDir, `${name}.md`);
      const dest = path.join(destDir, `${name}.md`);
      if (fs.existsSync(dest)) continue; // never overwrite an existing persona
      fs.copyFileSync(src, dest);
      logger.log?.(`[seedAgentPersonas] seeded ${name}.md`);
    }

    writeMarker({ done: true, attempts: marker.attempts });
  } catch (err) {
    logger.warn?.('[seedAgentPersonas] error:', err?.message ?? err);
    writeMarker({ done: false, attempts: marker.attempts + 1 });
  }
}

module.exports = { seedAgentPersonas };
