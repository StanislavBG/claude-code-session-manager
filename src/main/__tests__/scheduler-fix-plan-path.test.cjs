/**
 * scheduler-fix-plan-path.test.cjs — regression test for the self-heal
 * dead-letter bug: spawnInvestigation used to write every auto-fix plan into
 * the RETIRED flat `<cwd>/session-manager-operations/scheduler/prds/` dir
 * (prdDirForCwd), which reconcile()'s consolidateAllFlatPrds sweeps BEFORE
 * scanning for queue rows — so a freshly-authored fix plan (no queue row yet
 * by definition) was archived into `prds-archived/` on the very next pass
 * and never enqueued. Confirmed live in starry-night-ships: job
 * 105-arena-perf-fences produced a valid fix plan that landed in
 * prds-archived/ having never appeared in queue.json or history.jsonl.
 *
 * The fix: resolveFixPlanPath resolves the write dir from the ORIGINAL job's
 * live PRD location (findPrdDir, via resolveVerifyPrdPath) — normally the
 * originating Epic's own `epics/<epicId>/prds/`, which consolidateFlatPrds
 * never touches — falling back to the flat dir only when the original can't
 * be found live anywhere on disk.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-fix-plan-path.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let resolveFixPlanPath;
let PRDS_DIR;
let consolidateFlatPrds;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fix-plan-path-'));
  process.env.HOME = tmpHome;

  // Load AFTER HOME is stubbed — scheduler.cjs snapshots os.homedir() into
  // PRDS_DIR at module load, not lazily (see scheduler-find-prd-dir.test.cjs).
  ({ resolveFixPlanPath, PRDS_DIR } = require('../scheduler.cjs'));
  ({ consolidateFlatPrds } = require('../lib/prdMigration.cjs'));

  if (!PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }

  // allProjectCwds()/activeProjectCwds() (consumed by findPrdDir's candidate
  // search) discover project cwds by scanning ~/.claude/projects/*/*.jsonl
  // for a `cwd` field — fake one project transcript pointing at the real
  // on-disk cwd used below (mirrors scheduler-verify-prd-path.test.cjs).
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const projDir = path.join(projectsDir, 'fake-fix-plan-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'session.jsonl'),
    `${JSON.stringify({ cwd: projectCwd() })}\n`,
    'utf8',
  );
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function projectCwd() {
  return path.join(tmpHome, 'fix-plan-project-cwd');
}

test('resolveFixPlanPath resolves the fix plan into the SAME Epic-scoped dir as the original PRD, and it survives consolidateFlatPrds', async () => {
  const cwd = projectCwd();
  const epicId = 'test-epic-arena-perf';
  const slug = `105-arena-perf-fences-${process.pid}`;
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), '---\ntitle: arena perf fences\n---\n\n# Goal\n\ntest\n', 'utf8');

  const failedJob = { slug, cwd, parallelGroup: 5 };
  const resolved = await resolveFixPlanPath(failedJob);

  const expectedFixSlug = '05-fix-arena-perf-fences-' + process.pid;
  expect(resolved.fixSlug).toBe(expectedFixSlug);
  expect(resolved.livePrdDir).toBe(prdsDir);
  expect(resolved.fixPath).toBe(path.join(prdsDir, `${expectedFixSlug}.md`));

  // A fix plan written at the resolved path must survive a consolidateFlatPrds
  // pass over the SAME project cwd — the sweep only ever touches the flat dir.
  fs.writeFileSync(resolved.fixPath, `---\ntitle: Fix: arena perf fences\ncwd: ${cwd}\nparallelGroup: 5\nestimateMinutes: 30\n---\n\nfix body\n`, 'utf8');
  await consolidateFlatPrds(cwd);
  expect(fs.existsSync(resolved.fixPath)).toBe(true);
});

test('resolveFixPlanPath falls back to the flat dir when the original PRD cannot be found live anywhere on disk', async () => {
  const cwd = path.join(tmpHome, 'fix-plan-project-cwd-missing');
  const slug = `999-nonexistent-${process.pid}`;
  const failedJob = { slug, cwd, parallelGroup: 3 };

  const resolved = await resolveFixPlanPath(failedJob);

  expect(resolved.livePrdDir).toBe(null);
  const flatDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'prds');
  expect(resolved.fixPath).toBe(path.join(flatDir, `${resolved.fixSlug}.md`));
});

test('the OLD flat-dir path (regression guard) does NOT survive consolidateFlatPrds — proves the bug this fix addresses', async () => {
  const cwd = path.join(tmpHome, 'fix-plan-project-cwd-old-behavior');
  const flatDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(flatDir, { recursive: true });
  const oldFixPath = path.join(flatDir, '07-fix-old-behavior.md');
  fs.writeFileSync(oldFixPath, `---\ntitle: Fix: old behavior\ncwd: ${cwd}\nparallelGroup: 7\nestimateMinutes: 30\n---\n\nfix body\n`, 'utf8');

  // No queue.json at all — the file has no live queue row, exactly the
  // freshly-authored-fix-plan situation the bug hit.
  await consolidateFlatPrds(cwd);

  expect(fs.existsSync(oldFixPath)).toBe(false);
  expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'scheduler', 'prds-archived', '07-fix-old-behavior.md'))).toBe(true);
});
