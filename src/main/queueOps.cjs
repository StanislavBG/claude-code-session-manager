/**
 * queueOps.cjs — bulk PRD operations + queue-health linter.
 *
 * This module is owned by Bundle D. It registers three IPC handlers:
 *
 *   schedule:lint-queue    — scan all PRDs in PRDS_DIR for anti-patterns
 *   schedule:archive-prd   — move PRDS_DIR/<slug>.md → prds-archived/<ISO>/<slug>.md
 *   schedule:retag-prd     — rewrite parallelGroup and/or estimateMinutes
 *                            frontmatter; optionally rename slug to reflect
 *                            the new NN- prefix
 *
 * All file mutations go through tmp + rename for atomicity. Path containment
 * is enforced against PRDS_DIR via path.resolve() + startsWith() (mirrors
 * scheduler.cjs's existing pattern).
 *
 * The linter rules come from research-04 §1 (queue-health) plus PRD 106's
 * regex inventory. Rules:
 *   - `^until ` at the start of a logical line  → fizzpop-style poll hang
 *   - `^while true` (case insensitive)          → unbounded while loop
 *   - `for .* in $(seq 1 [5-9][0-9][0-9]+)`     → unbounded large seq
 *   - missing frontmatter title / cwd / estimateMinutes
 *   - cwd doesn't exist on disk (fs.accessSync)
 *   - `--no-verify` or `--no-gpg-sign`          → hook-skip flags
 *
 * Severity: 'error' for the loop patterns and missing required frontmatter;
 * 'warn' for the rest.
 *
 * Time complexity: O(F × L) where F = number of PRD files, L = avg line count.
 * Hot-loop-safe: regex tests are pre-compiled module-level constants.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ipcMain } = require('electron');
const { SCHEDULE_SLUG_RE: SLUG_RE, schemas } = require('./ipcSchemas.cjs');
const logs = require('./logs.cjs');
const config = require('./config.cjs');
const { expandHome } = require('./lib/expandHome.cjs');
const { HISTORY_RETENTION_MS } = require('./lib/schedulerConfig.cjs');

const ROOT = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans');
const PRDS_DIR = path.join(ROOT, 'prds');
const PRDS_ARCHIVE_DIR = path.join(ROOT, 'prds-archived');
const RETAG_LOG = path.join(ROOT, 'retag-log.jsonl');

// ────────────────────────────────────────────── lint rules

// Each rule: { id, severity, test: (line) => boolean }
// O(1) regex test per line. Module-level so the compiled forms don't churn.
const LINE_RULES = [
  {
    id: 'unbounded-until',
    severity: 'error',
    re: /^\s*until\s+/,
    label: '"until" loop — risk of unbounded poll (see PRD 106 §1)',
  },
  {
    id: 'while-true',
    severity: 'error',
    re: /^\s*while\s+(?:true|:)/i,
    label: '"while true" — unbounded loop',
  },
  {
    id: 'unbounded-seq',
    severity: 'error',
    // for X in $(seq 1 NNN) where NNN ≥ 500. PRD 106 §1 cites this exact pattern.
    re: /for\s+\S+\s+in\s+\$\(seq\s+1\s+[5-9][0-9]{2,}/,
    label: 'unbounded seq — for-loop range ≥500',
  },
  {
    id: 'no-verify',
    severity: 'warn',
    re: /--no-verify\b/,
    label: '--no-verify — skips git hooks',
  },
  {
    id: 'no-gpg-sign',
    severity: 'warn',
    re: /--no-gpg-sign\b/,
    label: '--no-gpg-sign — bypasses signing',
  },
];

// Interactive/GUI-rendering-as-headless-AC patterns (research: PRDs 776/779,
// the 2026-07-30 exit143 incident — a claude -p executor hits a tool-use
// rejection on these and hangs until the scheduler SIGTERMs it, even when
// the step works fine run interactively). Keyed off AC-checkbox context
// specifically (a "- [ ] " line via INTERACTIVE_AC_CHECKBOX_RE), not any
// occurrence anywhere in the file — a PRD's Out-of-scope/Implementation-notes
// prose explicitly telling the executor NOT to do this (e.g. "NOTE: do NOT
// add a `playwright test ... under xvfb` acceptance criterion here", as in
// PRDs 780/787/788) is plain prose, not a checkbox line, so it must not
// trigger a false positive.
const INTERACTIVE_AC_CHECKBOX_RE = /^\s*-\s*\[[ xX]\]/;
const INTERACTIVE_AC_PATTERNS = [
  {
    id: 'interactive-xvfb',
    re: /\bxvfb-run\b/i,
    label: 'xvfb-run as a headless AC — cannot run under claude -p (see PRD_AUTHORING.md / 776+779 incidents)',
  },
  {
    id: 'interactive-electron-launch',
    re: /electron\.launch\b/i,
    label: 'playwright electron.launch as a headless AC — interactive tool-use rejection hangs the executor',
  },
  {
    id: 'interactive-playwright-test',
    re: /\bplaywright\s+test\b/i,
    label: '"playwright test" as a headless AC — GUI-rendering e2e cannot run headlessly',
  },
  {
    id: 'interactive-launch-app',
    re: /\blaunch(?:ing)?\s+the\s+app\b/i,
    label: '"launch the app" as a headless AC — interactive/GUI step',
  },
  {
    id: 'interactive-click-through',
    re: /\bclick(?:ing)?\s+through\b/i,
    label: '"click through" as a headless AC — interactive/GUI step',
  },
  {
    id: 'interactive-screenshot',
    re: /\bscreenshot/i,
    label: 'screenshot capture as a headless AC — interactive/GUI-rendering step',
  },
];

const { splitFrontmatter } = require('./lib/prdFrontmatter.cjs');
const { resolvePrdsDirs } = require('./lib/prdLocations.cjs');

// PRD 808: PRDS_DIR is now the LEGACY global dir — kept as a migration
// source and search fallback for not-yet-migrated files. Live PRDs resolve
// per-project via prdLocations.cjs's resolvePrdsDirs(). candidatePrdsDirs()
// aggregates both so the linter/archive/retag operations still see every
// PRD regardless of which dir it currently lives in.
function candidatePrdsDirs() {
  return [PRDS_DIR, ...resolvePrdsDirs()];
}

/** Search every candidate PRD dir for `<slug>.md`; returns the containing dir or null. */
async function findPrdDir(slug) {
  for (const dir of candidatePrdsDirs()) {
    try {
      await fsp.access(path.join(dir, `${slug}.md`));
      return dir;
    } catch { /* not here — try the next candidate dir */ }
  }
  return null;
}

