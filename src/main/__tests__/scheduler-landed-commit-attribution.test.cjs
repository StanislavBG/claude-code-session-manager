/**
 * scheduler-landed-commit-attribution.test.cjs — a worktree-isolated run takes
 * landed-commit credit only from its own integration result, never from a
 * concurrent job's commit moving the shared checkout's HEAD.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-landed-commit-attribution.test.cjs
 */

'use strict';

import { test, vi } from 'vitest';
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

// ── real-git: carried base WIP the job left alone is not the job's dirt ──
async function dirtyBaseSetup(name) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `sm-carried-${name}-`));
  gitIn(cwd, 'init', '-q', '-b', 'main');
  gitIn(cwd, 'config', 'user.email', 't@example.com');
  gitIn(cwd, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a wip\n');
  const worktree = await realJw.createJobWorktree({ cwd, slug: `carried-${name}` });
  if (!worktree.ok) throw new Error(JSON.stringify(worktree));
  const runDir = path.join(cwd, '.run');
  fs.mkdirSync(runDir, { recursive: true });
  return { cwd, worktree, runDir, slug: `carried-${name}` };
}
const finCarried = (s) => finalizeJobWorktree({ job: { slug: s.slug }, runDir: s.runDir, worktree: s.worktree, guardCwd: s.cwd, carriedPaths: s.worktree.carriedPaths, deps: { isRunCancelled: async () => false } });

test('real git: dirty base, job leaves carried path alone → not in worktreeLeftoverDirty', async () => {
  const s = await dirtyBaseSetup('same');
  assert.deepEqual(s.worktree.carriedPaths, ['a.txt']);
  assert.equal(fs.readFileSync(path.join(s.worktree.dir, 'a.txt'), 'utf8'), 'a wip\n');
  const r = await finCarried(s);
  assert.ok(!r.worktreeLeftoverDirty.includes('a.txt'), JSON.stringify(r.worktreeLeftoverDirty));
});

test('real git: dirty base, job edits carried path further → still in worktreeLeftoverDirty', async () => {
  const s = await dirtyBaseSetup('edited');
  fs.writeFileSync(path.join(s.worktree.dir, 'a.txt'), 'a job edit\n');
  const r = await finCarried(s);
  assert.ok(r.worktreeLeftoverDirty.includes('a.txt'), JSON.stringify(r.worktreeLeftoverDirty));
});

// ── real-git: 1458 shape — overlapping sibling, own commit proven by git's printed sha ──
const { parseLog, verifyRun } = require('../runVerify.cjs');
const gitTreeGuardReal = require('../scheduler/gitTreeGuard.cjs');

test('real git: 1458 shape credits own commit via commit-output sha, never the sibling', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-landed-1458-'));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-landed-1458-run-'));
  const writeSpy = vi.spyOn(require('../config.cjs'), 'writeJsonSync').mockImplementation((abs, data) => {
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
    return { ok: true, mtimeMs: 0 };
  });
  try {
    const g = (...a) => gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
    g('init', '-q', '-b', 'main');
    const mk = (f, msg) => { fs.writeFileSync(path.join(repo, f), `${f}\n`); g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
    const B = mk('base.txt', 'base');
    const S = mk('sibling.txt', 'sibling work in the shared tree');
    const subj = 'fix(email): undo groom restores only exact-note delete_rule row';
    const O = mk('own.txt', subj);
    const short = O.slice(0, 7);

    const slug = 'prd-1458';
    const cmd = `git add own.txt && git commit -q -m "${subj}" && git log --oneline -1`;
    const lines = [
      '[scheduler] starting',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `${short} ${subj}` }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\nSCHEDULER_VERDICT: PASS' }] } }),
    ];
    const logPath = path.join(runDir, `${slug}.log`);
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const parsed = parseLog(logPath);
    const transcriptCommitShas = [...new Set([...(parsed.transcriptCommitShas || []), ...(parsed.transcriptCommitOutputShas || [])])];
    const rangeCommits = await gitTreeGuardReal.gitRangeCommits(repo, B, O);
    assert.ok(rangeCommits.includes(S) && rangeCommits.includes(O));
    const r = resolveRunCommitAttribution({
      ranInWorktree: false, integratedSha: null, headBefore: B, headAtExit: O,
      committedInWindow: true, rangeCommits, transcriptCommitShas, siblingOverlap: true,
    });
    assert.equal(r.landedCommit, O);
    assert.notEqual(r.landedCommit, S);
    assert.equal(r.committedDuringRun, true);

    const prdPath = path.join(runDir, `${slug}.md`);
    fs.writeFileSync(prdPath, '# Goal\nx\n');
    const v = await verifyRun({
      runDir, prdPath, queueEntry: { slug, cwd: repo }, allJobs: [],
      committedDuringRun: r.committedDuringRun, jobLandedCommitThisRun: r.landedCommit, exitCode: 0,
    });
    assert.notEqual(v.verdict, 'pass_no_commit');
  } finally {
    writeSpy.mockRestore();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
