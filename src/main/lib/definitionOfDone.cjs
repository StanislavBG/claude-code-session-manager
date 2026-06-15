'use strict';

/**
 * definitionOfDone.cjs — pure helpers for the definition-of-done drain gate.
 *
 * No scheduler imports; no side effects beyond fs reads in reportExists.
 * The scheduler wires these in (PRD 111).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');

// Regex identifying meta/dod slugs that must NOT influence the batchKey.
// This is the load-bearing loop-avoidance filter: when the gate job itself
// completes, the real batchKey must remain unchanged so the drain branch stays
// a no-op (idempotent) instead of re-firing forever.
const DOD_SLUG_RE = /(^|-)dod(-|$)|definition-of-done/i;

const RUNS_DIR = path.join(
  os.homedir(),
  '.claude', 'session-manager', 'scheduled-plans', 'runs'
);

/**
 * Compute a stable short hash for a completed job-set.
 *
 * Complexity: O(n log n) for the sort over n completed jobs; n is small
 * (the scheduler queue, not user-scaled data).
 *
 * @param {Array<{slug: string, runId: string}>} jobs
 * @returns {string} 8-char hex prefix of SHA-1 over sorted identity strings
 */
function batchKey(jobs) {
  const identities = jobs
    .filter(j => !DOD_SLUG_RE.test(j.slug))
    .map(j => `${j.slug}@${j.runId}`)
    .sort();

  return crypto
    .createHash('sha1')
    .update(identities.join('\n'))
    .digest('hex')
    .slice(0, 8);
}

/**
 * Canonical path for a DoD report file in a new timestamped run directory.
 * Callers that write the report must create the directory themselves.
 *
 * NOTE: each call mints a fresh timestamp, so every call returns a DIFFERENT
 * path even for the same key. Call once, save the result, reuse it — do not
 * call twice expecting the same directory.
 *
 * @param {string} key  Output of batchKey()
 * @returns {string}    Absolute path under runs/<iso-ts>/definition-of-done-<key>.md
 */
function reportPathFor(key) {
  if (!/^[0-9a-f]+$/.test(key)) throw new Error(`invalid batchKey: ${key}`);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(RUNS_DIR, ts, `definition-of-done-${key}.md`);
}

/**
 * Return true if a DoD report for this batchKey already exists in any
 * run subdirectory. Scans runs/<ts>/ (shallow, one level).
 *
 * @param {string} key       Output of batchKey()
 * @param {string} [runsDir] Override for testing; defaults to RUNS_DIR
 * @returns {boolean}
 */
