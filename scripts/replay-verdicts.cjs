#!/usr/bin/env node
/**
 * replay-verdicts.cjs — dev-only, read-only replay of historical verdict
 * sidecars against the new ground-truth-outranks-heuristics rule in
 * runVerify.cjs (exit 0 + a commit landed this run + no explicit
 * SCHEDULER_VERDICT: FAIL demotes transcript_errors/verify_unavailable to
 * annotations).
 *
 * Scans `~/.claude/session-manager/scheduled-plans/runs/*` (the same RUNS_DIR
 * scheduler.cjs writes to — shared across every project on this machine) for
 * `<slug>.verdicts.json` sidecars whose original verdict was a park
 * (verdict transcript_errors|verify_unavailable, downgradeTo needs_review),
 * re-runs the REAL `verifyRun()` from src/main/runVerify.cjs against each
 * one's own `<slug>.log` with the historical `<slug>.outcome.json`'s
 * `landedCommit`/`exitCode` threaded in as `jobLandedCommitThisRun`/
 * `exitCode`, and counts how many would now come back `clean`.
 *
 * NEVER writes into ~/.claude/session-manager: verifyRun's only side effect
 * is writing `<runDir>/<slug>.verdicts.json`, so each candidate's `.log` is
 * copied into a disposable scratch dir first and verifyRun is pointed at
 * that copy — the real run dirs are opened read-only and never touched.
 *
 * Usage:
 *   node scripts/replay-verdicts.cjs --since 2026-08-01 --dry-run
 *
 * --dry-run is accepted (and always effectively true — this script never
 * writes to the real runs dir regardless) so the documented invocation is
 * self-describing about the safety guarantee. --since filters run dirs by
 * their timestamp-derived directory name; omit it to scan every run dir.
 * RUNS_DIR is shared by every project scheduled on this machine, so by
 * default this scopes to the project it's invoked from (`process.cwd()`,
 * matched against each candidate's own `meta.cwd`) — pass --all-projects to
 * scan every project's history instead.
 *
 * Deliberately excluded from package.json's `files` — dev-only tooling for
 * this repo's own scheduler operators, not a shipped CLI.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyRun } = require('../src/main/runVerify.cjs');

const RUNS_DIR = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'runs');

const PARK_VERDICTS = new Set(['transcript_errors', 'verify_unavailable']);

function parseArgs(argv) {
  let since = null;
  let dryRun = false;
  let cwdFilter = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') { since = argv[++i] ?? null; }
    else if (argv[i] === '--dry-run') { dryRun = true; }
    else if (argv[i] === '--all-projects') { cwdFilter = null; }
  }
  return { since, dryRun, cwdFilter };
}

/** Run-dir names are ISO timestamps with `:`/`.` replaced by `-`, e.g. `2026-09-13T21-52-51-192Z`. */
function runDirTimeMs(dirName) {
  const m = dirName.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function makeScratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replay-verdicts-'));
}

/**
 * Best-effort, LOCAL-refs-only approximation of scheduler.cjs's
 * `committedInWindow` (`git log --all --since --until`), used to widen the
 * commit-evidence signal beyond `outcome.landedCommit` for older runs that
 * predate that field. Cannot safely `require('./scheduler.cjs')` from a
 * standalone node process (it calls `require('electron')` and registers
 * ipcMain handlers at module load), so this re-derives just the read-only
 * git-log half here rather than the network-fetching half — bounded per call
 * so a batch replay across many run dirs/repos stays inside the gate's
 * timeout budget. Never throws: any git/path error resolves false.
 */
