'use strict';

// watchdogHelpers.cjs — pure helpers for scheduler-watchdog.cjs (no side effects).
// Testable without spawning the watchdog entry script.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activeProjectCwds } = require('./activeSessions.cjs');

// Mirrors scheduler.cjs:215 (single source of truth there; kept in sync here).
const DEFAULT_HEARTBEAT_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log',
);

// The in-app heartbeat ticks every 60 s; 3 missed ticks = stale.
const DEFAULT_MAX_AGE_MS = 180_000;

/** Local-TZ 'YYYY-MM-DD' for `d` (default now). Single source of truth for
 *  the watchdog's notion of "today" — used for both the log filename and the
 *  history-rollup once-per-day gate. */
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Tail bytes to read — enough to hold several JSON heartbeat lines without
// loading a potentially 1 MB file. O(1) in file size.
const TAIL_BYTES = 4096;

/**
 * readLastHeartbeat(heartbeatPath?) → object | null
 *
 * Reads the last ~4 KB of the heartbeat log, reverse-scans for the last
 * non-empty line, and returns the full parsed JSON object.
 * Returns null on missing / empty / unparseable file.
 *
 * Single source of truth for the file-read + reverse-scan logic; used by
 * readLastHeartbeatTs() and heartbeatFresh().
 */
function readLastHeartbeat(heartbeatPath = DEFAULT_HEARTBEAT_PATH) {
  let buf;
  try {
    const stat = fs.statSync(heartbeatPath);
    const size = stat.size;
    if (size === 0) return null;

    const readSize = Math.min(TAIL_BYTES, size);
    const fd = fs.openSync(heartbeatPath, 'r');
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, size - readSize);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = buf.toString('utf8').split('\n');
  // Walk lines in reverse to find last non-empty parseable one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * readLastHeartbeatTs(heartbeatPath?) → number | null
 *
 * Returns the `ts` field (epoch ms) from the last heartbeat entry.
 * Returns null on missing / empty / unparseable file or missing ts field.
 */
function readLastHeartbeatTs(heartbeatPath = DEFAULT_HEARTBEAT_PATH) {
  const entry = readLastHeartbeat(heartbeatPath);
  return (entry !== null && typeof entry.ts === 'number') ? entry.ts : null;
}

/**
 * heartbeatFresh(heartbeatPath?, maxAgeMs?) → boolean
 *
 * Returns true iff the last heartbeat ts is within maxAgeMs of `now`.
 * Missing / empty / unparseable file → false.
 */
function heartbeatFresh(heartbeatPath = DEFAULT_HEARTBEAT_PATH, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const ts = readLastHeartbeatTs(heartbeatPath);
  if (ts === null) return false;
  return (Date.now() - ts) < maxAgeMs;
}

// Default paths — callers can override via opts for testing.
const DEFAULT_QUEUE_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'queue.json',
);
const DEFAULT_PRDS_DIR = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'prds',
);
const PLUGIN_CACHE_ROOT = path.join(
  os.homedir(), '.claude', 'plugins', 'cache', 'session-manager', 'session-manager-dev',
);

/**
 * compareVersionsDesc(a, b) → number
 *
 * Numeric per-segment version compare (descending) for plugin-cache version
 * dirs like "0.1.0" / "0.2.0" / "0.10.0". Plain lexicographic sort is wrong
 * here — "0.10.0" < "0.2.0" as strings even though 10 > 2 numerically. Falls
 * back to a string compare for any non-numeric segment (e.g. a stray dir name
 * that isn't a version) so listSkillCandidates never throws on garbage input.
 */
function compareVersionsDesc(a, b) {
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const an = Number(as[i]);
    const bn = Number(bs[i]);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return bn - an;
    } else if (as[i] !== bs[i]) {
      return (as[i] ?? '') < (bs[i] ?? '') ? 1 : -1;
    }
  }
  return 0;
}

