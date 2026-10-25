'use strict';

// listFeedbackTargets must collapse job/Epic worktree cwds into their main
// checkout and drop worktrees whose main checkout cannot be resolved.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schedulerPaths = require('../../scheduler/schedulerPaths.cjs');
const { listFeedbackTargets } = require('../crossProjectFeedback.cjs');

let tmp;
const made = [];

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function mkMain(name) {
  const main = mkdir(path.join(tmp, name));
  mkdir(path.join(main, '.git', 'worktrees'));
  mkdir(path.join(main, 'session-manager-operations'));
  return main;
}

/** Linked worktree with a verified back-reference, under the managed root. */
function mkWorktree(main, kind, id) {
  const root = schedulerPaths.worktreeRoot(kind);
  const wt = mkdir(path.join(root, `feedbacktest-${process.pid}`, id));
  made.push(path.join(root, `feedbacktest-${process.pid}`));
  const admin = mkdir(path.join(main, '.git', 'worktrees', id));
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'gitdir'), path.join(wt, '.git') + '\n');
  mkdir(path.join(wt, 'session-manager-operations'));
  return wt;
}

function seed(projectsDir, folder, cwd, mtimeSec) {
  const dir = mkdir(path.join(projectsDir, folder));
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, JSON.stringify({ cwd }) + '\n');
  const t = new Date(mtimeSec * 1000);
  fs.utimesSync(f, t, t);
  fs.utimesSync(dir, t, t);
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fbwt-')); });
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe('listFeedbackTargets worktree collapse', () => {
  it('collapses a job-worktree cwd into its main project', async () => {
    const main = mkMain('proj');
    const wt = mkWorktree(main, 'job', 'job1');
    const pd = mkdir(path.join(tmp, 'projects'));
    seed(pd, 'a', wt, 1000);
    const { projects } = await listFeedbackTargets({ projectsDir: pd });
    expect(projects.map((p) => p.cwd)).toEqual([main]);
  });

  it('lists main once when an Epic-worktree cwd and the main cwd both appear', async () => {
    const main = mkMain('proj');
    const wt = mkWorktree(main, 'epic', 'epic1');
    const pd = mkdir(path.join(tmp, 'projects'));
    seed(pd, 'a', wt, 2000);
    seed(pd, 'b', main, 1000);
    const { projects } = await listFeedbackTargets({ projectsDir: pd });
    expect(projects.map((p) => p.cwd)).toEqual([main]);
    expect(projects[0].lastActivity).toBe(new Date(2000 * 1000).toISOString());
  });

  it('drops a worktree whose main checkout cannot be resolved', async () => {
    const main = mkMain('proj');
    const wt = mkWorktree(main, 'job', 'job2');
    fs.rmSync(path.join(main, '.git', 'worktrees', 'job2'), { recursive: true, force: true });
    const pd = mkdir(path.join(tmp, 'projects'));
    seed(pd, 'a', wt, 1000);
    seed(pd, 'b', main, 500);
    const { projects } = await listFeedbackTargets({ projectsDir: pd });
    expect(projects.map((p) => p.cwd)).toEqual([main]);
  });
});
