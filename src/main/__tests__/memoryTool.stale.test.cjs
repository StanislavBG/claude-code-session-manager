'use strict';

import { test, beforeAll, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memtool-stale-')));
const origHome = process.env.HOME;
process.env.HOME = tmpHome; // before memoryTool/config load: allowedRoots = homedir()

const WS = 'stale-ws';
let tool;
let repo;
let memDir;

const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
  stdio: 'pipe',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});
const put = (rel, text) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

beforeAll(async () => {
  repo = path.join(tmpHome, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q');
  put('src/old/widget.cjs', 'module.exports = 1;\n'.repeat(20));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(repo, 'src/new'), { recursive: true });
  git('mv', 'src/old/widget.cjs', 'src/new/widget.cjs');
  git('commit', '-q', '-m', 'rename');
  // Untracked (ops state is usually gitignored): only the ops-root extra base resolves it.
  put('session-manager-operations/architecture/domain-model.md', '# domain\n');

  tool = require('../memoryTool.cjs');
  memDir = (await tool.resolveDir({ workspace: WS, cwd: repo })).dir;
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'cross_project_replies_plan.md'),
    '---\nname: cross-project-replies-plan\ndescription: replies\n---\nPlan body.\n');
  fs.writeFileSync(path.join(memDir, 'release_v0136.md'), [
    '---', 'name: release-v0136', 'description: release', '---',
    'See [[cross-project-replies-plan]].',
    'Law lives in `architecture/domain-model.md`.',
    'Helper was `src/old/widget.cjs`.',
    'Gone: `src/never/existed.cjs`.',
    '',
  ].join('\n'));
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('stale() resolves kebab links, ops-root paths and git renames', async () => {
  const r = await tool.stale({ workspace: WS, cwd: repo }, { projectRoots: () => [repo] });
  assert.equal(r.error, null);
  const e = r.entries.find((x) => x.name === 'release_v0136.md');
  assert.ok(e, 'entry present');
  assert.deepEqual(e.danglingLinks, []);
  assert.ok(e.outLinks.includes('cross_project_replies_plan'));
  assert.ok(!e.deadRefs.includes('architecture/domain-model.md'), 'ops-root path is not dead');
  assert.ok(!e.deadRefs.includes('src/old/widget.cjs'), 'renamed path is not dead');
  assert.deepEqual(e.movedRefs, [{ from: 'src/old/widget.cjs', to: 'src/new/widget.cjs' }]);
  assert.deepEqual(e.deadRefs, ['src/never/existed.cjs']);
  for (const x of r.entries) assert.ok(Array.isArray(x.movedRefs));
  const target = r.entries.find((x) => x.name === 'cross_project_replies_plan.md');
  assert.equal(target.inboundLinks, 1);
});
