/**
 * epicChanges.test.cjs — getEpicChanges 'session' sections over a real temp repo.
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicChanges.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getEpicChanges } = require('../epicChanges.cjs');
const { pinEpicReviewRange } = require('../../git/gitWorktree.cjs');

const EPIC = 'epic-chg1';
const BRANCH = `sm-epic/${EPIC}`;
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

async function makeRepo() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epic-changes-'));
  tmpDirs.push(root);
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(cwd, 'carried.txt'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'init');
  const dir = path.join(root, 'wt');
  git(cwd, 'worktree', 'add', '-q', '-b', BRANCH, dir);
  return { root, cwd, dir };
}

const okPath = (p) => p;
const depsFor = (record, extra = {}) => ({ loadEpic: () => record, validatePath: okPath, ...extra });
const paths = (section) => section.files.map((f) => f.path).sort();

test('active Epic: committed, uncommitted and untracked edits in one live section', async () => {
  const { cwd, dir } = await makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  git(dir, 'commit', '-q', '-am', 'edit a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', 'b.txt');
  git(dir, 'commit', '-q', '-m', 'add b');
  fs.appendFileSync(path.join(dir, 'b.txt'), 'b2\n'); // uncommitted
  fs.writeFileSync(path.join(dir, 'new file.txt'), 'x\ny\n'); // untracked
  const record = { id: EPIC, status: 'active', worktree: { dir, branch: BRANCH, baseCwd: cwd, status: 'active' } };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor(record));
  expect(res.ok).toBe(true);
  expect(res.status).toBe('active');
  expect(res.truncated).toBe(false);
  expect(res.sections).toHaveLength(1);
  const s = res.sections[0];
  expect(s).toMatchObject({ kind: 'session', key: 'session:live', label: 'Session edits (not yet merged)', head: null, live: true });
  expect(s.base).toMatch(/^[0-9a-f]{40}$/);
  expect(paths(s)).toEqual(['a.txt', 'b.txt', 'new file.txt']);
  const b = s.files.find((f) => f.path === 'b.txt');
  expect(b.status).toBe('added');
  expect(b.additions).toBe(2);
  const u = s.files.find((f) => f.path === 'new file.txt');
  expect(u).toMatchObject({ status: 'added', additions: 2, tooLarge: false });
  expect(u.hunks[0].lines.map((l) => l.text)).toEqual(['x', 'y']);
});

test('carried unchanged paths are dropped; carried-then-edited stay', async () => {
  const { cwd, dir } = await makeRepo();
  // Base-tree WIP carried at mint: same bytes in cwd and dir.
  fs.writeFileSync(path.join(cwd, 'carried.txt'), 'wip\n');
  fs.writeFileSync(path.join(dir, 'carried.txt'), 'wip\n');
  fs.writeFileSync(path.join(cwd, 'carried-new.txt'), 'n\n');
  fs.writeFileSync(path.join(dir, 'carried-new.txt'), 'n\n');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'carried a\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'agent edited a\n');
  const record = { status: 'active', worktree: { dir, branch: BRANCH, baseCwd: cwd, status: 'active', carriedPaths: ['carried.txt', 'carried-new.txt', 'a.txt'] } };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor(record));
  expect(paths(res.sections[0])).toEqual(['a.txt']);
});

test('dir removed but branch alive: session:branch section, then pins', async () => {
  const { cwd, dir } = await makeRepo();
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  git(dir, 'add', 'c.txt');
  git(dir, 'commit', '-q', '-m', 'c');
  git(cwd, 'worktree', 'remove', '--force', dir);
  const record = { status: 'active', worktree: { dir, branch: BRANCH, baseCwd: cwd, status: 'active' } };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor(record));
  expect(res.ok).toBe(true);
  expect(res.sections).toHaveLength(1);
  expect(res.sections[0]).toMatchObject({ kind: 'session', key: 'session:branch', label: 'Session edits (committed; checkout removed)', live: false });
  expect(res.sections[0].head).toMatch(/^[0-9a-f]{40}$/);
  expect(paths(res.sections[0])).toEqual(['c.txt']);
});

test('completed Epic: one section per pinned review range', async () => {
  const { cwd, dir } = await makeRepo();
  fs.writeFileSync(path.join(dir, 'd.txt'), 'd\n');
  git(dir, 'add', 'd.txt');
  git(dir, 'commit', '-q', '-m', 'd');
  const pin = await pinEpicReviewRange({ cwd, branch: BRANCH, dir });
  expect(pin.ok).toBe(true);
  git(cwd, 'worktree', 'remove', '--force', dir);
  git(cwd, 'branch', '-D', BRANCH);
  const record = { status: 'completed', worktree: { dir, branch: BRANCH, baseCwd: cwd, status: 'merged' } };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor(record));
  expect(res.status).toBe('completed');
  expect(res.sections).toHaveLength(1);
  const s = res.sections[0];
  expect(s.key).toBe(`session:${pin.head}`);
  expect(s.label).toMatch(/^Session edits landed \d{4}-\d{2}-\d{2}$/);
  expect(s).toMatchObject({ base: pin.base, head: pin.head, live: false });
  expect(paths(s)).toEqual(['d.txt']);
});

test('no worktree record and no pins -> sections: []', async () => {
  const { cwd } = await makeRepo();
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor({ status: 'active' }));
  expect(res).toEqual({ ok: true, epicId: EPIC, status: 'active', sections: [], truncated: false });
});

test('unsafe or unknown epicId and bad cwd -> ok:false, never throws', async () => {
  const { cwd } = await makeRepo();
  expect(await getEpicChanges({ cwd, epicId: '../x' }, depsFor({}))).toMatchObject({ ok: false });
  expect(await getEpicChanges({ cwd, epicId: '' }, depsFor({}))).toMatchObject({ ok: false });
  expect(await getEpicChanges({ cwd, epicId: 'nope' }, depsFor(null))).toEqual({ ok: false, reason: 'epic not found' });
  // Real validatePath: '/' is outside every allowed root.
  expect(await getEpicChanges({ cwd: '/', epicId: EPIC }, { loadEpic: () => ({}) })).toMatchObject({ ok: false });
  expect(await getEpicChanges(undefined)).toMatchObject({ ok: false });
  const throwing = depsFor(null, { loadEpic: () => { throw new Error('boom'); } });
  expect(await getEpicChanges({ cwd, epicId: EPIC }, throwing)).toMatchObject({ ok: false, reason: 'boom' });
});

test('caps: files per section and total lines -> tooLarge + truncated', async () => {
  const { cwd, dir } = await makeRepo();
  for (let i = 0; i < 305; i += 1) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'many');
  const record = { status: 'active', worktree: { dir, branch: BRANCH, baseCwd: cwd, status: 'active' } };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor(record));
  expect(res.truncated).toBe(true);
  const files = res.sections[0].files;
  expect(files).toHaveLength(305);
  const big = files.filter((f) => f.tooLarge);
  expect(big).toHaveLength(5);
  for (const f of big) {
    expect(f.hunks).toEqual([]);
    expect(f.additions).toBe(1);
    expect(f.status).toBe('added');
  }

  // Total-line cap: one 25000-line file overruns 20000.
  const { cwd: cwd2, dir: dir2 } = await makeRepo();
  fs.writeFileSync(path.join(dir2, 'huge.txt'), Array.from({ length: 25000 }, (_, i) => `l${i}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir2, 'small.txt'), 's\n');
  git(dir2, 'add', '.');
  git(dir2, 'commit', '-q', '-m', 'huge');
  const rec2 = { status: 'active', worktree: { dir: dir2, branch: BRANCH, baseCwd: cwd2, status: 'active' } };
  const res2 = await getEpicChanges({ cwd: cwd2, epicId: EPIC }, depsFor(rec2));
  expect(res2.truncated).toBe(true);
  const huge = res2.sections[0].files.find((f) => f.path === 'huge.txt');
  expect(huge).toMatchObject({ tooLarge: true, hunks: [], additions: 25000 });

  // Untracked file over 1 MiB: tooLarge, no hunks, git never asked to diff it.
  fs.writeFileSync(path.join(dir2, 'blob.bin'), Buffer.alloc(1024 * 1024 + 1, 97));
  const res3 = await getEpicChanges({ cwd: cwd2, epicId: EPIC }, depsFor(rec2));
  expect(res3.sections[0].files.find((f) => f.path === 'blob.bin')).toMatchObject({ status: 'added', tooLarge: true, hunks: [] });
});

test('a failing git call yields that section with files: [] and error', async () => {
  const { cwd, dir } = await makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  const { execGit: realExecGit } = require('../../git/gitExec.cjs');
  const calls = [];
  const execGit = (c, args, opts) => {
    calls.push({ args, opts });
    if (args.includes('diff') && !args.includes('--no-index')) {
      const e = new Error('fatal: bad revision'); e.stderrText = 'fatal: bad revision\n';
      return Promise.reject(e);
    }
    return realExecGit(c, args, opts);
  };
  const record = { status: 'active', worktree: { dir, branch: BRANCH, baseCwd: cwd, status: 'active' } };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor(record, { execGit }));
  expect(res.ok).toBe(true);
  expect(res.sections[0]).toMatchObject({ key: 'session:live', files: [], error: 'fatal: bad revision' });
  // Fixed flags + limits on every diff.
  const diff = calls.find((c) => c.args.includes('diff'));
  expect(diff.args.slice(0, 4)).toEqual(['-c', 'core.quotepath=off', '--no-optional-locks', 'diff']);
  for (const f of ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/']) expect(diff.args).toContain(f);
  for (const c of calls) {
    expect(c.opts.timeout).toBeLessThanOrEqual(20000);
    expect(c.opts.maxBuffer).toBe(32 * 1024 * 1024);
  }
});
