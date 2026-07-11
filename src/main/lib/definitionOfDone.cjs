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
const { spawn, spawnSync } = require('node:child_process');
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

// ─── Risk heuristics ──────────────────────────────────────────────────────────
// Conservative keyword/path matches — false positives are fine (they only add
// a "review recommended" line); the cost of a miss on a money path is higher.
const RISK_HEURISTICS = [
  { surface: 'money-path', re: /money|trade|order|position|price|payment/i },
  { surface: 'auth',       re: /auth|token|credential|secret/i },
  { surface: 'migration',  re: /migration|schema|alembic|\.sql/i },
];

/**
 * Extract a named heading section from a PRD body string.
 * Returns the lines under the heading until the next sibling/parent heading.
 * Complexity: O(L) where L = number of lines in body (bounded PRD document).
 *
 * @param {string} body
 * @param {string} headingText  Case-insensitive heading to find.
 * @returns {string}
 */
function _extractSection(body, headingText) {
  const escapedHeading = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^#+\\s+${escapedHeading}`, 'i');
  const lines = body.split('\n');
  let inSection = false;
  let headingLevel = 0;
  const sectionLines = [];

  for (const line of lines) {
    if (/^#+\s/.test(line)) {
      const level = line.match(/^(#+)/)[1].length;
      if (headingRe.test(line)) {
        inSection = true;
        headingLevel = level;
      } else if (inSection && level <= headingLevel) {
        inSection = false;
      }
      continue;
    }
    if (inSection) sectionLines.push(line);
  }

  return sectionLines.join('\n');
}

/**
 * Inspect the files each job touched and flag risk surfaces.
 *
 * For each job:
 *   1. If job.landedCommit is set, run `git show --name-only` (bounded by
 *      gitTimeoutMs) to obtain changed file paths.
 *   2. Otherwise fall back to the text of the PRD's `# Implementation notes`
 *      section which authors are expected to list the files they plan to touch.
 * Then check the candidate text against RISK_HEURISTICS (keyword/path match).
 *
 * Complexity: O(n * H) where n = jobs.length, H = RISK_HEURISTICS.length (3,
 * a constant). Not user-scaled data — the scheduler queue is bounded.
 *
 * @param {Array<{ slug: string, cwd: string, landedCommit?: string }>} jobs
 * @param {{ prdsDir?: string, gitTimeoutMs?: number }} opts
 * @returns {Array<{ slug: string, surfaces: string[] }>}  Only jobs with ≥1 hit.
 */
function flagRiskySurfaces(jobs, { prdsDir, gitTimeoutMs = 10_000 } = {}) {
  const resolvedPrdsDir = prdsDir ?? PRDS_DIR;
  const results = [];

  for (const job of jobs) {
    let candidateText = '';

    // 1. Try git commit — bounded by gitTimeoutMs.
    if (job.landedCommit && job.cwd) {
      try {
        const r = spawnSync(
          'git',
          ['-C', job.cwd, 'show', '--name-only', '--format=', job.landedCommit],
          { timeout: gitTimeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        if (r.status === 0 && r.stdout) candidateText = r.stdout;
      } catch { /* fall through to PRD body */ }
    }

    // 2. Fallback: PRD # Implementation notes section.
    // Guard: slug must contain only safe chars to prevent path traversal via a
    // corrupted queue.json entry (e.g. slug: "../../.ssh/id_rsa").
    if (!candidateText && job.slug && /^[\w-]+$/.test(job.slug)) {
      try {
        const raw = fs.readFileSync(path.join(resolvedPrdsDir, `${job.slug}.md`), 'utf8');
        const body = splitFrontmatter(raw).body;
        candidateText = _extractSection(body, 'Implementation notes');
      } catch { /* no candidate text — skip */ }
    }

    if (!candidateText) continue;

    // 3. Apply risk heuristics (O(H), constant).
    const surfaces = RISK_HEURISTICS
      .filter(h => h.re.test(candidateText))
      .map(h => h.surface);

    if (surfaces.length > 0) results.push({ slug: job.slug, surfaces });
  }

  return results;
}

// ─── Atomic write helper ───────────────────────────────────────────────────────
// Re-implements the tmp+rename recipe from config.cjs writeTextAtomic (sync
// variant), avoiding an import of Electron IPC code in a pure-node context.
// Cross-ref: src/main/config.cjs writeJsonSync (same pattern).
function _writeFileAtomic(absPath, text) {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, absPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tmp never created or already gone */ }
    throw err;
  }
}

const STATUS_EMOJI = { pass: '✅', fail: '❌', unverifiable: '⚠️' };

/**
 * Write a definition-of-done report for a completed batch.
 *
 * The report contains:
 *   (a) a per-PRD AC table (slug · pass/fail/unverifiable),
 *   (b) a risk-flag summary,
 *   (c) a "needs human attention" list with a one-line recommendation per entry.
 *
 * The report is written atomically (tmp + rename) to avoid partial reads.
 * Each call mints a fresh timestamped directory under runsDir, so two calls
 * with the same key produce two separate files; use reportExists() to gate
 * before calling.
 *
 * @param {string} key  Output of batchKey().
 * @param {{
 *   acResults: Array<{ slug: string, status: string, code: number|null, ms: number }>,
 *   riskFlags:  Array<{ slug: string, surfaces: string[] }>,
 *   runsDir?:  string,
 * }} opts
 * @returns {string}  Absolute path of the written report.
 */
function writeReport(key, { acResults = [], riskFlags = [], runsDir } = {}) {
  if (!/^[0-9a-f]+$/.test(key)) throw new Error(`invalid batchKey: ${key}`);

  const resolvedRunsDir = runsDir ?? RUNS_DIR;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(resolvedRunsDir, ts);
  const reportPath = path.join(dir, `definition-of-done-${key}.md`);

  // ── AC table ────────────────────────────────────────────────────────────────
  const acRows = acResults.map(r => {
    const emoji = STATUS_EMOJI[r.status] ?? '';
    return `| ${r.slug} | ${emoji} ${r.status} |`;
  });
  const acTable = [
    '| Slug | Status |',
    '|------|--------|',
    ...acRows,
  ].join('\n');

  // ── Risk flags table ─────────────────────────────────────────────────────────
  let riskSection;
  if (riskFlags.length === 0) {
    riskSection = '_No risk surfaces detected._';
  } else {
    riskSection = [
      '| Slug | Surfaces |',
      '|------|----------|',
      ...riskFlags.map(r => `| ${r.slug} | ${r.surfaces.join(', ')} |`),
    ].join('\n');
  }

  // ── Needs human attention ────────────────────────────────────────────────────
  const attentionLines = [];
  for (const r of acResults) {
    if (r.status === 'fail') {
      attentionLines.push(`- **${r.slug}** — AC failed; run \`/code-review\` on ${r.slug}`);
    } else if (r.status === 'unverifiable') {
      attentionLines.push(`- **${r.slug}** — unverifiable AC; manual inspection recommended for ${r.slug}`);
    }
  }
  for (const r of riskFlags) {
    attentionLines.push(
      `- **${r.slug}** — touches ${r.surfaces.join(', ')}; run \`/code-review\` on ${r.slug} — ${r.surfaces.join('/')} path`
    );
  }
  const attentionSection = attentionLines.length > 0
    ? attentionLines.join('\n')
    : '_None — all checks passed and no risk surfaces detected._';

  // ── Assemble report ──────────────────────────────────────────────────────────
  const report = [
    `# Definition of Done — batch ${key}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '> **Note:** This report flags surfaces for human review.',
    '> Deep LLM code-review is **recommended, not auto-run** — the gate detects',
    '> and flags; humans or `/code-review` do the deep pass.',
    '',
    '## AC Results',
    '',
    acTable,
    '',
    '## Risk Flags',
    '',
    riskSection,
    '',
    '## Needs Human Attention',
    '',
    attentionSection,
    '',
  ].join('\n');

  fs.mkdirSync(dir, { recursive: true });
  _writeFileAtomic(reportPath, report);

  return reportPath;
}

const WATERMARK_FILENAME = '.dod-watermark.json';

/**
 * Read the persisted "last finished" watermark used to bound which completed
 * jobs get reverified on each drain. Never throws — a missing or unparseable
 * sidecar means "beginning of time" (process everything), matching the
 * pre-watermark unbounded behavior on first-ever drain.
 *
 * @param {string} [runsDir] Override for testing; defaults to RUNS_DIR
 * @returns {string|null}  ISO8601 timestamp, or null if unset/unreadable.
 */
function readWatermark(runsDir = RUNS_DIR) {
  try {
    const raw = fs.readFileSync(path.join(runsDir, WATERMARK_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.lastFinishedAt === 'string' ? parsed.lastFinishedAt : null;
  } catch {
    return null;
  }
}

/**
 * Persist the "last finished" watermark so the next drain only reverifies
 * jobs that completed after it.
 *
 * @param {string} lastFinishedAt  ISO8601 timestamp.
 * @param {string} [runsDir]       Override for testing; defaults to RUNS_DIR
 */
function writeWatermark(lastFinishedAt, runsDir = RUNS_DIR) {
  fs.mkdirSync(runsDir, { recursive: true });
  _writeFileAtomic(
    path.join(runsDir, WATERMARK_FILENAME),
    JSON.stringify({ lastFinishedAt }, null, 2)
  );
}

module.exports = {
  batchKey,
  reportPathFor,
  reportExists,
  extractAcCommand,
  reverifyAc,
  reverifyBatch,
  flagRiskySurfaces,
  writeReport,
  readWatermark,
  writeWatermark,
};
