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

// ---------- 'prd' sections (one per landed PRD of the Epic) ----------

const { readLandedCommits, defaultListEpicPrds } = require('../epicChanges.cjs');

function commitFile(cwd, name, text, msg) {
  fs.writeFileSync(path.join(cwd, name), text);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

test('two landed PRDs (one a merge) -> prd sections after session sections, by PRD number', async () => {
  const { cwd, dir } = await makeRepo();
  fs.writeFileSync(path.join(dir, 'live.txt'), 'l\n'); // a session:live section exists
  const shaA = commitFile(cwd, 'p1.txt', 'p1\n', 'prd 12');
  // Merge commit: side branch adds side.txt, main adds main2.txt, merge.
  git(cwd, 'checkout', '-q', '-b', 'side');
  commitFile(cwd, 'side.txt', 's\n', 'side');
  git(cwd, 'checkout', '-q', 'main');
  commitFile(cwd, 'main2.txt', 'm\n', 'main2');
  git(cwd, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const shaM = git(cwd, 'rev-parse', 'HEAD');
  const record = { status: 'active', worktree: { dir, branch: BRANCH, baseCwd: cwd, status: 'active' } };
  const listEpicPrds = () => [{ slug: '100-merge', title: 'Merge PRD' }, { slug: '12-first', title: 'First PRD' }];
  const landedCommitFor = (_c, slugs) => {
    expect(slugs.sort()).toEqual(['100-merge', '12-first']);
    return new Map([['100-merge', shaM], ['12-first', shaA]]);
  };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor(record, { listEpicPrds, landedCommitFor }));
  expect(res.ok).toBe(true);
  expect(res.sections.map((s) => s.key)).toEqual(['session:live', 'prd:12-first', 'prd:100-merge']);
  const [, a, m] = res.sections;
  expect(a).toEqual({ kind: 'prd', key: 'prd:12-first', label: 'First PRD', slug: '12-first', base: `${shaA}^1`, head: shaA, live: false, files: a.files });
  expect(paths(a)).toEqual(['p1.txt']);
  expect(m).toMatchObject({ kind: 'prd', label: 'Merge PRD', base: `${shaM}^1`, head: shaM });
  expect(paths(m)).toEqual(['side.txt']); // first-parent diff only
});

test('no landedCommit and unknown sha are skipped; parentless commit diffs against empty tree', async () => {
  const { cwd } = await makeRepo();
  const root = git(cwd, 'rev-list', '--max-parents=0', 'HEAD');
  const listEpicPrds = () => [{ slug: '1-root', title: '1-root' }, { slug: '2-none', title: 'x' }, { slug: '3-bogus', title: 'y' }];
  const landedCommitFor = () => new Map([['1-root', root], ['3-bogus', 'deadbeef'.repeat(5)]]);
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor({ status: 'completed' }, { listEpicPrds, landedCommitFor }));
  expect(res.sections.map((s) => s.key)).toEqual(['prd:1-root']);
  expect(paths(res.sections[0])).toEqual(['a.txt', 'carried.txt']);
  expect(res.sections[0].error).toBeUndefined();
});

test('caps count prd sections; at most 4 git diffs at once', async () => {
  const { cwd } = await makeRepo();
  const shas = [];
  for (let i = 0; i < 6; i += 1) {
    shas.push(commitFile(cwd, `big${i}.txt`, Array.from({ length: 5000 }, (_, j) => `l${j}`).join('\n') + '\n', `p${i}`));
  }
  const listEpicPrds = () => shas.map((_, i) => ({ slug: `${i + 1}-p`, title: `P${i}` }));
  const landedCommitFor = () => new Map(shas.map((s, i) => [`${i + 1}-p`, s]));
  const { execGit: realExecGit } = require('../../git/gitExec.cjs');
  let inFlight = 0; let peak = 0;
  const execGit = async (c, args, opts) => {
    const isDiff = args.includes('diff');
    if (isDiff) { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); }
    try { return await realExecGit(c, args, opts); } finally { if (isDiff) inFlight -= 1; }
  };
  const res = await getEpicChanges({ cwd, epicId: EPIC }, depsFor({ status: 'completed' }, { listEpicPrds, landedCommitFor, execGit }));
  expect(res.sections).toHaveLength(6);
  expect(res.truncated).toBe(true);
  expect(res.sections.slice(0, 4).every((s) => !s.files[0].tooLarge)).toBe(true);
  expect(res.sections[4].files[0]).toMatchObject({ tooLarge: true, hunks: [] });
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1);
});

