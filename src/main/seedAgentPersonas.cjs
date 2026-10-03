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
 * 1. UPGRADE PASS (upgradeStalePersonas): compares an installed persona's
 *    `seedVersion` frontmatter stamp (missing counts as 1) against the
 *    bundled file's own stamp. Same or higher stays untouched. Lower checks
 *    the installed file's body against every body this app has ever shipped
 *    for that persona (`lib/shippedPersonaSeeds.cjs`). No match means a
 *    person wrote or edited that file; it is left alone and the skip is
 *    logged. Why: a lower stamp alone does not prove the file is a stale
 *    shipped copy — only a body match does. A match replaces the installed
 *    file with the bundled one. Frontmatter keys the user changed are kept,
 *    including a `model:` line the user removed entirely; keys the user
 *    never touched take the bundled value. Why: an upgrade should not
 *    silently undo a choice the user made in the Agent Library editor. The
 *    body always comes from the bundled file on a match — it is never a
 *    hand edit, by definition. Before any write, the installed file is
 *    backed up to
 *    `~/.claude/session-manager/persona-backups/<name>.<content-hash>.md`,
 *    one file per distinct content. Why that folder: Claude Code loads agent
 *    files from `~/.claude/agents/` recursively, so a backup kept there would
 *    load as a second agent under the same name. Why the hash name: a
 *    failing upgrade retried on the next boot reuses the same backup file
 *    instead of piling up a new one. Runs every call, independent of the
 *    marker file below and of MAX_ATTEMPTS, so a machine that finished
 *    seeding years ago still picks up a persona fix shipped in a later
 *    release.
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
const crypto = require('node:crypto');
const { writeJsonSync, writeTextAtomic, validatePath, validateWrite } = require('./config.cjs');
const { splitFrontmatter } = require('./lib/prdFrontmatter.cjs');
const { SHIPPED_PERSONA_SEEDS } = require('./lib/shippedPersonaSeeds.cjs');

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

/** `\r\n` and lone `\r` become `\n` — every parser in this file reads text through this first, so a CRLF-saved persona file still parses. */
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** sha256 hex of a persona's body only (frontmatter stripped, newlines normalized, trimmed) — the key the upgrade pass matches against `lib/shippedPersonaSeeds.cjs`. */
function personaBodyHash(text) {
  const { body } = splitFrontmatter(normalizeNewlines(text));
  return crypto.createHash('sha256').update(body.trim()).digest('hex');
}

/** A persona file's `seedVersion` frontmatter stamp as a number. Missing, empty, non-integer, or below 1 all count as 1 — the version every file shipped at before this field existed. (An empty `seedVersion:` line parses to `''`; `Number('')` is 0, not 1 — handled explicitly below.) */
function readSeedVersion(text) {
  const raw = splitFrontmatter(normalizeNewlines(text)).fm.seedVersion;
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

/**
 * Whether two frontmatter values for the same `key` are the same choice.
 * Both `undefined` (neither file has the key) counts as same; only one
 * `undefined` never does. `tools`/`tags`/`projects` are comma lists — compare
 * them split on `,`, trimmed, emptied of blank items, and rejoined, so
 * `"a, b"` and `"a,b"` are the same list. Every other key compares as a
 * trimmed string.
 */
function sameFmValue(a, b, key) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (key === 'tools' || key === 'tags' || key === 'projects') {
    const normalizeList = (v) => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0).join(', ');
    return normalizeList(a) === normalizeList(b);
  }
  return a.trim() === b.trim();
}

/** Where a stale persona's pre-upgrade content is kept — never inside `~/.claude/agents`, so Claude Code (which loads every file there recursively) never loads a backup as a second agent. */
function personaBackupsDir() {
  return path.join(os.homedir(), '.claude', 'session-manager', 'persona-backups');
}

/** Content-addressed backup path for `name`'s installed file: the first 12 hex chars of the sha256 of its exact (pre-normalization) bytes. Same content always maps to the same path, so retrying a failing upgrade on every boot can never pile up backups. */
function backupPathFor(name, installedText) {
  const sha12 = crypto.createHash('sha256').update(installedText).digest('hex').slice(0, 12);
  return path.join(personaBackupsDir(), `${name}.${sha12}.md`);
}

/** `text`'s frontmatter block split into individual lines, fences excluded — `[]` when `text` has no parseable frontmatter fence. */
function frontmatterLines(text) {
  if (!text.startsWith('---\n')) return [];
  const end = text.indexOf('\n---', 4);
  if (end === -1) return [];
  return text.slice(4, end).split('\n');
}

/** The frontmatter key a single frontmatter line defines (same key shape `splitFrontmatter` matches), or `null` for a blank/comment/malformed line. */
function keyOfLine(line) {
  const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)\s*$/);
  return m ? m[1] : null;
}