function approximateCommittedDuringRun(cwd, startedAtMs, finishedAtMs) {
  if (!cwd || !startedAtMs) return false;
  try {
    const since = new Date(startedAtMs).toISOString();
    const until = new Date((finishedAtMs ?? Date.now()) + 60_000).toISOString();
    const out = execFileSync(
      'git',
      ['-C', cwd, 'log', '--all', '--format=%H', `--since=${since}`, `--until=${until}`],
      { timeout: 8_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy `<slug>.log` from the real run dir into a fresh scratch dir and write
 * a minimal, dependency-free stub PRD, so verifyRun's only write
 * (`<slug>.verdicts.json`) lands in the scratch dir instead of the real one.
 */
function stageCandidate(runDir, slug) {
  const scratch = makeScratchDir();
  const realLog = path.join(runDir, `${slug}.log`);
  fs.copyFileSync(realLog, path.join(scratch, `${slug}.log`));
  const prdPath = path.join(scratch, `${slug}.md`);
  fs.writeFileSync(prdPath, '---\ntitle: replay stub\nestimateMinutes: 1\n---\n# replay stub\n');
  return { scratch, prdPath };
}

async function main() {
  const { since, dryRun, cwdFilter } = parseArgs(process.argv.slice(2));
  const sinceMs = since ? new Date(since).getTime() : null;
  if (since && !Number.isFinite(sinceMs)) {
    console.error(`HALT: --since "${since}" did not parse as a date`);
    process.exit(1);
  }
  if (!dryRun) {
    console.log('[replay-verdicts] note: --dry-run not passed, but this script never writes to the real runs dir regardless.');
  }

  let dirNames;
  try {
    dirNames = fs.readdirSync(RUNS_DIR);
  } catch (e) {
    console.error(`HALT: cannot read RUNS_DIR ${RUNS_DIR}: ${e.message}`);
    process.exit(1);
  }

  const runDirs = dirNames
    .map((name) => ({ name, ms: runDirTimeMs(name) }))
    .filter((d) => d.ms !== null && (sinceMs === null || d.ms >= sinceMs))
    .sort((a, b) => a.ms - b.ms);

  let scanned = 0;
  let wouldFlip = 0;
  const byVerdict = { transcript_errors: { scanned: 0, flipped: 0 }, verify_unavailable: { scanned: 0, flipped: 0 } };
  const flippedSlugs = [];

  for (const { name: dirName } of runDirs) {
    const runDir = path.join(RUNS_DIR, dirName);
    let entries;
    try { entries = fs.readdirSync(runDir); } catch { continue; }

    for (const entry of entries) {
      if (!entry.endsWith('.verdicts.json')) continue;
      const slug = entry.slice(0, -'.verdicts.json'.length);
      const verdicts = readJsonSafe(path.join(runDir, entry));
      if (!verdicts || !PARK_VERDICTS.has(verdicts.verdict) || verdicts.downgradeTo !== 'needs_review') continue;

      const logPath = path.join(runDir, `${slug}.log`);
      if (!fs.existsSync(logPath)) continue; // sidecar with no matching log — skip, can't replay

      const meta = readJsonSafe(path.join(runDir, `${slug}.meta.json`));
      const cwd = meta?.cwd ?? process.cwd();
      // RUNS_DIR is shared by every project scheduled on this machine (see
      // this script's header) — scope to the project it's run from by
      // default so the count matches that project's own measured history,
      // not an unrelated sibling repo's. --all-projects opts out.
      if (cwdFilter && path.resolve(cwd) !== path.resolve(cwdFilter)) continue;
      const outcome = readJsonSafe(path.join(runDir, `${slug}.outcome.json`));
      const exitCode = meta?.exitCode ?? outcome?.exitCode ?? null;
      const jobLandedCommitThisRun = outcome?.landedCommit ?? null;
      const committedDuringRun = jobLandedCommitThisRun
        ? false // already-attributed evidence — skip the extra git call
        : approximateCommittedDuringRun(cwd, meta?.startedAt, meta?.finishedAt);

      scanned++;
      byVerdict[verdicts.verdict].scanned++;

      const { scratch, prdPath } = stageCandidate(runDir, slug);
      let replayed;
      try {
        replayed = await verifyRun({
          runDir: scratch,
          prdPath,
          queueEntry: { slug, status: 'needs_review', cwd, dependsOn: [] },
          allJobs: [],
          committedDuringRun,
          jobLandedCommitThisRun,
          exitCode,
        });
      } catch (e) {
        replayed = { verdict: `replay_error: ${e.message}` };
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }

      if (replayed.verdict === 'clean') {
        wouldFlip++;
        byVerdict[verdicts.verdict].flipped++;
        flippedSlugs.push(`${dirName}/${slug}`);
      }
    }
  }

  console.log(`[replay-verdicts] scope: ${cwdFilter ?? 'ALL PROJECTS'}${since ? `, since ${since}` : ''}`);
  console.log(`[replay-verdicts] scanned run dirs: ${runDirs.length}${since ? ` (since ${since})` : ''}`);
  console.log(`[replay-verdicts] historical parks scanned: ${scanned}`);
  console.log(`[replay-verdicts]   transcript_errors: ${byVerdict.transcript_errors.scanned} scanned, ${byVerdict.transcript_errors.flipped} would flip to clean`);
  console.log(`[replay-verdicts]   verify_unavailable: ${byVerdict.verify_unavailable.scanned} scanned, ${byVerdict.verify_unavailable.flipped} would flip to clean`);
  console.log(`[replay-verdicts] TOTAL would-be-clean under the new rule: ${wouldFlip}`);
  if (flippedSlugs.length) {
    console.log('[replay-verdicts] flipped:');
    for (const s of flippedSlugs) console.log(`  - ${s}`);
  }
}

main().catch((e) => {
  console.error(`HALT: replay-verdicts crashed: ${e?.stack ?? e}`);
  process.exit(1);
});