/**
 * Lint a single PRD asynchronously. Returns { slug, findings: [...] }.
 * O(L) per PRD where L is line count of the file. Reads via fsp so kernel
 * I/O can overlap when called via Promise.all from lintAll().
 */
async function lintOneAsync(filePath) {
  const slug = path.basename(filePath, '.md');
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    return {
      slug,
      findings: [{ rule: 'read-error', line: 0, snippet: e?.message ?? 'read failed', severity: 'error' }],
    };
  }
  return lintParsed(slug, raw);
}

function lintParsed(slug, raw) {
  const findings = [];
  const { fm, body, fmLineCount } = splitFrontmatter(raw);

  // Required frontmatter keys.
  if (!fm.title || !fm.title.trim()) {
    findings.push({ rule: 'missing-title', line: 1, snippet: 'frontmatter "title" is required', severity: 'error' });
  }
  if (!fm.cwd || !fm.cwd.trim()) {
    findings.push({ rule: 'missing-cwd', line: 1, snippet: 'frontmatter "cwd" is required', severity: 'error' });
  } else {
    // cwd existence — only if it looks like an absolute path. ~ -> homedir.
    const candidate = expandHome(fm.cwd);
    if (path.isAbsolute(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
      } catch {
        findings.push({
          rule: 'cwd-missing',
          line: 1,
          snippet: `cwd does not exist on disk: ${fm.cwd}`,
          severity: 'error',
        });
      }
    }
  }
  if (fm.estimateMinutes === undefined || !String(fm.estimateMinutes).trim()) {
    findings.push({
      rule: 'missing-estimate',
      line: 1,
      snippet: 'frontmatter "estimateMinutes" is required',
      severity: 'warn',
    });
  } else {
    const v = Number(fm.estimateMinutes);
    if (!Number.isInteger(v) || v <= 0) {
      findings.push({
        rule: 'bad-estimate',
        line: 1,
        snippet: `"estimateMinutes" must be a positive integer (got: ${fm.estimateMinutes})`,
        severity: 'warn',
      });
    }
  }

  // Body line scan. Line numbers are 1-indexed and reflect the original file
  // (so fm lines are skipped). O(L).
  const bodyLines = body.split('\n');
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (!line) continue;
    for (const rule of LINE_RULES) {
      if (rule.re.test(line)) {
        findings.push({
          rule: rule.id,
          line: fmLineCount + i + 1,
          snippet: `${rule.label} — ${line.trim().slice(0, 80)}`,
          severity: rule.severity,
        });
      }
    }
    // Interactive-AC scan — only on checkbox-format AC lines, see the
    // pattern-list comment above for why prose mentions must not match.
    if (INTERACTIVE_AC_CHECKBOX_RE.test(line)) {
      for (const rule of INTERACTIVE_AC_PATTERNS) {
        if (rule.re.test(line)) {
          findings.push({
            rule: rule.id,
            line: fmLineCount + i + 1,
            snippet: `${rule.label} — ${line.trim().slice(0, 80)}`,
            severity: 'warn',
          });
        }
      }
    }
  }

  return { slug, findings };
}

