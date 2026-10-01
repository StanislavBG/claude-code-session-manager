/**
 * First-boot (and stay-current) seeder for the bundled Agent personas.
 *
 * On a fresh install `~/.claude/agents/` is empty, so the Agent Library has
 * nothing to offer — no persona to select for an Epic's Actor. This seeder
 * copies the personas bundled at `src/seed/agents/*.md` into `~/.claude/agents/`,
 * one file per persona.
 *
 * Two independent passes run on every call, in this order:
 *
 * 1. UPGRADE PASS (upgradeStalePersonas): for a persona whose installed file
 *    already exists, compares its `seedVersion` frontmatter stamp (missing =
 *    1) against the bundled file's own stamp. Lower → the installed file is
 *    backed up to `<destAgentsDir()>/.backup/<name>.<timestamp>.md`, then
 *    replaced by the bundled content with the installed `model:`/`effort:`
 *    lines carried over (a hand-edited body or any other frontmatter key is
 *    NOT preserved — this is a stamped-version upgrade, not a merge). Same or
 *    higher → left untouched. Runs every call, independent of the marker file
 *    below and of MAX_ATTEMPTS, so a machine that finished seeding years ago
 *    still picks up a persona fix shipped in a later release.
 * 2. FIRST-SEED PASS (the rest of this file, unchanged in spirit): NEVER
 *    overwrites a file that doesn't yet carry a bundled persona under that
 *    name — hand-edited or user-authored personas at a name outside
 *    `PERSONAS` are untouched, and even a name inside `PERSONAS` is only
 *    copied the FIRST time, never again once `seeded` records it. The two
 *    passes don't overlap: the first-seed pass only ever touches a MISSING
 *    file, the upgrade pass only ever touches a file that already EXISTS.
 *
 * Idempotent the same way as seedDevPlugin.cjs, but per-persona rather than
 * whole-run: the marker (`~/.claude/session-manager/.agent-personas-seeded`)
 * records the SET of persona names already delivered (`seeded: string[]`),
 * not just a single `done` flag. Every boot, any name in `PERSONAS` not yet in
 * that set gets copied (subject to the first-seed pass's never-overwrite
 * guard) and added to the set. This is what lets a persona added to
 * `PERSONAS` in a later release reach a machine that already booted
 * successfully long ago — a plain one-shot `done:true` would silently never
 * re-run and that persona would never arrive. A name already in `seeded` is
 * skipped even if its on-disk file was later deleted by hand — deleting a
 * seeded persona is read as an intentional opt-out, not a request to reseed
 * it.
 *
 * A whole-run FAILURE in the first-seed pass (thrown before any per-persona
 * copy could be attempted, e.g. the bundled source dir is missing) only
 * bumps an attempt counter and retries on the next few boots (bounded by
 * MAX_ATTEMPTS); once attempts are exhausted the seeder gives up
 * permanently and the machine is left exactly where it was — whatever subset
 * of `PERSONAS` it had already reached stays in `seeded`, nothing is retried
 * automatically, and delivering the rest is a manual copy. This is a
 * deliberate choice: an install that has already failed MAX_ATTEMPTS times
 * has something wrong with it (e.g. a read-only home dir) that retrying
 * forever would not fix, and endlessly retrying on every boot would cost a
 * syscall per persona per boot for no benefit. The upgrade pass has no such
 * limit — a per-persona failure there is logged and skipped, never counted
 * against this budget.
 *
 * Fire-and-forget: called post-window from index.cjs. Errors are logged,
 * never thrown. Kill-switch: SM_SEED_AGENT_PERSONAS_DISABLE=1 (gates both
 * passes).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeJsonSync, writeTextAtomic } = require('./config.cjs');
const { splitFrontmatter } = require('./lib/prdFrontmatter.cjs');

const PERSONAS = ['architect', 'dev-lead', 'project-home-builder', 'validator'];
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

/** A persona file's `seedVersion` frontmatter stamp as a number. Missing or unparseable counts as 1 — the version every file shipped at before this field existed. */
function readSeedVersion(text) {
  const n = Number(splitFrontmatter(text).fm.seedVersion);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Returns `bundledText` with its frontmatter `model:`/`effort:` lines
 * replaced by the matching value from `installedFm` (the installed file's
 * own parsed frontmatter) — the user's choice on an upgraded file, not the
 * bundled default. A key absent from `installedFm` leaves the bundled line
 * untouched; a key present in `installedFm` but absent from the bundled
 * frontmatter is appended rather than dropped, so an installed `effort:`
 * override survives even when the bundled persona ships with no `effort:`
 * line at all. Only the frontmatter block is rewritten — never the body —
 * so a run contract that happens to say "model" in prose is never touched.
 * Returns `bundledText` unchanged if it has no parseable frontmatter fence
 * (should never happen for a bundled file; defensive only).
 */
function withCarriedOverModelAndEffort(bundledText, installedFm) {
  if (!bundledText.startsWith('---\n')) return bundledText;
  const closeIdx = bundledText.indexOf('\n---', 4);
  if (closeIdx === -1) return bundledText;
  const fmBlock = bundledText.slice(0, closeIdx); // '---\nkey: val\n...' — no trailing newline, no closing fence
  const rest = bundledText.slice(closeIdx); // '\n---\n<body>'
  let nextFmBlock = fmBlock;
  for (const key of ['model', 'effort']) {
    const value = installedFm[key];
    if (value === undefined) continue; // installed file has no such line: keep the bundled one
    const lineRe = new RegExp(`^${key}:.*$`, 'm');
    if (lineRe.test(nextFmBlock)) {
      nextFmBlock = nextFmBlock.replace(lineRe, `${key}: ${value}`);
    } else {
      nextFmBlock += `\n${key}: ${value}`; // bundled file never had this key — append so the user's choice survives
    }
  }
  return nextFmBlock + rest;
}

/** File-safe ISO timestamp for a backup filename — no `:` or `.` (both illegal/awkward in a filename on some filesystems). */
function fileSafeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Replaces a stale installed persona with the current bundled one, once per
 * boot, for every name in `PERSONAS` whose installed file is both PRESENT
 * and behind the bundled `seedVersion` — see this file's header for the full
 * rule. Backs up the old file first; never overwrites a same-or-newer
 * installed file; never throws (a per-persona failure is logged and
 * skipped, the loop continues). Independent of the marker/MAX_ATTEMPTS
 * machinery the first-seed pass below uses — the caller gates both passes
 * on the kill switch only.
 */
async function upgradeStalePersonas({ logger = console, writeLog = () => {} } = {}) {
  const srcDir = bundledSourceDir();
  const destDir = destAgentsDir();
  for (const name of PERSONAS) {
    const destPath = path.join(destDir, `${name}.md`);
    if (!fs.existsSync(destPath)) continue; // nothing installed yet — the first-seed pass below owns this name
    try {
      const bundledText = fs.readFileSync(path.join(srcDir, `${name}.md`), 'utf8');
      const installedText = fs.readFileSync(destPath, 'utf8');
      const bundledVersion = readSeedVersion(bundledText);
      const installedVersion = readSeedVersion(installedText);
      if (installedVersion >= bundledVersion) continue; // same or newer — never touched

      const backupDir = path.join(destDir, '.backup');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `${name}.${fileSafeTimestamp()}.md`);
      fs.copyFileSync(destPath, backupPath);

      const installedFm = splitFrontmatter(installedText).fm;
      const nextText = withCarriedOverModelAndEffort(bundledText, installedFm);
      await writeTextAtomic(destPath, nextText);
      logger.log?.(`[seedAgentPersonas] upgraded ${name}.md to seedVersion ${bundledVersion}. Backup saved at ${backupPath}.`);
    } catch (err) {
      logger.warn?.('[seedAgentPersonas] upgrade error for', name, ':', err?.message ?? err);
      writeLog({
        scope: 'seed-agent-personas',
        level: 'error',
        message: 'persona upgrade error',
        meta: { name, error: err?.message ?? String(err) },
      });
      // Never throws — a stale persona that fails to upgrade just stays stale; the next boot tries again.
    }
  }
}

async function seedAgentPersonas({ logger = console, writeLog = () => {} } = {}) {
  if (process.env.SM_SEED_AGENT_PERSONAS_DISABLE === '1') return;

  // Every boot, regardless of marker state — see this file's header.
  await upgradeStalePersonas({ logger, writeLog });

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

module.exports = { seedAgentPersonas, markerPath, MAX_ATTEMPTS, PERSONAS };