/**
 * The text to write when upgrading an installed persona to the bundled one,
 * given `matches` — the non-empty list of `shippedPersonaSeeds.cjs` entries
 * whose body matches the installed file (the caller only calls this once it
 * has proven that). The body always comes from `bundledText`, untouched —
 * on a match, by definition, nothing about the body is a hand edit.
 *
 * Per frontmatter key, except `name` and `seedVersion` (never diffed):
 * the key is "user-changed" when NO entry in `matches` has the same value
 * (`sameFmValue`) for it as the installed file — i.e. the installed value
 * cannot be explained as some version of the shipped default, so it must be
 * a deliberate choice.
 *   - Not user-changed: the bundled line wins (or bundled absence wins).
 *   - User-changed, installed file still has the key: the installed file's
 *     OWN line for that key is used verbatim — never rebuilt from the parsed
 *     value, so a value containing regex-replacement-special text like `$&`
 *     or `$1` is reproduced exactly. This never calls `String.prototype.replace`
 *     with a replacement string built from file content.
 *   - User-changed, installed file lacks the key: the key is dropped — the
 *     user's removal (meaning "inherit the app default") survives.
 * Output always uses `\n` line endings, regardless of either input's.
 */
function buildUpgradedPersona(bundledText, installedText, matches) {
  const normBundled = normalizeNewlines(bundledText);
  if (matches.length === 0 || !normBundled.startsWith('---\n')) return bundledText; // should never happen — caller only calls this on a proven match; defensive only
  const normInstalled = normalizeNewlines(installedText);

  const { fm: bundledFm, body } = splitFrontmatter(normBundled);
  const { fm: installedFm } = splitFrontmatter(normInstalled);

  const installedLineByKey = new Map();
  for (const line of frontmatterLines(normInstalled)) {
    const key = keyOfLine(line);
    if (key) installedLineByKey.set(key, line);
  }

  const allKeys = new Set([...Object.keys(bundledFm), ...Object.keys(installedFm)]);
  allKeys.delete('name');
  allKeys.delete('seedVersion');

  const userChanged = new Set();
  for (const key of allKeys) {
    if (!matches.some((entry) => sameFmValue(entry.fm[key], installedFm[key], key))) userChanged.add(key);
  }

  const nextLines = [];
  const emitted = new Set();
  for (const line of frontmatterLines(normBundled)) {
    const key = keyOfLine(line);
    if (!key || !userChanged.has(key)) {
      nextLines.push(line); // not user-changed (or not a key line at all) — bundled wins verbatim
      if (key) emitted.add(key);
      continue;
    }
    const installedLine = installedLineByKey.get(key);
    if (installedLine !== undefined) nextLines.push(installedLine); // user-changed, installed kept it — use the user's own line
    emitted.add(key); // else: user removed this key — drop the bundled line entirely
  }
  for (const key of userChanged) {
    if (emitted.has(key)) continue; // a user-changed key the bundled file never had — append it
    const installedLine = installedLineByKey.get(key);
    if (installedLine !== undefined) nextLines.push(installedLine);
  }

  return `---\n${nextLines.join('\n')}\n---\n${body}`;
}

/**
 * Replaces a stale installed persona with the current bundled one, once per
 * boot, for every name in `PERSONAS` whose installed file is both PRESENT
 * and behind the bundled `seedVersion` AND whose body matches a body this
 * app has shipped before (`shippedSeeds`, normally `lib/shippedPersonaSeeds.cjs`
 * — injectable so tests can supply a fake list). See this file's header for
 * the full rule, and `buildUpgradedPersona` for how frontmatter keys merge.
 * Never overwrites a same-or-newer installed file, or one whose body never
 * shipped from this app; never throws (a per-persona failure is logged and
 * skipped, the loop continues). Independent of the marker/MAX_ATTEMPTS
 * machinery the first-seed pass below uses — the caller gates both passes
 * on the kill switch only.
 */
async function upgradeStalePersonas({ logger = console, writeLog = () => {}, shippedSeeds = SHIPPED_PERSONA_SEEDS } = {}) {
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

      const installedHash = personaBodyHash(installedText);
      const matches = (shippedSeeds[name] ?? []).filter((entry) => entry.bodySha256 === installedHash);
      if (matches.length === 0) {
        // Lower seedVersion alone doesn't prove this is a stale shipped copy — only a body match does.
        // No match means a person wrote or hand-edited this file; leave it alone.
        logger.log?.(`[seedAgentPersonas] kept ${name}.md: its text differs from every shipped version, so the seedVersion ${bundledVersion} upgrade was skipped.`);
        writeLog({
          scope: 'seed-agent-personas',
          level: 'info',
          message: 'persona upgrade skipped: local edits',
          meta: { name, installedVersion, bundledVersion },
        });
        continue;
      }

      // Confirm the write can succeed before any write happens — a doomed
      // write (e.g. ~/.claude/agents symlinked outside the allowed roots)
      // must never leave an orphan backup behind. Throws straight into the
      // catch below on failure.
      validateWrite(validatePath(destPath));

      const backupPath = backupPathFor(name, installedText);
      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        await writeTextAtomic(backupPath, installedText);
      } // same content already backed up by an earlier attempt — never write a second copy

      const nextText = buildUpgradedPersona(bundledText, installedText, matches);
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

async function seedAgentPersonas({ logger = console, writeLog = () => {}, shippedSeeds = SHIPPED_PERSONA_SEEDS } = {}) {
  if (process.env.SM_SEED_AGENT_PERSONAS_DISABLE === '1') return;

  // Every boot, regardless of marker state — see this file's header.
  await upgradeStalePersonas({ logger, writeLog, shippedSeeds });

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

module.exports = {
  seedAgentPersonas,
  upgradeStalePersonas,
  buildUpgradedPersona,
  personaBodyHash,
  readSeedVersion,
  normalizeNewlines,
  sameFmValue,
  markerPath,
  MAX_ATTEMPTS,
  PERSONAS,
};