/**
 * Lint all PRDs in PRDS_DIR. Returns { reports: [...], scannedAt }.
 * O(F × L). F is bounded by the actual prds/ contents (~200 today).
 *
 * Reads are issued in parallel via Promise.all so kernel-side I/O can
 * overlap. Each lintOneAsync is self-isolating (its own try/catch on read),
 * so Promise.all never rejects under normal use.
 */
async function lintAll() {
  const paths = [];
  for (const dir of candidatePrdsDirs()) {
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      paths.push(path.join(dir, name));
    }
  }
  const reports = await Promise.all(paths.map(async (filePath) => {
    try {
      return await lintOneAsync(filePath);
    } catch (e) {
      return {
        slug: path.basename(filePath, '.md'),
        findings: [{ rule: 'lint-error', line: 0, snippet: e?.message ?? 'lint failed', severity: 'error' }],
      };
    }
  }));
  return { reports, scannedAt: Date.now() };
}

// ────────────────────────────────────────────── archive

/**
 * Move <srcDir>/<slug>.md → <srcDir>/../prds-archived/<ISO>/<slug>.md.
 * Atomic rename. Path containment checks both source and destination.
 * Never deletes — always reversible from prds-archived/.
 */
/**
 * The archive directory a PRD found in `srcDir` belongs in: `prds-archived/`
 * SIBLING to its own `prds/`, which for a per-project PRD is
 * `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds-archived/`.
 *
 * PRD sources are per-project and per-Epic (CLAUDE.md's TAB → EPIC → PRD
 * model); the machine-level `~/.claude/session-manager/scheduled-plans/` tree
 * holds only run logs and PRD_AUTHORING.md. Archiving therefore has to follow
 * the source, not a fixed global constant — otherwise a manual archive yanks a
 * PRD out of its Epic and strands it in the retired global tree, splitting one
 * Epic's history across two locations (observed 2026-08-13 with
 * 1035-epic-worktree-ui-surfacing, whose three chain siblings sat in the Epic's
 * own prds-archived/ while it landed under scheduled-plans/). A PRD still in
 * the legacy flat `PRDS_DIR` resolves to `ROOT/prds-archived` here, which is
 * exactly the old behavior — so that case is unchanged.
 */
function archiveDirForSource(srcDir, ts) {
  return path.join(path.dirname(srcDir), 'prds-archived', ts);
}

