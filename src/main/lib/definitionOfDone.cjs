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
const { resolvePrdWriteDir } = require('./prdLocations.cjs');

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

const DEFAULT_GATE_TIMEOUT_MS = 300_000;

/**
 * Quote-aware tokenizer for ONE command segment — no shell. Returns the argv
 * tokens, or null when an unquoted shell metacharacter survives (pipe,
 * redirect, `;`, lone `&`, backtick, `$(`/`${`) or a quote is unbalanced.
 * Complexity: O(n) over the segment's characters.
 */
function tokenizeNoShell(seg) {
  const tokens = [];
  let cur = '';
  let inTok = false;
  let quote = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inTok = true; continue; }
    if (/\s/.test(c)) {
      if (inTok) { tokens.push(cur); cur = ''; inTok = false; }
      continue;
    }
    if ('|<>;&`'.includes(c) || (c === '$' && (seg[i + 1] === '(' || seg[i + 1] === '{'))) return null;
    cur += c;
    inTok = true;
  }
  if (quote) return null;
  if (inTok) tokens.push(cur);
  return tokens;
}

/**
 * Split a command chain on `&&` outside quotes and backticks.
 * Complexity: O(n).
 */
function splitOnAndAnd(text) {
  const segs = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '&' && text[i + 1] === '&') { segs.push(cur); cur = ''; i++; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

/**
 * Parse one `&&` chain into [{argv, timeoutMs, env, raw}]. Returns [] when any
 * segment is empty or needs a shell — a half-parsed gate must never run.
 * A leading `timeout N` (or `Ns`) token sets timeoutMs; leading literal
 * `NAME=value` tokens become env (a `TMPDIR=` assignment is dropped — the
 * shadow runner always supplies its own isolated TMPDIR; its value is
 * typically the un-runnable `$(mktemp -d)`, which is handled here without a
 * shell by simply never evaluating it).
 */
function parseChain(text) {
  const out = [];
  for (const seg of splitOnAndAnd(text)) {
    const raw = seg.trim();
    if (!raw) return [];
    // A dropped TMPDIR=$(mktemp -d) prefix is the one substitution we accept.
    const stripped = raw.replace(/^TMPDIR=\$\(mktemp -d\)\s+/, '');
    const tokens = tokenizeNoShell(stripped);
    if (!tokens || !tokens.length) return [];
    const env = {};
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      const [k, ...rest] = tokens.shift().split('=');
      if (k !== 'TMPDIR') env[k] = rest.join('=');
    }
    let timeoutMs = DEFAULT_GATE_TIMEOUT_MS;
    if (tokens[0] === 'timeout' && /^\d+s?$/.test(tokens[1] || '')) {
      timeoutMs = parseInt(tokens[1], 10) * 1000;
      tokens.splice(0, 2);
    }
    if (!tokens.length) return [];
    out.push({ argv: tokens, timeoutMs, env, raw });
  }
  return out;
}

/** Locate the `# Acceptance criteria` lines (whole body when the heading is absent). */
function acCandidateLines(body) {
  const lines = body.split('\n');
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
        inAcSection = false;
      }
      continue;
    }
    if (inAcSection) acLines.push(line);
  }
  return hasAcSection ? acLines : lines;
}

/**
 * Read an explicit gate spec: frontmatter `gate:` (`none`, inline `[a, b]`, or
 * a `- item` list) or a fenced ```gate block (one command chain per line).
 * Returns { kind: 'none' } | { kind: 'commands', chains: string[] } | null.
 */