function reportExists(key, runsDir = RUNS_DIR) {
  if (!/^[0-9a-f]+$/.test(key)) throw new Error(`invalid batchKey: ${key}`);
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const target = `definition-of-done-${key}.md`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(runsDir, entry.name, target);
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

// Shell metacharacters that require shell:true — prohibited by CLAUDE.md for
// non-user-supplied strings. Commands containing these are marked unverifiable
// rather than running under a shell, since CLAUDE.md restricts shell:true to
// watchers.cjs and app:test-fire-hook only.
const SHELL_META_RE = /[|>&;<`]|\$[({]/;

const PRDS_DIR = path.join(
  os.homedir(),
  '.claude', 'session-manager', 'scheduled-plans', 'prds'
);

/**
 * Extract the first bounded AC test command from a PRD body.
 *
 * Searches the # Acceptance criteria section for lines containing a
 * `timeout NNN cmd [args...]` invocation. Returns the command string or null.
 *
 * Commands containing shell metacharacters (pipe, redirect, subshell) are
 * skipped — they cannot be run without shell:true which is prohibited here.
 * The parser falls through to the next AC line in that case.
 *
 * Complexity: O(L) where L = number of lines in the body (not user-scaled;
 * PRD bodies are bounded documents, typically < 200 lines).
 *
 * @param {string} prdBody  PRD markdown with frontmatter already stripped.
 * @returns {string|null}
 */
function extractAcCommand(prdBody) {
  if (!prdBody || typeof prdBody !== 'string') return null;

  // Parse line-by-line to locate the # Acceptance criteria section.
  // A regex lookahead approach with the `m` flag misidentifies `$` as
  // end-of-line (not end-of-string), causing the lazy capture to terminate
  // immediately. Line-by-line parsing avoids that pitfall.
  const lines = prdBody.split('\n');
  let inAcSection = false;
  let hasAcSection = false;
  let acHeadingLevel = 0;
  const acLines = [];

  for (const line of lines) {
    if (/^#+\s/i.test(line)) {
      const level = line.match(/^(#+)/)[1].length;
      if (/^#+\s*Acceptance\s+criteria/i.test(line)) {
        inAcSection = true;
        hasAcSection = true;
        acHeadingLevel = level;
      } else if (inAcSection && level <= acHeadingLevel) {
        // A sibling or parent heading ends the AC section;
        // sub-headings (level > acHeadingLevel) stay inside it.
        inAcSection = false;
      }
      continue;
    }
    if (inAcSection) acLines.push(line);
  }

  // Fall back to full body if no AC section header was found.
  const candidates = hasAcSection ? acLines : lines;

  for (const line of candidates) {
    // Prefer backtick-delimited inline code: `timeout NNN cmd ...`
    const backtickMatch = line.match(/`(timeout\s+\d+\s+[^`]+)`/i);
    if (backtickMatch) {
      const cmd = backtickMatch[1].trim();
      if (!SHELL_META_RE.test(cmd)) return cmd;
    }

    // Fall back: bare `timeout NNN cmd ...` anywhere on the line.
    // Trim trailing all-lowercase-alpha tokens (prose words like "passes",
    // "and", "the") while keeping at least 4 tokens (timeout, N, binary,
    // first-arg). This prevents over-matching into prose that follows the
    // command on the same AC line (e.g. "timeout 60 npm test and verify").
    const rawMatch = line.match(/\btimeout\s+\d+\s+\S+(?:\s+\S+)*/);
    if (rawMatch) {
      const tokens = rawMatch[0].trim().split(/\s+/);
      while (tokens.length > 4 && /^[a-z]+$/.test(tokens[tokens.length - 1])) {
        tokens.pop();
      }
      const cmd = tokens.join(' ');
      if (!SHELL_META_RE.test(cmd)) return cmd;
    }
  }
  return null;
}

/**
 * Re-run the AC test command for a single completed job and report the result.
 *
 * Never touches queue.json or spawns claude — only re-runs the already-authored
 * test command. That is what keeps this function loop-safe and cheap.
 *
 * @param {{ slug: string, cwd: string }} job
 * @param {{ timeoutMs?: number, prdsDir?: string }} opts
 *   timeoutMs  Hard kill ceiling for the child (default 60s).
 *   prdsDir    Override PRD directory (for tests).
 * @returns {Promise<{ slug: string, status: 'pass'|'fail'|'unverifiable', code: number|null, ms: number }>}
 */
function reverifyAc(job, { timeoutMs = 60_000, prdsDir } = {}) {
  const resolvedPrdsDir = prdsDir ?? PRDS_DIR;
  const startNs = process.hrtime.bigint();

  function elapsedMs() {
    return Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
  }

  function unverifiable() {
    return { slug: job.slug, status: 'unverifiable', code: null, ms: elapsedMs() };
  }

  // Guard: cwd must exist (target project may have been deleted).
  try {
    fs.statSync(job.cwd);
  } catch {
    return Promise.resolve(unverifiable());
  }

  // Read and strip PRD frontmatter via the shared parser.
  const prdPath = path.join(resolvedPrdsDir, `${job.slug}.md`);
  let prdBody;
  try {
    const raw = fs.readFileSync(prdPath, 'utf8');
    prdBody = splitFrontmatter(raw).body;
  } catch {
    return Promise.resolve(unverifiable());
  }

  const cmd = extractAcCommand(prdBody);
  if (!cmd) return Promise.resolve(unverifiable());

  // Simple whitespace split — SHELL_META_RE in extractAcCommand already excludes
  // commands that would need a shell. Paths with spaces are not expected in AC
  // commands (PRD authoring convention: use relative paths from cwd).
  const argv = cmd.trim().split(/\s+/);
  if (argv.length < 2) return Promise.resolve(unverifiable());

  return new Promise((resolve) => {
    let settled = false;

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: job.cwd,
        stdio: 'ignore',
        // No shell:true — extractAcCommand rejects commands with shell metacharacters.
      });
    } catch (err) {
      resolve(unverifiable());
      return;
    }

    let escalate;
    const killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      escalate = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* race */ }
      }, 5_000);
      if (escalate.unref) escalate.unref();
    }, timeoutMs);
    if (killTimer.unref) killTimer.unref();

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(escalate);
      resolve(unverifiable());
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(escalate);
      const exitCode = typeof code === 'number' ? code : -1;
      resolve({
        slug: job.slug,
        status: exitCode === 0 ? 'pass' : 'fail',
        code: exitCode,
        ms: elapsedMs(),
      });
    });
  });
}

/**
 * Re-run AC commands sequentially over a batch of completed jobs.
 *
 * Sequential execution respects the machine's max-3-concurrent rule — a drain
 * event that fires reverifyBatch is already consuming one slot; sequential
 * children ensure we never pile additional pressure on top.
 *
 * Total wall-time is bounded by batchTimeoutMs. When the cap is reached,
 * remaining jobs are returned as unverifiable without being started — the batch
 * cannot hang regardless of how many jobs are queued.
 *
 * Complexity: O(n) sequential spawns; n = number of completed jobs (bounded
 * by the scheduler queue size, not user-scaled data).
 *
 * @param {Array<{ slug: string, cwd: string }>} jobs
 * @param {{ timeoutMs?: number, batchTimeoutMs?: number, prdsDir?: string }} opts
 *   timeoutMs       Per-job kill ceiling (default 60s).
 *   batchTimeoutMs  Total wall-time cap for the whole batch (default 10m).
 *   prdsDir         Override PRD directory (for tests).
 * @returns {Promise<Array<{ slug: string, status: string, code: number|null, ms: number }>>}
 */
async function reverifyBatch(jobs, { timeoutMs = 60_000, batchTimeoutMs = 600_000, prdsDir } = {}) {
  const batchStartNs = process.hrtime.bigint();
  const results = [];

  for (const job of jobs) {
    const elapsedMs = Number(process.hrtime.bigint() - batchStartNs) / 1e6;
    if (elapsedMs >= batchTimeoutMs) {
      results.push({ slug: job.slug, status: 'unverifiable', code: null, ms: 0 });
      continue;
    }
    const result = await reverifyAc(job, { timeoutMs, prdsDir });
    results.push(result);
  }

  return results;
}

module.exports = { batchKey, reportPathFor, reportExists, extractAcCommand, reverifyAc, reverifyBatch };