test('readLandedCommits: this Epic only, newest terminal row per slug, queue then history', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epic-landed-'));
  tmpDirs.push(root);
  const prev = process.env.SM_HISTORY_PATH_OVERRIDE;
  process.env.SM_HISTORY_PATH_OVERRIDE = path.join(root, 'global-history.jsonl');
  try {
    const queuePath = path.join(root, 'queue.json');
    const historyPath = path.join(root, 'history.jsonl');
    fs.writeFileSync(queuePath, JSON.stringify({ jobs: [
      { slug: '5-q', status: 'completed', epicId: EPIC, landedCommit: 'd'.repeat(40), finishedAt: '2026-11-10T00:00:00Z', cwd: '/proj/q' },
      { slug: '6-pending', status: 'pending', epicId: EPIC, landedCommit: 'f'.repeat(40) },
    ] }));
    const rows = [
      { kind: 'terminal', slug: '1-a', status: 'completed', sourcePromptId: EPIC, landedCommit: 'a'.repeat(40), finishedAt: '2026-11-01T00:00:00Z' },
      { kind: 'terminal', slug: '1-a', status: 'completed', sourcePromptId: EPIC, landedCommit: 'b'.repeat(40), finishedAt: '2026-11-02T00:00:00Z', cwd: '/proj/x' },
      { kind: 'terminal', slug: '2-other', status: 'completed', epicId: 'epic-other', landedCommit: 'c'.repeat(40), finishedAt: '2026-11-03T00:00:00Z' },
      { kind: 'needs_review_entry', slug: '1-a', epicId: EPIC },
      { kind: 'terminal', slug: '3-failed', status: 'failed', epicId: EPIC, finishedAt: '2026-11-03T00:00:00Z' },
      { kind: 'terminal', slug: '5-q', status: 'completed', epicId: EPIC, landedCommit: 'e'.repeat(40), finishedAt: '2026-11-09T00:00:00Z' },
    ];
    fs.writeFileSync(historyPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const map = readLandedCommits({ queuePath, historyPath, epicId: EPIC, slugs: ['1-a', '2-other', '3-failed', '5-q', '6-pending'] });
    expect([...map.keys()].sort()).toEqual(['1-a', '5-q']);
    expect(map.get('1-a')).toEqual({ sha: 'b'.repeat(40), cwd: '/proj/x' });
    expect(map.get('5-q')).toEqual({ sha: 'd'.repeat(40), cwd: '/proj/q' });
    // Missing files -> empty map, never throws.
    expect(readLandedCommits({ queuePath: path.join(root, 'nope'), historyPath: path.join(root, 'nope2'), epicId: EPIC, slugs: ['1-a'] }).size).toBe(0);
  } finally {
    if (prev === undefined) delete process.env.SM_HISTORY_PATH_OVERRIDE; else process.env.SM_HISTORY_PATH_OVERRIDE = prev;
  }
});

test('defaultListEpicPrds: prds/ + prds-archived/<ISO>/ only, title from frontmatter', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epic-list-'));
  tmpDirs.push(root);
  const cwd = path.join(root, 'proj');
  const epicDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', EPIC);
  fs.mkdirSync(path.join(epicDir, 'prds'), { recursive: true });
  fs.mkdirSync(path.join(epicDir, 'prds-archived', '2026-11-01T00-00-00Z'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'epic-other', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'prds', '10-live.md'), '---\ntitle: Live one\n---\nbody\n');
  fs.writeFileSync(path.join(epicDir, 'prds-archived', '2026-11-01T00-00-00Z', '9-old.md'), 'no frontmatter\n');
  fs.writeFileSync(path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'epic-other', 'prds', '11-x.md'), '---\ntitle: X\n---\n');
  const list = defaultListEpicPrds(cwd, EPIC).sort((a, b) => a.slug.localeCompare(b.slug));
  expect(list).toEqual([{ slug: '10-live', title: 'Live one' }, { slug: '9-old', title: '9-old' }]);
});