/**
 * listSkillCandidates(cwd, skillName, fileName, pluginCacheRoot?) → string[]
 *
 * Ordered candidate paths for an inlined skill/standards file, most-specific
 * first — the process-feedback SKILL.md and develop standards.md moved out of
 * the legacy ~/.claude/skills/ location into the session-manager-dev plugin:
 *
 *   1. <cwd>/plugins/session-manager-dev/skills/<skillName>/<fileName>  — repo-local
 *      copy, correct when the swept project vendors the plugin (e.g. session-manager itself).
 *   2. <pluginCacheRoot>/<newest-version>/skills/<skillName>/<fileName> — the installed
 *      plugin cache (default ~/.claude/plugins/cache/session-manager/session-manager-dev).
 *      Enumerates every version dir present, newest (lexicographically-highest) first.
 *   3. ~/.claude/skills/<skillName>/<fileName> — legacy location, kept last so an
 *      old install still works.
 *
 * pluginCacheRoot is overridable for tests; defaults to the real plugin cache.
 */
function listSkillCandidates(cwd, skillName, fileName, pluginCacheRoot = PLUGIN_CACHE_ROOT) {
  const candidates = [
    path.join(cwd, 'plugins', 'session-manager-dev', 'skills', skillName, fileName),
  ];

  let entries = [];
  try {
    entries = fs.readdirSync(pluginCacheRoot, { withFileTypes: true });
  } catch { /* plugin cache not installed */ }
  const versions = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(compareVersionsDesc);
  for (const version of versions) {
    candidates.push(path.join(pluginCacheRoot, version, 'skills', skillName, fileName));
  }

  candidates.push(path.join(os.homedir(), '.claude', 'skills', skillName, fileName));
  return candidates;
}

/**
 * resolveSkillFile(cwd, skillName, fileName, pluginCacheRoot?) → string | null
 *
 * Returns the first candidate from listSkillCandidates() that is a readable
 * file, or null if none resolve.
 */
function resolveSkillFile(cwd, skillName, fileName, pluginCacheRoot = PLUGIN_CACHE_ROOT) {
  for (const candidate of listSkillCandidates(cwd, skillName, fileName, pluginCacheRoot)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * isPidAlive(pid) → boolean
 *
 * Plain liveness check via process.kill(pid, 0) (no signal sent). Single
 * source of truth for the "is this recorded pid still alive" check used by
 * checkAppLiveness's defense-in-depth relaunch gate.
 *
 * EPERM (pid exists, owned by another user) counts as alive — only ESRCH
 * (no such process) means dead. Watchdog and app run as the same user in
 * practice, so this distinction rarely matters here, but treating EPERM as
 * "dead" would be wrong on its face (the process demonstrably exists).
 */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

// Offline queue.json reconciliation (orphaned 'running' jobs whose pid died
// while Electron wasn't running) used to live here as reconcileQueueOffline().
// PRD 686 moved that responsibility into src/main/scheduler.cjs's own boot
// path (partitionBootOrphans/applyOrphanOutcome) now that PRD 685's watchdog
// relaunch means the app is never down long enough to need an external
// reconciler — the in-app scheduler is queue.json's single owner again.

// ── slugify ──────────────────────────────────────────────────────────────────

/** Lowercase, non-alphanumeric runs → single `-`, strip leading/trailing `-`. */
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── YAML frontmatter stripper ─────────────────────────────────────────────────

/**
 * Strip leading YAML frontmatter block (---\n…\n---) from skill/standards files
 * so they can be inlined cleanly into a PRD body.
 */
function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n/, '');
}

/**
 * Strip a leading H1 line (`# …\n`) — used to drop the `# Engineering standards`
 * heading from standards.md before adding our own `## Engineering standards` heading.
 */
