/**
 * First-boot (and stay-current) seeder for the bundled Agent personas.
 *
 * On a fresh install `~/.claude/agents/` is empty, so the Agent Library has
 * nothing to offer — no persona to select for an Epic's Actor. This seeder
 * copies the personas bundled at `src/seed/agents/*.md` into `~/.claude/agents/`,
 * one file per persona, and NEVER overwrites a file that already exists there
 * (hand-edited or user-authored personas win).
 *
 * Idempotent the same way as seedDevPlugin.cjs, but per-persona rather than
 * whole-run: the marker (`~/.claude/session-manager/.agent-personas-seeded`)
 * records the SET of persona names already delivered (`seeded: string[]`),
 * not just a single `done` flag. Every boot, any name in `PERSONAS` not yet in
 * that set gets copied (subject to the same never-overwrite guard) and added
 * to the set. This is what lets a persona added to `PERSONAS` in a later
 * release reach a machine that already booted successfully long ago — a
 * plain one-shot `done:true` would silently never re-run and that persona
 * would never arrive. A name already in `seeded` is skipped even if its
 * on-disk file was later deleted by hand — deleting a seeded persona is
 * read as an intentional opt-out, not a request to reseed it.
 *
 * A whole-run FAILURE (thrown before any per-persona copy could be attempted,
 * e.g. the bundled source dir is missing) only bumps an attempt counter and
 * retries on the next few boots (bounded by MAX_ATTEMPTS); once attempts are
 * exhausted the seeder gives up permanently and the machine is left exactly
 * where it was — whatever subset of `PERSONAS` it had already reached stays
 * in `seeded`, nothing is retried automatically, and delivering the rest is a
 * manual copy. This is a deliberate choice: an install that has already
 * failed MAX_ATTEMPTS times has something wrong with it (e.g. a read-only
 * home dir) that retrying forever would not fix, and endlessly retrying on
 * every boot would cost a syscall per persona per boot for no benefit.
 *
 * Fire-and-forget: called post-window from index.cjs. Errors are logged,
 * never thrown. Kill-switch: SM_SEED_AGENT_PERSONAS_DISABLE=1.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeJsonSync } = require('./config.cjs');

const PERSONAS = ['architect', 'dev-lead', 'project-home-builder'];
// What `{ done: true }` (the pre-seeded-set marker format) meant: only these two personas existed
// in PERSONAS at the time. Fixed, not derived from the current PERSONAS array above — otherwise
// every future persona added to PERSONAS would retroactively count as already delivered to a
// machine that finished its run under the old format, and would silently never seed there.
const LEGACY_DONE_PERSONAS = ['architect', 'dev-lead'];
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

/**
 * Read the marker → { seeded:string[], attempts:number }. Absent/corrupt/
 * legacy = treated as fresh (a corrupt marker must never block seeding — a
 * try/catch here is load-bearing, not defensive filler).
 *
 * Back-compat: an old-format marker (`{ done: true }`, no `seeded` array)
 * reads as `seeded: LEGACY_DONE_PERSONAS` (the fixed set that existed when
 * that format was the only one) — a machine that already completed a full
 * run under the old scheme picks up only personas added to `PERSONAS` since,
 * not a spurious reseed of architect/dev-lead.
 */
function readMarker() {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf8').trim();
    const m = JSON.parse(raw);
    if (Array.isArray(m.seeded)) {
      return { seeded: m.seeded.filter((n) => typeof n === 'string'), attempts: Number(m.attempts) || 0 };
    }
    if (m.done) {
      return { seeded: [...LEGACY_DONE_PERSONAS], attempts: Number(m.attempts) || 0 };
    }
    return { seeded: [], attempts: Number(m.attempts) || 0 };
  } catch {
    return { seeded: [], attempts: 0 };
  }
}

function writeMarker(state) {
  try {
    writeJsonSync(markerPath(), { ...state, ts: new Date().toISOString() });
  } catch (err) {
    console.warn('[seedAgentPersonas] could not write marker:', err?.message ?? err);
  }
}

async function seedAgentPersonas({ logger = console, writeLog = () => {} } = {}) {
  if (process.env.SM_SEED_AGENT_PERSONAS_DISABLE === '1') return;
  const marker = readMarker();
  const pending = PERSONAS.filter((name) => !marker.seeded.includes(name));
  if (pending.length === 0) return;              // every known persona already delivered.
  if (marker.attempts >= MAX_ATTEMPTS) return;   // gave up — manual copy only.

  const seeded = [...marker.seeded];
  try {
    const srcDir = bundledSourceDir();
    const destDir = destAgentsDir();
    fs.mkdirSync(destDir, { recursive: true });

    for (const name of pending) {
      const src = path.join(srcDir, `${name}.md`);
      const dest = path.join(destDir, `${name}.md`);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        logger.log?.(`[seedAgentPersonas] seeded ${name}.md`);
      }
      seeded.push(name); // never overwrite an existing persona, but count it delivered either way
    }

    writeMarker({ seeded, attempts: marker.attempts });
  } catch (err) {
    logger.warn?.('[seedAgentPersonas] error:', err?.message ?? err);
    writeLog({
      scope: 'seed-agent-personas',
      level: 'error',
      message: 'seed error',
      meta: { error: err?.message ?? String(err), attempt: marker.attempts + 1, maxAttempts: MAX_ATTEMPTS },
    });
    writeMarker({ seeded, attempts: marker.attempts + 1 });
  }
}

module.exports = { seedAgentPersonas, markerPath, MAX_ATTEMPTS };
