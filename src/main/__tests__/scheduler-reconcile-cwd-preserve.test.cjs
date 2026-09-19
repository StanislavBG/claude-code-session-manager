/**
 * scheduler-reconcile-cwd-preserve.test.cjs — regression test for the
 * data-loss bug found while chasing PRD 1218's test:unit gate: reconcile()
 * rebuilt a queue row's `cwd` unconditionally from its PRD's own
 * frontmatter (`cwd: p.cwd`) at all three of its row-construction sites. A
 * PRD file with no `cwd:` frontmatter key — every hand-written or legacy PRD,
 * and every fixture in this test suite before this fix — parses to
 * `p.cwd === undefined`, which nulled the row's real, already-correct `cwd`.
 * queueStore.writeSplit's `job.cwd || defaultCwd` bucketing then relocated
 * the row into schedulerBatch.cjs's DEFAULT_PROJECT_CWD shard
 * (`~/Projects/session-manager`) — the WRONG project — while the row's own
 * project's shard was rewritten without it. A PRD's frontmatter `cwd` must
 * REFINE a row's existing `cwd`, never erase one.
 *
 * Covers the normal refresh path (an existing row matched to its PRD) and
 * the fresh-discovery path (a PRD with no prior row, falling back to the
 * project root it was actually found under via
 * prdLocations.deriveProjectCwdFromPrdPath rather than nulling to
 * DEFAULT_PROJECT_CWD).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reconcile-cwd-preserve.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let reconcile;
let DEFAULT_PROJECT_CWD;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-cwd-preserve-'));
  process.env.HOME = tmpHome;
  ({ reconcile } = require('../scheduler.cjs'));
  ({ DEFAULT_PROJECT_CWD } = require('../lib/schedulerBatch.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// allProjectCwds()/activeProjectCwds() (queueStore.cjs's stateCwds) discover
// project cwds by scanning ~/.claude/projects/*/*.jsonl for a `cwd` field —
// same pattern as scheduler-reap-dead-running-jobs.test.cjs and friends.
function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

test('reconcile() never nulls an existing row\'s cwd because its PRD has no cwd: frontmatter', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-cwd-preserve-project-'));
  registerActiveProject(projectCwd);

  const slug = `1218-cwd-preserve-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  // Deliberately NO `cwd:` frontmatter key — the exact shape of every
  // hand-written or legacy PRD that triggered the bug.
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), '# Goal\n\nNo cwd frontmatter here.\n', 'utf8');

  const job = { slug, title: 'x', cwd: projectCwd, status: 'pending' };
  const state = { jobs: [job] };

  await reconcile(state);

  const row = state.jobs.find((j) => j.slug === slug);
  expect(row).toBeDefined();
  expect(row.cwd).toBe(projectCwd);
  expect(row.cwd).not.toBe(DEFAULT_PROJECT_CWD);
});

test('reconcile() gives a freshly-discovered, frontmatter-less PRD the project root it was actually found under, never DEFAULT_PROJECT_CWD', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-cwd-preserve-fresh-'));
  registerActiveProject(projectCwd);

  const slug = `1218-cwd-preserve-fresh-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), '# Goal\n\nNo cwd frontmatter here either.\n', 'utf8');

  // No prior row at all — this PRD is discovered fresh by reconcile()'s own
  // onDisk scan, not handed in via `state.jobs`.
  const state = { jobs: [] };

  await reconcile(state);

  const row = state.jobs.find((j) => j.slug === slug);
  expect(row).toBeDefined();
  expect(row.cwd).toBe(projectCwd);
  expect(row.cwd).not.toBe(DEFAULT_PROJECT_CWD);
});
