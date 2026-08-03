/**
 * prdMigration.test.cjs — unit tests for the one-time PRD-relocation
 * migration (PRD 808): moves legacy-global PRD .md files into their own
 * project's `<cwd>/session-manager-operations/scheduler/prds/`, based on
 * each file's frontmatter `cwd`.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdMigration.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { migratePrds } = require('../lib/prdMigration.cjs');
const { resolvePrdWriteDir } = require('../lib/prdLocations.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkLegacyDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdmigration-legacy-'));
  tmpDirs.push(dir);
  return dir;
}

async function mkProjectCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdmigration-cwd-'));
  tmpDirs.push(dir);
  return dir;
}

test('migratePrds moves a PRD whose frontmatter cwd resolves to an on-disk project', async () => {
  const legacyDir = await mkLegacyDir();
  const projectCwd = await mkProjectCwd();
  const body = `---\ntitle: Do the thing\ncwd: ${projectCwd}\nestimateMinutes: 15\n---\n\n# Goal\n\nDo it.\n`;
  await fsp.writeFile(path.join(legacyDir, '01-do-thing.md'), body, 'utf8');

  const result = await migratePrds(legacyDir);

  expect(result.moved).toBe(1);
  expect(result.unresolved).toEqual([]);
  expect(fs.existsSync(path.join(legacyDir, '01-do-thing.md'))).toBe(false);
  const dest = path.join(resolvePrdWriteDir(projectCwd), '01-do-thing.md');
  expect(fs.existsSync(dest)).toBe(true);
  expect(await fsp.readFile(dest, 'utf8')).toBe(body);
});

test('migratePrds is idempotent — a second run over an already-migrated dir is a no-op', async () => {
  const legacyDir = await mkLegacyDir();
  const projectCwd = await mkProjectCwd();
  const body = `---\ntitle: Do the thing\ncwd: ${projectCwd}\nestimateMinutes: 15\n---\n\nBody.\n`;
  await fsp.writeFile(path.join(legacyDir, '02-do-thing.md'), body, 'utf8');

  await migratePrds(legacyDir);
  const second = await migratePrds(legacyDir);

  expect(second.moved).toBe(0);
  expect(second.unresolved).toEqual([]);
});

test('migratePrds leaves a file with no cwd in frontmatter in place and reports it unresolved', async () => {
  const legacyDir = await mkLegacyDir();
  const body = `---\ntitle: No cwd here\nestimateMinutes: 15\n---\n\nBody.\n`;
  await fsp.writeFile(path.join(legacyDir, '03-no-cwd.md'), body, 'utf8');

  const result = await migratePrds(legacyDir);

  expect(result.moved).toBe(0);
  expect(result.unresolved).toEqual([{ file: '03-no-cwd.md', reason: 'no cwd in frontmatter' }]);
  expect(fs.existsSync(path.join(legacyDir, '03-no-cwd.md'))).toBe(true);
});

test('migratePrds leaves a file whose cwd does not exist on disk in place and reports it unresolved', async () => {
  const legacyDir = await mkLegacyDir();
  const body = `---\ntitle: Bad cwd\ncwd: /this/path/does/not/exist/anywhere\nestimateMinutes: 15\n---\n\nBody.\n`;
  await fsp.writeFile(path.join(legacyDir, '04-bad-cwd.md'), body, 'utf8');

  const result = await migratePrds(legacyDir);

  expect(result.moved).toBe(0);
  expect(result.unresolved).toHaveLength(1);
  expect(result.unresolved[0].file).toBe('04-bad-cwd.md');
  expect(fs.existsSync(path.join(legacyDir, '04-bad-cwd.md'))).toBe(true);
});

test('migratePrds ignores non-.md and dotfiles, and no-ops on a missing legacy dir', async () => {
  const legacyDir = await mkLegacyDir();
  await fsp.writeFile(path.join(legacyDir, 'notes.txt'), 'not a prd', 'utf8');
  await fsp.writeFile(path.join(legacyDir, '.hidden.md'), 'ignored', 'utf8');

  const result = await migratePrds(legacyDir);
  expect(result).toEqual({ moved: 0, skipped: 0, unresolved: [] });

  const missing = await migratePrds(path.join(legacyDir, 'nope'));
  expect(missing).toEqual({ moved: 0, skipped: 0, unresolved: [] });
});

test('migratePrds expands a tilde-prefixed cwd and moves the file', async () => {
  const legacyDir = await mkLegacyDir();
  // Deliberately rooted under the REAL os.homedir() (not os.tmpdir()) — the
  // assertion under test is tilde-expansion relative to the actual home dir,
  // so a real homedir path is load-bearing here, not incidental. Still safe:
  // the random suffix is never a registered project the live scheduler scans
  // for PRDs, and it's removed in afterEach via tmpDirs/fsp.rm.
  const projectCwd = await fsp.mkdtemp(path.join(os.homedir(), '.sm-prdmigration-tilde-'));
  tmpDirs.push(projectCwd);
  const tildeCwd = path.join('~', path.relative(os.homedir(), projectCwd));
  const body = `---\ntitle: Tilde cwd\ncwd: ${tildeCwd}\nestimateMinutes: 15\n---\n\nBody.\n`;
  await fsp.writeFile(path.join(legacyDir, '07-tilde.md'), body, 'utf8');

  const result = await migratePrds(legacyDir);

  expect(result.moved).toBe(1);
  expect(result.unresolved).toEqual([]);
  const dest = path.join(resolvePrdWriteDir(projectCwd), '07-tilde.md');
  expect(fs.existsSync(dest)).toBe(true);
});

test('migratePrds expands a tilde cwd under a temp HOME (regression: stale installs lacking expandHome leave these unresolved)', async () => {
  const legacyDir = await mkLegacyDir();
  const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdmigration-fakehome-'));
  tmpDirs.push(fakeHome);
  const projectCwd = path.join(fakeHome, 'Projects', 'session-manager');
  await fsp.mkdir(projectCwd, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const body = `---\ntitle: Tilde under fake HOME\ncwd: ~/Projects/session-manager\nestimateMinutes: 15\n---\n\nBody.\n`;
    await fsp.writeFile(path.join(legacyDir, '08-tilde-fakehome.md'), body, 'utf8');

    const result = await migratePrds(legacyDir);

    expect(result.moved).toBe(1);
    expect(result.unresolved).toEqual([]);
    expect(fs.existsSync(path.join(legacyDir, '08-tilde-fakehome.md'))).toBe(false);
    const dest = path.join(resolvePrdWriteDir(projectCwd), '08-tilde-fakehome.md');
    expect(fs.existsSync(dest)).toBe(true);
  } finally {
    process.env.HOME = originalHome;
  }
});

test('migratePrds moves multiple PRDs to different projects independently', async () => {
  const legacyDir = await mkLegacyDir();
  const cwdA = await mkProjectCwd();
  const cwdB = await mkProjectCwd();
  await fsp.writeFile(
    path.join(legacyDir, '05-a.md'),
    `---\ntitle: A\ncwd: ${cwdA}\nestimateMinutes: 5\n---\n\nA.\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(legacyDir, '06-b.md'),
    `---\ntitle: B\ncwd: ${cwdB}\nestimateMinutes: 5\n---\n\nB.\n`,
    'utf8',
  );

  const result = await migratePrds(legacyDir);

  expect(result.moved).toBe(2);
  expect(fs.existsSync(path.join(resolvePrdWriteDir(cwdA), '05-a.md'))).toBe(true);
  expect(fs.existsSync(path.join(resolvePrdWriteDir(cwdB), '06-b.md'))).toBe(true);
});

/* ------------------------------------------------------------------------ *
 * PRD 992 — consolidateFlatPrds must not archive a PRD with a live queue job.
 *
 * The scheduler still scans the retired flat `scheduler/prds/` dir as a PRD
 * *source* (prdLocations.cjs's resolvePrdsDirs), so a file there can have a
 * pending/running job. Consolidation used to move every .md unconditionally,
 * stranding that job with no resolvable source. Observed live 2026-08-02:
 * 980-fix-chat-typed-event-renderers.md sat there with status `running`.
 * ------------------------------------------------------------------------ */

