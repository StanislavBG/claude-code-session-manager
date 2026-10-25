/**
 * listPrdsTsArchive.test.cjs — listPrds sees PRDs archived into
 * prds-archived/<ISO-ts>/ (one level only) and normalizes filter.cwd.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/listPrdsTsArchive.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let tmpHome;
let originalHome;
let scheduler;
let proj;

function prdText(cwd, title) {
  return `---\ntitle: ${title}\ncwd: ${cwd}\nestimateMinutes: 10\nsourcePromptId: ep1\ncreatedVia: scheduler-api\nissuedAt: 2026-09-25T00:00:00.000Z\n---\n\n# Goal\n\nSomething.\n`;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-listprds-ts-home-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME`);
  }
  // Project lives under the temp HOME so a `~/...` cwd resolves to it.
  proj = fs.mkdtempSync(path.join(tmpHome, 'tsproj-'));
  const epicRoot = path.join(proj, 'session-manager-operations', 'scheduler', 'epics', 'ep1');
  fs.mkdirSync(path.join(epicRoot, 'prds'), { recursive: true });
  const tsDir = path.join(epicRoot, 'prds-archived', '2026-10-24T19-04-02-419Z');
  fs.mkdirSync(path.join(tsDir, 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(tsDir, '163-attack-scorecard.md'), prdText(proj, 'Attack scorecard'), 'utf8');
  fs.writeFileSync(path.join(tsDir, 'deeper', '170-too-deep.md'), prdText(proj, 'Too deep'), 'utf8');
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-${path.basename(proj)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), `${JSON.stringify({ cwd: proj })}\n`);
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function slugsFor(cwd) {
  const res = await scheduler.remote.listPrds({ cwd, fields: 'full', limit: Number.MAX_SAFE_INTEGER });
  return res.prds;
}

test('PRD one level under prds-archived/<ts>/ is listed as archived; two levels deep is not', async () => {
  const prds = await slugsFor(proj);
  const hit = prds.find((p) => p.slug === '163-attack-scorecard');
  expect(hit).toBeTruthy();
  expect(hit.archived).toBe(true);
  expect(prds.find((p) => p.slug === 'too-deep')).toBeUndefined();
});

test('machine-wide listing also includes the ts-archived PRD', async () => {
  const res = await scheduler.remote.listPrds({ fields: 'full', limit: Number.MAX_SAFE_INTEGER });
  expect(res.prds.map((p) => p.slug)).toContain('163-attack-scorecard');
});

test('cwd filter is normalized: tilde, trailing slash, worktree path', async () => {
  const tilde = `~/${path.relative(tmpHome, proj)}`;
  for (const c of [tilde, `${proj}/`]) {
    expect((await slugsFor(c)).map((p) => p.slug)).toContain('163-attack-scorecard');
  }
  // Epic worktree path -> main checkout (via projectRootOf).
  const git = (...args) => execFileSync('git', ['-C', proj, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' });
  git('init', '-q');
  fs.writeFileSync(path.join(proj, 'README.md'), 'x');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  const wt = path.join(tmpHome, 'wt-sm-epic-ep1');
  git('worktree', 'add', '-q', '-b', 'sm-epic/ep1', wt);
  expect((await slugsFor(wt)).map((p) => p.slug)).toContain('163-attack-scorecard');
});

test('createPrd accepts dependsOn naming a ts-archived slug (and still rejects unknown ones)', async () => {
  const { createPrd } = require('../lib/prd/prdCreate.cjs');
  const base = {
    cwd: proj, title: 'Next step', sourcePromptId: 'ep1', estimateMinutes: 10,
    goal: 'x', acceptanceCriteria: ['x'], files: ['a.txt'], gate: ['true'],
  };
  const ok = await createPrd({ ...base, dependsOn: ['attack-scorecard'] }, scheduler.remote);
  expect(String(ok.error ?? '')).not.toMatch(/does not resolve/);
  const bad = await createPrd({ ...base, title: 'Other step', dependsOn: ['no-such-prd'] }, scheduler.remote);
  expect(String(bad.error ?? '')).toMatch(/does not resolve/);
});