function stripLeadingH1(content) {
  return content.replace(/^# [^\n]*\n/, '');
}

// ── hasOpenFeedback ───────────────────────────────────────────────────────────

/**
 * hasOpenFeedback(cwd) → boolean
 *
 * Returns true iff `<cwd>/session-manager-operations/feedback/` (the PRD-462
 * convention) or, as a transitional fallback for repos not yet relocated,
 * the legacy `<cwd>/feedback/` exists AND contains at least one *.md file
 * directly in its root (i.e. NOT inside `processed/` or any subdirectory).
 * Pure filesystem check — no LLM call.
 *
 * Mirrors process-feedback skill step 0 (cheap quick-exit signal).
 * Complexity: O(F) where F ≤ entries in the feedback folder root.
 */
function hasOpenFeedback(cwd) {
  for (const folderName of [path.join('session-manager-operations', 'feedback'), 'feedback']) {
    const folderPath = path.join(cwd, folderName);
    let entries;
    try {
      entries = fs.readdirSync(folderPath);
    } catch {
      continue; // folder does not exist
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      // README.md is the folder's convention doc, not an open feedback item —
      // counting it makes a folder with only a README look perpetually "pending".
      if (entry.toLowerCase() === 'readme.md') continue;
      try {
        const st = fs.statSync(path.join(folderPath, entry));
        if (st.isFile()) return true;
      } catch { continue; }
    }
  }
  return false;
}

// ── emitFeedbackPRD ──────────────────────────────────────────────────────────

/**
 * emitFeedbackPRD(cwd, opts?) → { emitted: boolean, slug?: string, prdPath?: string, reason?: string }
 *
 * De-dups against queue.json (pending/running jobs whose slug matches
 * `^\d+-feedback-<project>$`). If a match exists, returns { emitted: false, reason: 'duplicate' }.
 *
 * Otherwise picks the next free NN by scanning prdsDir, writes a self-contained
 * PRD file with the inlined process-feedback procedure + engineering standards,
 * and returns { emitted: true, slug, prdPath }.
 *
 * Never writes to queue.json — the app's reconcile picks up new PRD files.
 * Atomic write: tmp → rename (mirrors config.cjs writeJsonSync pattern).
 *
 * Complexity: O(P) over PRD files in prdsDir + O(J) over queue jobs.
 */
function emitFeedbackPRD(cwd, {
  prdsDir = DEFAULT_PRDS_DIR,
  queuePath = DEFAULT_QUEUE_PATH,
  skillPath,
  standardsPath,
  pluginCacheRoot = PLUGIN_CACHE_ROOT,
} = {}) {
  // Explicit overrides (used by tests) are honored verbatim and skip the
  // candidate search entirely — only resolve via candidates when the caller
  // didn't pass a path.
  const skillPathExplicit = skillPath !== undefined;
  const standardsPathExplicit = standardsPath !== undefined;
  if (!skillPathExplicit) {
    skillPath = resolveSkillFile(cwd, 'process-feedback', 'SKILL.md', pluginCacheRoot);
  }
  if (!standardsPathExplicit) {
    standardsPath = resolveSkillFile(cwd, 'develop', 'standards.md', pluginCacheRoot);
  }
  const project = slugify(path.basename(cwd));

  // De-dup: check queue.json for pending/running feedback job for this project.
  let queueState = { jobs: [] };
  try {
    queueState = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch { /* queue.json may not exist */ }

  // project only contains [a-z0-9-] after slugify — no regex metachar escaping needed.
  const dupRe = new RegExp(`^\\d+-feedback-${project}$`);
  const isDuplicate = (queueState.jobs ?? []).some(
    (j) => (j.status === 'pending' || j.status === 'running') && dupRe.test(j.slug),
  );
  if (isDuplicate) {
    return { emitted: false, reason: 'duplicate' };
  }

  // Pick next NN: max existing NN prefix + 1. O(P) scan.
  // We ALSO dedup against the prds dir here: while the app is down it never
  // ingests new PRD files into queue.json, so the queue check above can't see a
  // feedback PRD we already wrote on a previous tick. Without this, every stale
  // watchdog tick emits a fresh NN-feedback-<project>.md, unbounded.
  const prdDupRe = new RegExp(`^\\d+-feedback-${project}\\.md$`);
  let maxNN = 0;
  let prdFiles = [];
  try {
    prdFiles = fs.readdirSync(prdsDir);
  } catch { /* prdsDir may not exist yet */ }
  for (const f of prdFiles) {
    if (prdDupRe.test(f)) {
      return { emitted: false, reason: 'duplicate' };
    }
    const m = f.match(/^(\d+)-/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNN) maxNN = n;
    }
  }
  const nn = String(maxNN + 1).padStart(2, '0');
  const slug = `${nn}-feedback-${project}`;
  const prdPath = path.join(prdsDir, `${slug}.md`);

  // Read and inline skill content.
  let rawSkill = '';
  if (skillPath) {
    try {
      rawSkill = fs.readFileSync(skillPath, 'utf8');
    } catch { /* handled by the empty-body guard below */ }
  }
  const skillBody = stripFrontmatter(rawSkill).trim();

  // Read and inline standards — strip H1 so our ## heading is the section anchor.
  let rawStandards = '';
  if (standardsPath) {
    try {
      rawStandards = fs.readFileSync(standardsPath, 'utf8');
    } catch { /* handled by the empty-body guard below */ }
  }
  const standardsBody = stripLeadingH1(stripFrontmatter(rawStandards)).trim();

  // Hard-fail rather than silently ship a hollow PRD: if either inline is
  // empty/unreadable, refuse to write anything and name every candidate tried
  // so a future relocation shows up loudly in the watchdog log instead of
  // queueing a template with no procedure and no standards in it.
  if (!skillBody || !standardsBody) {
    const missing = [];
    if (!skillBody) {
      const tried = skillPathExplicit ? [skillPath] : listSkillCandidates(cwd, 'process-feedback', 'SKILL.md', pluginCacheRoot);
      missing.push(`process-feedback SKILL.md (tried: ${tried.join(', ')})`);
    }
    if (!standardsBody) {
      const tried = standardsPathExplicit ? [standardsPath] : listSkillCandidates(cwd, 'develop', 'standards.md', pluginCacheRoot);
      missing.push(`develop standards.md (tried: ${tried.join(', ')})`);
    }
    process.stderr.write(`[emitFeedbackPRD] refusing to emit for ${cwd}: missing inline(s) — ${missing.join('; ')}\n`);
    return { emitted: false, reason: 'missing-inline' };
  }

  const projectName = path.basename(cwd);
  const body = [
    '---',
    `title: Process feedback for ${projectName}`,
    `cwd: ${cwd}`,
    'estimateMinutes: 15',
    '---',
    '',
    '# Goal',
    '',
    `Process the inbound feedback folder for ${projectName}. The quick-exit (step 0 below)`,
    'means this run bails in milliseconds if no open items exist — safe to execute even if',
    'feedback was already cleared between scheduling and execution.',
    '',
    '# Acceptance criteria',
    '',
    '- [ ] All open feedback items evaluated and either queued via /develop, declined with RESOLUTION, or forwarded upstream.',
    '- [ ] Processed items archived to session-manager-operations/feedback/processed/ (or, for repos not yet relocated, legacy feedback/processed/) with RESOLUTION notes.',
    '- [ ] session-manager-operations/feedback/README.md (or legacy feedback/README.md) self-improved with lessons from this pass.',
    '- [ ] timeout 60 git diff --exit-code runs clean (no uncommitted inline work).',
    '',
    '# Implementation notes',
    '',
    'Follow the inlined process-feedback procedure below exactly. No skills are loaded in',
    'headless execution — the procedure is fully self-contained. Use /develop for any work',
    'that belongs to this project; never implement feedback inline.',
    '',
    '# Out of scope',
    '',
    '- Implementing feedback items directly (that is /develop → scheduler).',
    '- Cross-project feedback beyond filing upstream items.',
    '',
    skillBody,
    '',
    '## Engineering standards',
    '',
    standardsBody,
  ].join('\n');

  // Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync).
  const tmpPath = `${prdPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(tmpPath, body + '\n', 'utf8');
    fs.renameSync(tmpPath, prdPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }

  return { emitted: true, slug, prdPath };
}

// ── app liveness + auto-relaunch ─────────────────────────────────────────────
//
// The watchdog's one supervision job: is session-manager itself running, and
// if not, start it. Reuses the existing scheduler heartbeat (written every
// 60 s by scheduler.cjs's heartbeatInterval regardless of pause state) as the
// liveness signal — no second heartbeat file.

const DEFAULT_RELAUNCH_STATE_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'watchdog-relaunch-state.json',
);
const DEFAULT_RELAUNCH_LOG_PATH = path.join(
  os.homedir(), '.claude', 'logs', 'scheduler-watchdog-relaunch.log',
);
const DEFAULT_RELAUNCH_DEBOUNCE_MS = 90_000;
const DEFAULT_MAX_RELAUNCH_ATTEMPTS = 3;

/**
 * checkAppLiveness(opts?) → { alive: boolean, reason: string }
 *
 * Primary signal: heartbeatFresh() within the existing max-age window.
 * Defense-in-depth: if the heartbeat is stale, but the pid it last recorded
 * is still alive (app under heavy load, tick just missed), treat as alive
 * rather than relaunching on top of a live process.
 */
function checkAppLiveness({
  heartbeatPath = DEFAULT_HEARTBEAT_PATH,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (heartbeatFresh(heartbeatPath, maxAgeMs)) {
    return { alive: true, reason: 'heartbeat-fresh' };
  }
  const last = readLastHeartbeat(heartbeatPath);
  if (last !== null && typeof last.pid === 'number' && isPidAlive(last.pid)) {
    return { alive: true, reason: 'pid-alive-heartbeat-stale' };
  }
  return { alive: false, reason: 'stale-and-dead' };
}

/** Default { lastAttemptTs: null, attemptCount: 0 } on missing/unparseable state file. */
function readRelaunchState(statePath = DEFAULT_RELAUNCH_STATE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      lastAttemptTs: typeof raw.lastAttemptTs === 'number' ? raw.lastAttemptTs : null,
      attemptCount: typeof raw.attemptCount === 'number' ? raw.attemptCount : 0,
    };
  } catch {
    return { lastAttemptTs: null, attemptCount: 0 };
  }
}

/** Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync). */
function writeRelaunchState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, statePath);
}

function logRelaunchLine(logPath, message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch (e) {
    process.stderr.write(`[watchdog-relaunch] log write failed: ${e?.message}\n`);
  }
}

/**
 * defaultSpawnRelaunch(opts?) — launches a new session-manager instance the
 * same way a user would: `npx claude-code-session-manager@latest` (the
 * documented distribution method — CLAUDE.md's "Distribution" section), so
 * this keeps working across npm publishes with no local path to maintain.
 *
 * Detached + stdio redirected to logPath + unref()'d so the watchdog's own
 * (short-lived) process doesn't block on the launched app and the app
 * survives the watchdog exiting.
 */
function defaultSpawnRelaunch({ logPath = DEFAULT_RELAUNCH_LOG_PATH } = {}) {
  const { spawn } = require('node:child_process');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  try {
    const child = spawn('npx', ['claude-code-session-manager@latest'], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('error', (e) => {
      logRelaunchLine(logPath, `spawn error: ${e?.message}`);
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * maybeRelaunchApp(opts?) → { relaunched: boolean, reason: string, attemptCount: number }
 *
 * Debounced, capped auto-relaunch:
 *   - alive (heartbeat fresh or pid alive)             → no-op, reset attempt state.
 *   - dead + attemptCount already at maxAttempts         → skip, log diagnostic (give up).
 *   - dead + last attempt < debounceMs ago                → skip (still booting).
 *   - dead + debounce elapsed + under cap               → spawn, bump attemptCount, log.
 *
 * attemptCount only resets to 0 once a fresh heartbeat is observed (i.e. a
 * relaunch actually succeeded), so 3 relaunch attempts that each fail to
 * produce a fresh heartbeat permanently cap further attempts until a human
 * intervenes or the app comes up some other way.
 */
function maybeRelaunchApp({
  heartbeatPath = DEFAULT_HEARTBEAT_PATH,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  statePath = DEFAULT_RELAUNCH_STATE_PATH,
  logPath = DEFAULT_RELAUNCH_LOG_PATH,
  debounceMs = DEFAULT_RELAUNCH_DEBOUNCE_MS,
  maxAttempts = DEFAULT_MAX_RELAUNCH_ATTEMPTS,
  now = Date.now(),
  spawnFn = defaultSpawnRelaunch,
} = {}) {
  const liveness = checkAppLiveness({ heartbeatPath, maxAgeMs });
  const state = readRelaunchState(statePath);

  if (liveness.alive) {
    if (state.attemptCount !== 0 || state.lastAttemptTs !== null) {
      writeRelaunchState(statePath, { lastAttemptTs: null, attemptCount: 0 });
    }
    return { relaunched: false, reason: 'alive', attemptCount: 0 };
  }

  if (state.attemptCount >= maxAttempts) {
    logRelaunchLine(
      logPath,
      `giving up: ${state.attemptCount} relaunch attempt(s) already made and heartbeat is still stale — manual intervention required`,
    );
    return { relaunched: false, reason: 'capped', attemptCount: state.attemptCount };
  }

  if (state.lastAttemptTs !== null && (now - state.lastAttemptTs) < debounceMs) {
    return { relaunched: false, reason: 'debounce', attemptCount: state.attemptCount };
  }

  const attemptCount = state.attemptCount + 1;
  spawnFn({ logPath });
  writeRelaunchState(statePath, { lastAttemptTs: now, attemptCount });
  logRelaunchLine(
    logPath,
    `relaunch attempt ${attemptCount}/${maxAttempts}: spawning "npx claude-code-session-manager@latest" (heartbeat stale, last-known pid dead)`,
  );
  return { relaunched: true, reason: 'launched', attemptCount };
}

// ── sweep ─────────────────────────────────────────────────────────────────────

/**
 * sweep(opts?) → { scanned: number, emitted: number, skipped: number }
 *
 * For each active-session cwd (from activeProjectCwds), cheaply checks for open
 * feedback. Projects without open feedback cost a readdir per folder name — no LLM.
 * Projects with open feedback get a PRD emitted into prdsDir (de-duped against queue).
 *
 * Never mutates queue.json — only adds PRD files, so it is safe to run while the
 * in-app scheduler is alive.
 *
 * Complexity: O(C × F) where C = active cwds (≤50) and F = root entries per
 * feedback folder (typically small).
 *
 * opts:
 *   projectsDir  — forwarded to activeProjectCwds for testing
 *   prdsDir, queuePath, skillPath, standardsPath — forwarded to emitFeedbackPRD
 */
function sweep({
  projectsDir,
  prdsDir = DEFAULT_PRDS_DIR,
  queuePath = DEFAULT_QUEUE_PATH,
  skillPath,
  standardsPath,
} = {}) {
  const activeOpts = {};
  if (projectsDir !== undefined) activeOpts.projectsDir = projectsDir;

  const cwds = activeProjectCwds(90, activeOpts);

  let scanned = 0;
  let emitted = 0;
  let skipped = 0;

  for (const cwd of cwds) {
    scanned++;
    if (!hasOpenFeedback(cwd)) continue;

    let result;
    try {
      result = emitFeedbackPRD(cwd, { prdsDir, queuePath, skillPath, standardsPath });
    } catch (e) {
      process.stderr.write(`[sweep] error emitting PRD for ${cwd}: ${e?.message}\n`);
      continue;
    }

    if (result.emitted) {
      emitted++;
      process.stderr.write(`[sweep] emitted ${result.slug} for ${cwd}\n`);
    } else {
      skipped++;
      process.stderr.write(`[sweep] skipped ${cwd} (${result.reason})\n`);
    }
  }

  process.stderr.write(`[sweep] scanned=${scanned} emitted=${emitted} skipped=${skipped}\n`);
  return { scanned, emitted, skipped };
}

// ── maybeFinalizeHistory ─────────────────────────────────────────────────────
//
// Precomputes closed History-dashboard days outside Electron, so the app's
// first paint after a boot (possibly weeks after the app was last open) is
// instant, and old transcripts stay safe to age out without losing analytics.
// See src/main/historyAggregator.cjs's finalizeClosedDays() for the actual
// walk/persist logic — this is just the once-per-day scheduling + lock
// wrapper around it, tailored to being invoked repeatedly by a systemd timer.

const DEFAULT_STAMP_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'history-rollup.stamp',
);
const DEFAULT_LOCK_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'history-rollup.lock',
);
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_FINALIZE_BUDGET_MS = 60_000;

function readStampDate(stampPath) {
  try {
    return fs.readFileSync(stampPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync). */
function writeStampDate(stampPath, date) {
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  const tmpPath = `${stampPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, date, 'utf8');
  fs.renameSync(tmpPath, stampPath);
}

/**
 * tryAcquireLock(lockPath, staleMs) → boolean
 *
 * O_EXCL ('wx') lock file so the in-app Electron boot pass and this cron
 * pass never interleave writes to the rollup. A lock older than staleMs is
 * assumed abandoned (a crashed holder) and reclaimed; otherwise the caller
 * loses the race and must skip silently.
 */
function tryAcquireLock(lockPath, staleMs = DEFAULT_LOCK_STALE_MS) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  let st;
  try {
    st = fs.statSync(lockPath);
  } catch {
    st = null; // lock vanished between our failed create and this stat
  }

  if (st !== null && Date.now() - st.mtimeMs <= staleMs) {
    return false; // held by a live (or at least recent) owner — loser skips
  }

  // Stale (or already gone) — reclaim. The unlink+wx pair isn't atomic, so
  // two concurrent reclaimers could theoretically both win here — but that
  // only happens when the prior holder already crashed/vanished, and the
  // resulting "both run finalize" outcome is benign: appendRollupDays is
  // append-only + last-write-wins-deduped, so a redundant concurrent pass
  // costs extra work, not corrupted data.
  try {
    if (st !== null) fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone / never created */ }
}