async function archiveOne(slug, ts) {
  if (!SLUG_RE.test(slug)) return { ok: false, slug, error: 'invalid slug' };
  const srcDir = await findPrdDir(slug);
  if (!srcDir) return { ok: false, slug, error: 'not found in any PRDs dir' };
  const src = path.resolve(path.join(srcDir, `${slug}.md`));
  if (!src.startsWith(srcDir + path.sep)) return { ok: false, slug, error: 'path escape (src)' };
  // Destination is derived per-slug (not once for the whole batch): a single
  // archive call can span several projects/Epics, and each PRD has to land
  // beside its own source.
  const archiveDir = archiveDirForSource(srcDir, ts);
  const dst = path.resolve(path.join(archiveDir, `${slug}.md`));
  if (!dst.startsWith(path.resolve(archiveDir) + path.sep)) return { ok: false, slug, error: 'path escape (dst)' };
  try {
    await fsp.mkdir(archiveDir, { recursive: true });
    await fsp.rename(src, dst);
    return { ok: true, slug, archivedTo: dst };
  } catch (e) {
    return { ok: false, slug, error: e?.message ?? 'rename failed' };
  }
}

/**
 * Injected by index.cjs at registration time (see registerQueueOpsHandlers)
 * so a manual archive can retire any still-runnable queue job for the same
 * slug without queueOps.cjs importing scheduler.cjs (circular — scheduler.cjs
 * already requires queueOps.cjs). No-op until set; the auto-archive path
 * never needs it (selectAutoArchivable only ever selects already-completed
 * jobs).
 */
let retireCompletedSlugsFn = async () => {};

async function archiveMany(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return { ok: true, archived: 0, archivedTo: null, results: [] };
  }
  // One timestamp for the whole batch (so a multi-slug archive reads as one
  // event), but each slug's destination DIRECTORY is resolved from its own
  // source inside archiveOne — see archiveDirForSource. mkdir moved in there
  // for the same reason: there is no single batch-wide dir to pre-create.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  for (const slug of slugs) {
    results.push(await archiveOne(slug, ts));
  }
  const archived = results.filter((r) => r.ok).length;
  const archivedSlugs = results.filter((r) => r.ok).map((r) => r.slug);
  if (archivedSlugs.length > 0) {
    await retireCompletedSlugsFn(archivedSlugs).catch((e) => {
      logs.writeLine({ level: 'warn', scope: 'queueOps', message: 'archiveMany: retireCompletedSlugs failed', meta: { error: e?.message } });
    });
  }
  // archivedTo reports where the batch actually landed. With per-source
  // destinations that is only well-defined when every move agreed on one dir
  // (the common single-project case); a genuinely cross-project batch reports
  // null rather than naming one project's dir as if it covered them all.
  const dirs = new Set(results.filter((r) => r.ok).map((r) => path.dirname(r.archivedTo)));
  return { ok: true, archived, archivedTo: dirs.size === 1 ? [...dirs][0] : null, results };
}

// ────────────────────────────────────────────── auto-archive completed PRDs
//
// PRDS_DIR grows monotonically (738+ .md files, ~100% long-completed) because
// nothing ever moves a finished PRD's .md out of the live directory — every
// allocateParallelGroup scan, reconcile listing, and lint pass walks all of
// them. Once a job is durably 'completed' (queueHistory.cjs's same retention
// window has already judged it safe to leave jobs[]) and nothing still needs
// its file in place, move the .md to prds-archived/ alongside it.
//
// 'needs_review' and 'failed' PRDs are NEVER selected here — humans and the
// auto-fix loop (scheduler.cjs's healTargetForFix) still need those files on
// disk. Same fix-plan-protection regex as queueHistory.cjs's partitionJobs,
// duplicated (not shared) because the two modules intentionally stay
// decoupled — kept in sync by comment, same convention queueHistory.cjs uses
// against scheduler.cjs's healTargetForFix.

const FIX_PLAN_RE = /^\d+-fix-/;

function protectedByPendingFix(jobs) {
  const protectedSlugs = new Set();
  for (const j of jobs) {
    if (!j || !FIX_PLAN_RE.test(j.slug || '')) continue;
    if (j.status !== 'pending' && j.status !== 'running') continue;
    protectedSlugs.add(j.slug.replace(/^(\d+)-fix-/, '$1-'));
  }
  return protectedSlugs;
}

/**
 * Pure predicate: which slugs are safe to move to prds-archived/. O(n) over
 * `jobs`. A slug qualifies only when ALL of:
 *   - its job status is 'completed' (never 'needs_review'/'failed'/
 *     'pending'/'running' — the completed check alone also covers "not
 *     itself a pending/running job")
 *   - finishedAt parses and is older than retentionMs (default
 *     HISTORY_RETENTION_MS, the same constant queueHistory.cjs's
 *     partitionJobs uses — by the time a file is archive-eligible its queue
 *     row has already left jobs[] into history.jsonl)
 *   - no pending/running `NN-fix-<slug>` sibling still needs it in place
 */
