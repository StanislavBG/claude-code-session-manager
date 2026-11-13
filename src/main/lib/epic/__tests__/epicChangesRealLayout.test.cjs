/**
 * epicChangesRealLayout.test.cjs — wiring test for the 'prd' sections of
 * getEpicChanges through the REAL default readers (defaultListEpicPrds +
 * defaultLandedCommitFor) over the real on-disk layout: the scheduler archives
 * PRDs flat as prds-archived/<NN>-<slug>.md, older ones nested under
 * prds-archived/<ISO>/. Only loadEpic and validatePath are injected.
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicChangesRealLayout.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getEpicChanges } = require('../epicChanges.cjs');

const EPIC = 'real-layout-epic-1a2b3c4d';
const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

function commitFile(cwd, name, text, msg) {
  fs.writeFileSync(path.join(cwd, name), text);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

const prdBody = (title) => `---\ntitle: ${title}\nsourcePromptId: ${EPIC}\n---\n# Goal\nx\n`;

test('flat + nested prds-archived PRDs each get a prd section via the real readers', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epic-real-layout-'));
  tmpDirs.push(root);
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  commitFile(cwd, 'README.md', 'r\n', 'init');
  const shaNested = commitFile(cwd, 'nested.txt', 'n\n', 'prd 3');
  const shaFlatA = commitFile(cwd, 'flat-a.txt', 'a\n', 'prd 12');
  const shaFlatB = commitFile(cwd, 'flat-b.txt', 'b\n', 'prd 101');

  const ops = path.join(cwd, 'session-manager-operations', 'scheduler');
  const archived = path.join(ops, 'epics', EPIC, 'prds-archived');
  fs.mkdirSync(path.join(archived, '2026-11-01T00-00-00Z'), { recursive: true });
  fs.writeFileSync(path.join(archived, '12-flat-a.md'), prdBody('Flat A'));
  fs.writeFileSync(path.join(archived, '101-flat-b.md'), prdBody('Flat B'));
  fs.writeFileSync(path.join(archived, '2026-11-01T00-00-00Z', '3-nested.md'), prdBody('Nested'));

  fs.mkdirSync(path.join(ops, 'state'), { recursive: true });
  const rows = [
    { slug: '3-nested', status: 'completed', landedCommit: shaNested, sourcePromptId: EPIC, cwd, finishedAt: '2026-11-01T00:00:00.000Z' },
    { slug: '12-flat-a', status: 'completed', landedCommit: shaFlatA, sourcePromptId: EPIC, cwd, finishedAt: '2026-11-02T00:00:00.000Z' },
    { slug: '101-flat-b', status: 'completed', landedCommit: shaFlatB, sourcePromptId: EPIC, cwd, finishedAt: '2026-11-03T00:00:00.000Z' },
  ];
  fs.writeFileSync(path.join(ops, 'state', 'history.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const res = await getEpicChanges(
    { cwd, epicId: EPIC },
    { loadEpic: () => ({ id: EPIC, status: 'completed' }), validatePath: (p) => p },
  );
  expect(res.ok).toBe(true);
  expect(res.sections.map((s) => s.key)).toEqual(['prd:3-nested', 'prd:12-flat-a', 'prd:101-flat-b']);
  const byKey = Object.fromEntries(res.sections.map((s) => [s.key, s]));
  expect(byKey['prd:3-nested']).toMatchObject({ kind: 'prd', label: 'Nested', head: shaNested });
  expect(byKey['prd:12-flat-a']).toMatchObject({ kind: 'prd', label: 'Flat A', head: shaFlatA });
  expect(byKey['prd:101-flat-b']).toMatchObject({ kind: 'prd', label: 'Flat B', head: shaFlatB });
  expect(byKey['prd:3-nested'].files.map((f) => f.path)).toEqual(['nested.txt']);
  expect(byKey['prd:12-flat-a'].files.map((f) => f.path)).toEqual(['flat-a.txt']);
  expect(byKey['prd:101-flat-b'].files.map((f) => f.path)).toEqual(['flat-b.txt']);
  for (const s of res.sections) expect(s.error).toBeUndefined();
});