/** Lazily require historyAggregator.cjs — deferred so a missing PRD-650
 *  dependency fails inside maybeFinalizeHistory's try/catch, not at require
 *  time for the whole watchdog script. */
function defaultFinalizeClosedDays(opts) {
  const { finalizeClosedDays } = require('../../src/main/historyAggregator.cjs');
  return finalizeClosedDays(opts);
}

/**
 * maybeFinalizeHistory(opts?) → Promise<{ ran, reason, date, finalizedDates? }>
 *
 * Runs at most once per local day (stamp-file gated, O(1) same-day skip).
 * Guards against interleaving with the in-app Electron boot pass via an
 * O_EXCL lock file. Bounded by opts.budgetMs so a huge transcript corpus
 * can't make a single watchdog tick run long; a budget-partial pass does
 * NOT stamp the day complete, so a later tick resumes/retries.
 *
 * opts:
 *   stampPath   — override for testing (default ~/.claude/session-manager/history-rollup.stamp)
 *   lockPath    — override for testing (default ~/.claude/session-manager/history-rollup.lock)
 *   staleLockMs — lock staleness threshold (default 10 min)
 *   budgetMs    — cap forwarded to finalizeClosedDays (default 60_000)
 *   dryRun      — compute without writing (default SM_WATCHDOG_DRYRUN === '1')
 *   finalizeFn  — injectable finalizeClosedDays for testing
 */