function selectAutoArchivable(jobs, { nowMs, retentionMs } = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const retention = retentionMs ?? HISTORY_RETENTION_MS;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const protectedSlugs = protectedByPendingFix(list);

  const slugs = [];
  for (const j of list) {
    if (!j || !j.slug) continue;
    if (j.status !== 'completed') continue;
    const finishedMs = j.finishedAt ? Date.parse(j.finishedAt) : NaN;
    if (!Number.isFinite(finishedMs)) continue;
    if ((now - finishedMs) <= retention) continue;
    if (protectedSlugs.has(j.slug)) continue;
    slugs.push(j.slug);
  }
  return slugs;
}

/**
 * Selects and moves eligible completed PRDs' .md files to prds-archived/.
 * Reuses archiveMany (no second mover) so moves stay atomic fsp.rename with
 * the same path-containment. No-op (without touching disk) when
 * SM_PRD_AUTOARCHIVE_DISABLE=1. Each successful move is logged one line
 * (slug -> dest).
 */
async function autoArchiveCompleted(state, { nowMs } = {}) {
  if (process.env.SM_PRD_AUTOARCHIVE_DISABLE === '1') {
    return { ok: true, archived: 0, archivedTo: null, results: [], skipped: 'disabled' };
  }
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const slugs = selectAutoArchivable(jobs, { nowMs });
  if (slugs.length === 0) {
    return { ok: true, archived: 0, archivedTo: null, results: [] };
  }
  const result = await archiveMany(slugs);
  for (const r of result.results) {
    if (r.ok) {
      logs.writeLine({
        level: 'info',
        scope: 'queueOps',
        message: `auto-archived completed PRD: ${r.slug} -> ${r.archivedTo}`,
        meta: { slug: r.slug, dest: r.archivedTo },
      });
    }
  }
  return result;
}

// ────────────────────────────────────────────── retag

/**
 * Re-serialize the frontmatter of one PRD, optionally rewriting parallelGroup
 * and/or estimateMinutes. If parallelGroup changes AND the slug has an NN-
 * prefix, the file is renamed to reflect the new prefix (the old NN is
 * stripped and replaced; if no prefix exists, one is prepended).
 *
 * Returns { ok, slug, newSlug, before, after, error? }.
 *
 * Mutates only the keys explicitly passed — preserves all other frontmatter
 * lines verbatim (line-level replace, not a full YAML reparse). Reversible
 * via retag-log.jsonl.
 */
