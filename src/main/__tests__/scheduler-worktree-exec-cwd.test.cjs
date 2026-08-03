/**
 * scheduler-worktree-exec-cwd.test.cjs — PRD 994, LOAD-BEARING acceptance
 * criterion: when a job is isolated into a worktree, its PRD file, queue
 * state, and run logs must still resolve to the MAIN tree, never the
 * worktree — `session-manager-operations/` is resolved from a `cwd` param
 * (lib/prdLocations.cjs), so a naive cwd swap would give the job a
 * different, empty ops root and orphan its own PRD.
 *
 * Drives executeJob's real `execCwd` parameter (the 5th arg scheduler.cjs
 * passes when a worktree was created) with a stub `claude` binary, proving:
 *   1. the child process's OWN cwd is the worktree dir (execCwd) — verified
 *      by having the stub write a marker file to `process.cwd()`;
 *   2. the PRD source is still found via job.cwd (the main tree) even though
 *      the worktree dir has no PRD file in it at all;
 *   3. the run's meta.json still records job.cwd, not the worktree dir.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-worktree-exec-cwd.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let executeJob;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-worktree-execcwd-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../scheduler.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

// Stub `claude` binary: writes a marker file into its OWN process.cwd() (proving
// where it actually ran), captures the '-p' prompt, then emits a stream-json
// success result and exits 0.
function writeClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'ran-here.marker'), 'yes', 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

test('executeJob spawns the child in execCwd (worktree) while resolving the PRD from job.cwd (main tree)', async () => {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-worktree-main-'));
  const worktreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-worktree-exec-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-worktree-run-'));

  try {
    const slug = `994-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    const bodyText = 'Do the isolated-worktree thing.';
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), bodyText, 'utf8');

    process.env.SM_CLAUDE_BIN = writeClaudeStub();

    const job = { slug, cwd: mainCwd };
    const result = await executeJob(job, runDir, mainCwd, () => Promise.resolve(), worktreeCwd);

    expect(result.exitCode).toBe(0);

    // 1. The child process really ran with cwd = worktreeCwd, not mainCwd.
    expect(fs.existsSync(path.join(worktreeCwd, 'ran-here.marker'))).toBe(true);
    expect(fs.existsSync(path.join(mainCwd, 'ran-here.marker'))).toBe(false);

    // 2. The PRD source itself is untouched — resolved via job.cwd, not execCwd.
    const onDiskPrd = fs.readFileSync(path.join(prdsDir, `${slug}.md`), 'utf8');
    expect(onDiskPrd).toBe(bodyText);

    // 3. The run's meta.json records job.cwd (the main tree), not the worktree.
    const metaPath = path.join(runDir, `${slug}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.cwd).toBe(mainCwd);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(worktreeCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('executeJob falls back to job.cwd for the spawn cwd when no execCwd is supplied (unchanged behaviour)', async () => {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-worktree-fallback-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-worktree-run2-'));
  try {
    const slug = `994-test-fallback-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'no worktree here', 'utf8');
    process.env.SM_CLAUDE_BIN = writeClaudeStub();

    const job = { slug, cwd: mainCwd };
    const result = await executeJob(job, runDir, mainCwd, () => Promise.resolve());

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(mainCwd, 'ran-here.marker'))).toBe(true);
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