function readExplicitGate(prdText) {
  const fmMatch = prdText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fmMatch) {
    const fmLines = fmMatch[1].split(/\r?\n/);
    for (let i = 0; i < fmLines.length; i++) {
      const m = fmLines[i].match(/^gate:\s*(.*)$/);
      if (!m) continue;
      const rest = m[1].trim();
      if (/^(['"]?)none\1$/i.test(rest)) return { kind: 'none' };
      const chains = [];
      if (rest.startsWith('[') && rest.endsWith(']')) {
        // Inline list — items may hold commas inside quotes, so split quote-aware.
        let cur = ''; let q = null;
        for (const c of rest.slice(1, -1)) {
          if (q) { if (c === q) q = null; else cur += c; continue; }
          if (c === '"' || c === "'") { q = c; continue; }
          if (c === ',') { chains.push(cur.trim()); cur = ''; continue; }
          cur += c;
        }
        chains.push(cur.trim());
      } else if (rest === '') {
        for (let j = i + 1; j < fmLines.length; j++) {
          const li = fmLines[j].match(/^\s+-\s+(.*)$/);
          if (!li) break;
          chains.push(li[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
        }
      }
      const kept = chains.filter(Boolean);
      if (kept.length) return { kind: 'commands', chains: kept };
    }
  }
  const fence = prdText.match(/^```gate[ \t]*\r?\n([\s\S]*?)^```/m);
  if (fence) {
    const chains = fence[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (chains.length === 1 && /^none$/i.test(chains[0])) return { kind: 'none' };
    if (chains.length) return { kind: 'commands', chains };
  }
  return null;
}

/**
 * Resolve a PRD's gate: explicit spec first (frontmatter `gate:` / ```gate
 * fence), else the first acceptance-criteria line carrying a parseable
 * `timeout N …` chain (backtick span preferred, else bare from the first
 * `timeout N`). Accepts the PRD with or without frontmatter.
 *
 * @param {string} prdText
 * @returns {{ source: 'none'|'explicit'|'ac-line'|'absent', sequence: Array<{argv:string[], timeoutMs:number, env:object, raw:string}> }}
 */
function resolveGate(prdText) {
  if (!prdText || typeof prdText !== 'string') return { source: 'absent', sequence: [] };
  const explicit = readExplicitGate(prdText);
  if (explicit) {
    if (explicit.kind === 'none') return { source: 'none', sequence: [] };
    const sequence = [];
    for (const chain of explicit.chains) {
      const parsed = parseChain(chain);
      if (!parsed.length) return { source: 'explicit', sequence: [] };
      sequence.push(...parsed);
    }
    return { source: 'explicit', sequence };
  }
  const body = splitFrontmatter(prdText).body;
  for (const line of acCandidateLines(body)) {
    const backtickMatch = line.match(/`([^`]*\btimeout\s+\d+\s[^`]*)`/i);
    if (backtickMatch) {
      const seq = parseChain(backtickMatch[1]);
      if (seq.length) return { source: 'ac-line', sequence: seq };
    }
    // Bare fallback: from the first `timeout N` to end of line, dropping
    // trailing all-lowercase prose words (keeping ≥ 4 tokens, as before).
    const rawMatch = line.match(/\btimeout\s+\d+\s+\S+(?:\s+\S+)*/);
    if (rawMatch) {
      const segs = splitOnAndAnd(rawMatch[0]);
      const tokens = segs[segs.length - 1].trim().split(/\s+/);
      while (tokens.length > 4 && /^[a-z]+$/.test(tokens[tokens.length - 1])) tokens.pop();
      segs[segs.length - 1] = tokens.join(' ');
      const seq = parseChain(segs.join('&&'));
      if (seq.length) return { source: 'ac-line', sequence: seq };
    }
  }
  return { source: 'absent', sequence: [] };
}

/**
 * The gate as an ordered list of no-shell commands: [{argv, timeoutMs}, …].
 * Empty when there is no parseable gate or the PRD opted out with `gate: none`
 * (resolveGate distinguishes the two). Complexity: O(L) over the PRD's lines.
 *
 * @param {string} prdBody  PRD markdown (frontmatter optional).
 * @returns {Array<{argv:string[], timeoutMs:number, env:object, raw:string}>}
 */
function extractAcSequence(prdBody) {
  return resolveGate(prdBody).sequence;
}

/**
 * The single-command view of the gate, as the original `timeout NNN cmd …`
 * string, or null when the gate is absent or is a multi-command chain
 * (reverifyAc runs one command; the chain is the shadow runner's job).
 *
 * @param {string} prdBody  PRD markdown with frontmatter already stripped.
 * @returns {string|null}
 */
function extractAcCommand(prdBody) {
  const seq = extractAcSequence(prdBody);
  return seq.length === 1 && seq[0].raw.startsWith('timeout') ? seq[0].raw : null;
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
 *   prdsDir    Override PRD directory (for tests). Defaults to the job's own
 *              per-project PRDs dir (resolvePrdWriteDir(job.cwd)).
 * @returns {Promise<{ slug: string, status: 'pass'|'fail'|'unverifiable', code: number|null, ms: number }>}
 */
function reverifyAc(job, { timeoutMs = 60_000, prdsDir } = {}) {
  const resolvedPrdsDir = prdsDir ?? (job.cwd ? resolvePrdWriteDir(job.cwd) : null);
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

  // Simple whitespace split — extractAcCommand already excludes
  // commands that would need a shell (tokenizeNoShell). Paths with spaces are not expected in AC
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
        // No shell:true — tokenizeNoShell rejects commands with shell metacharacters.
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
function extractSection(body, headingText) {
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
 *   prdsDir  Override PRD directory for every job (for tests). Defaults per-job to
 *            the job's own per-project PRDs dir (resolvePrdWriteDir(job.cwd)).
 * @returns {Array<{ slug: string, surfaces: string[] }>}  Only jobs with ≥1 hit.
 */
function flagRiskySurfaces(jobs, { prdsDir, gitTimeoutMs = 10_000 } = {}) {
  const results = [];

  for (const job of jobs) {
    let candidateText = '';
    const resolvedPrdsDir = prdsDir ?? (job.cwd ? resolvePrdWriteDir(job.cwd) : null);

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
    if (!candidateText && resolvedPrdsDir && job.slug && /^[\w-]+$/.test(job.slug)) {
      try {
        const raw = fs.readFileSync(path.join(resolvedPrdsDir, `${job.slug}.md`), 'utf8');
        const body = splitFrontmatter(raw).body;
        candidateText = extractSection(body, 'Implementation notes');
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


// ─── Shadow gate runner ────────────────────────────────────────────────────────
// Runs a PRD's parsed gate sequence WITHOUT deciding anything: the caller
// records the outcome next to the verdict. Not a claude -p run, so it takes no
// slot from sessionSlots; instead a single module-level flag keeps at most one
// shadow gate in flight machine-wide (the scheduler is one process).
let gateInFlight = false;
const OUTPUT_TAIL_CHARS = 1000;

function runOneGateCommand(cmd, { cwd, env }) {
  return new Promise((resolve) => {
    const startNs = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
    const label = cmd.argv.join(' ');
    let child;
    try {
      child = spawn(cmd.argv[0], cmd.argv.slice(1), {
        cwd,
        env: { ...env, ...cmd.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // No shell:true — the sequence was tokenized by tokenizeNoShell.
      });
    } catch {
      resolve({ cmd: label, status: 'unavailable', code: null, ms: ms(), timedOut: false, tail: '' });
      return;
    }
    let tail = '';
    const onData = (d) => { tail = (tail + d).slice(-OUTPUT_TAIL_CHARS); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let settled = false;
    let timedOut = false;
    let escalate;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      escalate = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* race */ }
      }, 5_000);
      if (escalate.unref) escalate.unref();
    }, cmd.timeoutMs);
    if (killTimer.unref) killTimer.unref();
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(escalate);
      resolve({ cmd: label, ms: ms(), timedOut, tail, ...r });
    };
    child.on('error', () => finish({ status: 'unavailable', code: null }));
    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : -1;
      finish({ status: exitCode === 0 ? 'pass' : 'fail', code: exitCode });
    });
  });
}

/**
 * Run a gate sequence (extractAcSequence output) in `cwd` with `&&` semantics:
 * stop at the first non-pass. Each run gets its own isolated TMPDIR (mkdtemp,
 * removed afterwards) and CI=1, so a suite that sweeps its temp root can never
 * touch a live one.
 *
 * @param {Array<{argv:string[], timeoutMs:number, env?:object}>} sequence
 * @param {{ cwd: string }} opts
 * @returns {Promise<{ status: 'green'|'red'|'unavailable'|'busy', results: object[] }>}
 *   'busy' = another shadow gate is in flight; nothing ran, nothing to record.
 */
async function runGateSequence(sequence, { cwd }) {
  if (gateInFlight) return { status: 'busy', results: [] };
  if (!Array.isArray(sequence) || !sequence.length) return { status: 'unavailable', results: [] };
  try { fs.statSync(cwd); } catch { return { status: 'unavailable', results: [] }; }
  gateInFlight = true;
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gate-shadow-'));
    const env = { ...process.env, TMPDIR: tmp, CI: '1' };
    const results = [];
    for (const cmd of sequence) {
      const r = await runOneGateCommand(cmd, { cwd, env });
      results.push(r);
      if (r.status === 'unavailable') return { status: 'unavailable', results };
      if (r.status === 'fail') return { status: 'red', results };
    }
    return { status: 'green', results };
  } catch {
    return { status: 'unavailable', results: [] };
  } finally {
    gateInFlight = false;
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
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
  extractAcSequence,
  resolveGate,
  runGateSequence,
  extractSection,
  reverifyAc,
  reverifyBatch,
  flagRiskySurfaces,
  writeReport,
  readWatermark,
  writeWatermark,
};