async function retagOne({ slug, parallelGroup, estimateMinutes }) {
  if (!SLUG_RE.test(slug)) return { ok: false, slug, error: 'invalid slug' };
  const dir = await findPrdDir(slug);
  if (!dir) return { ok: false, slug, error: 'not found in any PRDs dir' };
  const src = path.resolve(path.join(dir, `${slug}.md`));
  if (!src.startsWith(dir + path.sep)) return { ok: false, slug, error: 'path escape' };

  let raw;
  try {
    raw = await fsp.readFile(src, 'utf8');
  } catch (e) {
    return { ok: false, slug, error: `read failed: ${e?.message}` };
  }
  if (!raw.startsWith('---\n')) {
    return { ok: false, slug, error: 'no frontmatter to retag' };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { ok: false, slug, error: 'unterminated frontmatter' };

  const fmRaw = raw.slice(4, end);
  const bodyTail = raw.slice(end); // includes "\n---..."
  const fmLines = fmRaw.split('\n');

  // Snapshot before-values for the retag log.
  const before = {};
  const newFmLines = [];
  const seen = { parallelGroup: false, estimateMinutes: false };
  for (const line of fmLines) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
    if (!m) {
      newFmLines.push(line);
      continue;
    }
    const key = m[1];
    if (key === 'parallelGroup' && parallelGroup !== undefined) {
      before.parallelGroup = m[2];
      newFmLines.push(`parallelGroup: ${parallelGroup}`);
      seen.parallelGroup = true;
    } else if (key === 'estimateMinutes' && estimateMinutes !== undefined) {
      before.estimateMinutes = m[2];
      newFmLines.push(`estimateMinutes: ${estimateMinutes}`);
      seen.estimateMinutes = true;
    } else {
      newFmLines.push(line);
    }
  }
  if (parallelGroup !== undefined && !seen.parallelGroup) {
    newFmLines.push(`parallelGroup: ${parallelGroup}`);
  }
  if (estimateMinutes !== undefined && !seen.estimateMinutes) {
    newFmLines.push(`estimateMinutes: ${estimateMinutes}`);
  }

  const newRaw = `---\n${newFmLines.join('\n')}${bodyTail}`;

  // Decide whether to rename the file. NN-kebab pattern only.
  let newSlug = slug;
  if (parallelGroup !== undefined) {
    const m = slug.match(/^(\d+)-(.+)$/);
    if (m) {
      newSlug = `${parallelGroup}-${m[2]}`;
    } else {
      // Slug doesn't have NN- prefix — prepend one.
      newSlug = `${parallelGroup}-${slug}`;
    }
    if (!SLUG_RE.test(newSlug)) return { ok: false, slug, error: 'new slug would be invalid' };
  }
  const dst = path.resolve(path.join(dir, `${newSlug}.md`));
  if (!dst.startsWith(dir + path.sep)) return { ok: false, slug, error: 'new path escape' };

  // Atomic write via shared helper. If slug changed, write at the new path
  // and unlink the old slug.
  try {
    await config.writeTextAtomic(dst, newRaw, { writer: 'scheduler' });
    if (dst !== src) {
      try { await fsp.unlink(src); } catch { /* if src is already same as dst (race), fine */ }
    }
  } catch (e) {
    return { ok: false, slug, error: `write failed: ${e?.message}` };
  }

  const after = {};
  if (parallelGroup !== undefined) after.parallelGroup = String(parallelGroup);
  if (estimateMinutes !== undefined) after.estimateMinutes = String(estimateMinutes);
  if (newSlug !== slug) {
    before.slug = slug;
    after.slug = newSlug;
  }
  return { ok: true, slug, newSlug, before, after };
}

async function appendRetagLog(entries) {
  if (entries.length === 0) return;
  try {
    await fsp.mkdir(ROOT, { recursive: true });
    const lines = entries.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n').join('');
    await fsp.appendFile(RETAG_LOG, lines);
  } catch (e) {
    logs.writeLine({ level: 'warn', scope: 'queueOps', message: 'retag log append failed', meta: { error: e?.message } });
  }
}

async function retagMany(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, retagged: 0, results: [] };
  }
  const results = [];
  for (const item of items) {
    results.push(await retagOne(item));
  }
  await appendRetagLog(results.filter((r) => r.ok));
  const retagged = results.filter((r) => r.ok).length;
  return { ok: true, retagged, results };
}

// ────────────────────────────────────────────── IPC registration

function registerQueueOpsHandlers({ retireCompletedSlugs } = {}) {
  if (typeof retireCompletedSlugs === 'function') {
    retireCompletedSlugsFn = retireCompletedSlugs;
  }
  ipcMain.handle('schedule:lint-queue', async () => {
    return lintAll();
  });

  ipcMain.handle('schedule:archive-prd', async (_e, payload) => {
    let parsed;
    try { parsed = schemas.scheduleArchivePrd.parse(payload); }
    catch (e) { return { ok: false, error: e?.message ?? 'invalid payload' }; }
    return archiveMany(parsed.slugs);
  });

  ipcMain.handle('schedule:retag-prd', async (_e, payload) => {
    let parsed;
    try { parsed = schemas.scheduleRetagPrd.parse(payload); }
    catch (e) { return { ok: false, error: e?.message ?? 'invalid payload' }; }
    return retagMany(parsed.items);
  });
}

module.exports = {
  registerQueueOpsHandlers,
  // Exposed for tests / future direct calls.
  lintAll,
  lintOneAsync,
  archiveMany,
  selectAutoArchivable,
  autoArchiveCompleted,
  retagMany,
  PRDS_DIR,
  PRDS_ARCHIVE_DIR,
  archiveDirForSource,
  candidatePrdsDirs,
  findPrdDir,
};
