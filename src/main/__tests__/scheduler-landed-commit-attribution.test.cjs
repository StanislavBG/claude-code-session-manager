/**
 * scheduler-landed-commit-attribution.test.cjs — a worktree-isolated run takes
 * landed-commit credit only from its own integration result, never from a
 * concurrent job's commit moving the shared checkout's HEAD.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-landed-commit-attribution.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { finalizeJobWorktree } = require('../scheduler.cjs');
const { resolveRunCommitAttribution } = require('../scheduler/gitTreeGuard.cjs');

test('worktree run: foreign HEAD move with no own integration gets no credit', () => {
  const r = resolveRunCommitAttribution({
    ranInWorktree: true, integratedSha: null, headBefore: 'aaa', headAtExit: 'bbb', committedInWindow: true,
  });
  assert.deepEqual(r, { landedCommit: null, committedDuringRun: false });
});

test('worktree run: own integratedSha is the landed commit', () => {
  const r = resolveRunCommitAttribution({
    ranInWorktree: true, integratedSha: 'ccc', headBefore: 'aaa', headAtExit: 'bbb', committedInWindow: false,
  });
  assert.deepEqual(r, { landedCommit: 'ccc', committedDuringRun: true });
});

test('in-place run: legacy behaviour unchanged', () => {
  assert.deepEqual(
    resolveRunCommitAttribution({ ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'bbb', committedInWindow: false }),
    { landedCommit: 'bbb', committedDuringRun: true },
  );
  assert.deepEqual(
    resolveRunCommitAttribution({ ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'aaa', committedInWindow: true }),
    { landedCommit: null, committedDuringRun: true },
  );
  assert.deepEqual(
    resolveRunCommitAttribution({ ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'aaa', committedInWindow: false }),
    { landedCommit: null, committedDuringRun: false },
  );
});

test('in-place run: foreign commit in range, sibling overlap, no transcript sha gives null', () => {
  assert.deepEqual(
    resolveRunCommitAttribution({
      ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'fff',
      committedInWindow: true, rangeCommits: ['f'.repeat(40)], transcriptCommitShas: [], siblingOverlap: true,
    }),
    { landedCommit: null, committedDuringRun: false },
  );
});

test('in-place run: own transcript short sha resolves to the full range sha', () => {
  const own = '347641f' + '0'.repeat(33);
  assert.deepEqual(
    resolveRunCommitAttribution({
      ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: own,
      committedInWindow: true, rangeCommits: ['f'.repeat(40), own], transcriptCommitShas: ['347641f'], siblingOverlap: true,
    }),
    { landedCommit: own, committedDuringRun: true },
  );
});

test('in-place run: no transcript shas and no sibling overlap keeps legacy HEAD delta', () => {
  assert.deepEqual(
    resolveRunCommitAttribution({
      ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'bbb',
      committedInWindow: false, rangeCommits: ['b'.repeat(40)], transcriptCommitShas: [], siblingOverlap: false,
    }),
    { landedCommit: 'bbb', committedDuringRun: true },
  );
});

function finalizeWith(integration) {
  return finalizeJobWorktree({
    job: { slug: 'x' },
    runDir: '/tmp/none',
    worktree: { dir: '/tmp/wt', branch: 'sm-job/x', baseBranch: 'main' },
    guardCwd: '/tmp/repo',
    carriedPaths: [],
    deps: {
      jobWorktree: {
        integrateJobBranch: async () => integration,
        cleanupJobWorktree: async () => ({ ok: true }),
        salvageJobWorktreeDiff: async () => ({ ok: false }),
      },
      uncommittedChanges: async () => [],
      reportSchedulerError: () => {},
    },
  });
}

test('finalizeJobWorktree propagates integratedSha when integrated', async () => {
  const r = await finalizeWith({ ok: true, integrated: true, fastForward: true, sha: 'abc123' });
  assert.equal(r.integratedSha, 'abc123');
});

test('finalizeJobWorktree integratedSha is null for no new commits', async () => {
  const r = await finalizeWith({ ok: true, integrated: false, reason: 'branch has no new commits' });
  assert.equal(r.integratedSha, null);
});

// ── real-git: where HEAD ended up ────────────────────────────────────────
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { strandedCommitVerdict } = require('../scheduler/gitTreeGuard.cjs');
const realJw = require('../lib/git/jobWorktree.cjs');
const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

async function realSetup(name) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `sm-landed-${name}-`));
  gitIn(cwd, 'init', '-q', '-b', 'main');
  gitIn(cwd, 'config', 'user.email', 't@example.com');
  gitIn(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-q', '-m', 'init');
  const worktree = await realJw.createJobWorktree({ cwd, slug: `landed-${name}` });
  if (!worktree.ok) throw new Error(JSON.stringify(worktree));
  gitIn(worktree.dir, 'config', 'user.email', 't@example.com');
  gitIn(worktree.dir, 'config', 'user.name', 't');
  const runDir = path.join(cwd, '.run');
  fs.mkdirSync(runDir, { recursive: true });
  return { cwd, worktree, runDir, slug: `landed-${name}` };
}
const commitFile = (dir, f) => {
  fs.writeFileSync(path.join(dir, f), `${f}\n`);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', f);
  return gitIn(dir, 'rev-parse', 'HEAD');
};
const fin = (s) => finalizeJobWorktree({ job: { slug: s.slug }, runDir: s.runDir, worktree: s.worktree, guardCwd: s.cwd, carriedPaths: [], deps: { isRunCancelled: async () => false } });

test('real git: detached commit is fast-forwarded onto the job branch and lands', async () => {
  const s = await realSetup('det');
  try {
    gitIn(s.worktree.dir, 'checkout', '-q', '--detach');
    const sha = commitFile(s.worktree.dir, 'd.txt');
    const r = await fin(s);
    assert.equal(r.worktreeHead.action, 'fast-forwarded');
    assert.equal(r.integratedSha, sha);
    assert.equal(gitIn(s.cwd, 'rev-parse', 'refs/heads/main'), sha);
  } finally { fs.rmSync(s.cwd, { recursive: true, force: true }); }
});

test('real git: diverged HEAD is not integrated, branch kept, commit pinned', async () => {
  const s = await realSetup('div');
  try {
    commitFile(s.worktree.dir, 'on-branch.txt');
    gitIn(s.worktree.dir, 'checkout', '-q', '--detach', 'main');
    const sha = commitFile(s.worktree.dir, 'off.txt');
    const mainBefore = gitIn(s.cwd, 'rev-parse', 'refs/heads/main');
    const r = await fin(s);
    assert.equal(r.worktreeHead.action, 'diverged');
    assert.equal(r.integratedSha, null);
    assert.equal(gitIn(s.cwd, 'rev-parse', 'refs/heads/main'), mainBefore);
    assert.ok(gitIn(s.cwd, 'rev-parse', '--verify', `refs/heads/${s.worktree.branch}`));
    const st = r.worktreeHead.stranded.find((x) => x.sha === sha);
    assert.ok(st && st.ref.startsWith('refs/sm-stranded/'));
    assert.equal(gitIn(s.cwd, 'rev-parse', st.ref), sha);
  } finally { fs.rmSync(s.cwd, { recursive: true, force: true }); }
});

test('real git: return-to-branch run yields run_commit_not_landed naming the SHA', async () => {
  const s = await realSetup('ret');
  try {
    gitIn(s.worktree.dir, 'checkout', '-q', '--detach');
    const sha = commitFile(s.worktree.dir, 'lost.txt');
    gitIn(s.worktree.dir, 'checkout', '-q', s.worktree.branch);
    const r = await fin(s);
    assert.equal(r.integratedSha, null);
    const v = strandedCommitVerdict({ worktreeHead: r.worktreeHead, landedCommit: r.integratedSha });
    assert.equal(v.verdict, 'run_commit_not_landed');
    assert.equal(v.downgradeTo, 'needs_review');
    assert.ok(v.reason.includes(sha.slice(0, 8)));
    assert.ok(v.reason.includes('refs/sm-stranded/'));
  } finally { fs.rmSync(s.cwd, { recursive: true, force: true }); }
});

test('strandedCommitVerdict: null when landed or nothing stranded', () => {
  assert.equal(strandedCommitVerdict({ worktreeHead: { stranded: [{ sha: 'abc', ref: 'r' }] }, landedCommit: 'x' }), null);
  assert.equal(strandedCommitVerdict({ worktreeHead: { stranded: [] }, landedCommit: null }), null);
});