const { consolidateFlatPrds, LIVE_JOB_STATUSES } = require('../lib/prdMigration.cjs');

function opsRoot(root) {
  return path.join(root, 'session-manager-operations', 'scheduler');
}

async function makeFlatProject(root, files) {
  const flat = path.join(opsRoot(root), 'prds');
  await fsp.mkdir(flat, { recursive: true });
  for (const name of files) {
    await fsp.writeFile(path.join(flat, name), `---\ntitle: ${name}\n---\n# Goal\n`, 'utf8');
  }
  return flat;
}

async function writeQueue(root, jobs) {
  const stateDir = path.join(opsRoot(root), 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }), 'utf8');
}

function newRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-consolidate-'));
  tmpDirs.push(d);
  return d;
}

for (const status of LIVE_JOB_STATUSES) {
  test(`consolidateFlatPrds leaves a file in place when its job is ${status}`, async () => {
    const root = newRoot();
    const flat = await makeFlatProject(root, ['980-fix-chat-typed-event-renderers.md']);
    await writeQueue(root, [{ slug: '980-fix-chat-typed-event-renderers', status }]);

    const r = await consolidateFlatPrds(root);

    expect(r.moved).toBe(0);
    expect(r.skipped).toEqual([
      { file: '980-fix-chat-typed-event-renderers.md', reason: 'live queue job — source must survive' },
    ]);
    expect(fs.existsSync(path.join(flat, '980-fix-chat-typed-event-renderers.md'))).toBe(true);
  });
}