async function maybeFinalizeHistory({
  stampPath = DEFAULT_STAMP_PATH,
  lockPath = DEFAULT_LOCK_PATH,
  staleLockMs = DEFAULT_LOCK_STALE_MS,
  budgetMs = DEFAULT_FINALIZE_BUDGET_MS,
  dryRun = process.env.SM_WATCHDOG_DRYRUN === '1',
  finalizeFn = defaultFinalizeClosedDays,
} = {}) {
  const today = localDateStr();

  if (readStampDate(stampPath) === today) {
    return { ran: false, reason: 'already-finalized-today', date: today };
  }

  if (!tryAcquireLock(lockPath, staleLockMs)) {
    return { ran: false, reason: 'lock-contended', date: today };
  }

  try {
    const result = await finalizeFn({ budgetMs, dryRun });

    if (dryRun) {
      return { ran: false, reason: 'dry-run', date: today, finalizedDates: result.finalizedDates };
    }

    if (!result.partial) {
      writeStampDate(stampPath, today);
      return { ran: true, reason: 'finalized', date: today, finalizedDates: result.finalizedDates };
    }

    return { ran: true, reason: 'partial', date: today, finalizedDates: result.finalizedDates };
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  readLastHeartbeat,
  readLastHeartbeatTs,
  heartbeatFresh,
  isPidAlive,
  hasOpenFeedback,
  resolveSkillFile,
  listSkillCandidates,
  emitFeedbackPRD,
  sweep,
  localDateStr,
  maybeFinalizeHistory,
  tryAcquireLock,
  releaseLock,
  checkAppLiveness,
  readRelaunchState,
  writeRelaunchState,
  defaultSpawnRelaunch,
  maybeRelaunchApp,
  DEFAULT_HEARTBEAT_PATH,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_STAMP_PATH,
  DEFAULT_LOCK_PATH,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_FINALIZE_BUDGET_MS,
  DEFAULT_RELAUNCH_STATE_PATH,
  DEFAULT_RELAUNCH_LOG_PATH,
  DEFAULT_RELAUNCH_DEBOUNCE_MS,
  DEFAULT_MAX_RELAUNCH_ATTEMPTS,
};
