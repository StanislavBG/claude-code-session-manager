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