for (const status of ['completed', 'failed']) {
  test(`consolidateFlatPrds archives a file whose job is ${status}`, async () => {
    const root = newRoot();
    const flat = await makeFlatProject(root, ['700-done.md']);
    await writeQueue(root, [{ slug: '700-done', status }]);

    const r = await consolidateFlatPrds(root);

    expect(r.moved).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(fs.existsSync(path.join(flat, '700-done.md'))).toBe(false);
    expect(fs.existsSync(path.join(opsRoot(root), 'prds-archived', '700-done.md'))).toBe(true);
  });
}

test('consolidateFlatPrds archives a file with no job at all', async () => {
  const root = newRoot();
  await makeFlatProject(root, ['701-orphan.md']);
  await writeQueue(root, []);

  const r = await consolidateFlatPrds(root);

  expect(r.moved).toBe(1);
  expect(fs.existsSync(path.join(opsRoot(root), 'prds-archived', '701-orphan.md'))).toBe(true);
});

test('consolidateFlatPrds mixed dir: only the live one survives', async () => {
  const root = newRoot();
  const flat = await makeFlatProject(root, ['800-live.md', '801-done.md', '802-none.md']);
  await writeQueue(root, [
    { slug: '800-live', status: 'running' },
    { slug: '801-done', status: 'completed' },
  ]);

  const r = await consolidateFlatPrds(root);

  expect(r.moved).toBe(2);
  expect(r.skipped.map((s) => s.file)).toEqual(['800-live.md']);
  expect(fs.existsSync(path.join(flat, '800-live.md'))).toBe(true);
});

test('consolidateFlatPrds never touches dotfiles (NN allocation still uses them)', async () => {
  const root = newRoot();
  const flat = await makeFlatProject(root, ['900-x.md']);
  await fsp.writeFile(path.join(flat, '.max-allocated-group'), '992', 'utf8');

  await consolidateFlatPrds(root, { liveSlugs: new Set() });

  expect(fs.existsSync(path.join(flat, '.max-allocated-group'))).toBe(true);
});

test('consolidateFlatPrds is idempotent and creates no -legacy- duplicate', async () => {
  const root = newRoot();
  await makeFlatProject(root, ['910-a.md']);
  await writeQueue(root, []);

  const first = await consolidateFlatPrds(root);
  const second = await consolidateFlatPrds(root);

  expect(first.moved).toBe(1);
  expect(second.moved).toBe(0);
  expect(fs.readdirSync(path.join(opsRoot(root), 'prds-archived'))).toEqual(['910-a.md']);
});

test('consolidateFlatPrds protects a live job across repeat runs, not just the first', async () => {
  const root = newRoot();
  await makeFlatProject(root, ['920-live.md']);
  await writeQueue(root, [{ slug: '920-live', status: 'pending' }]);

  await consolidateFlatPrds(root);
  const second = await consolidateFlatPrds(root);

  expect(second.moved).toBe(0);
  expect(second.skipped).toHaveLength(1);
});

test('consolidateFlatPrds treats an absent queue.json as "no jobs", not an error', async () => {
  const root = newRoot();
  await makeFlatProject(root, ['930-fresh.md']);

  const r = await consolidateFlatPrds(root);

  expect(r.moved).toBe(1);
  expect(r.skipped).toEqual([]);
});

test('consolidateFlatPrds FAILS CLOSED on an unparseable queue.json', async () => {
  const root = newRoot();
  const flat = await makeFlatProject(root, ['940-a.md', '941-b.md']);
  const stateDir = path.join(opsRoot(root), 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(path.join(stateDir, 'queue.json'), '{ not json', 'utf8');

  const r = await consolidateFlatPrds(root);

  expect(r.moved).toBe(0);
  expect(r.skipped).toHaveLength(2);
  expect(r.skipped[0].reason).toMatch(/queue state unreadable/);
  expect(fs.existsSync(path.join(flat, '940-a.md'))).toBe(true);
  expect(fs.existsSync(path.join(flat, '941-b.md'))).toBe(true);
});

test('consolidateFlatPrds returns the full shape when the flat dir is missing', async () => {
  const r = await consolidateFlatPrds(newRoot());
  expect(r).toEqual({ moved: 0, failed: [], skipped: [] });
});
