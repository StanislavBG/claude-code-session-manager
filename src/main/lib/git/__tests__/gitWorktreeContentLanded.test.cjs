/**
 * gitWorktreeContentLanded.test.cjs — `isBranchContentLanded`, the
 * content-based "is this branch already integrated?" check. Since linear
 * landing (PRDs 2743, 2825) a landed branch's own commits are replayed, never
 * made ancestors of the base, so an ancestry-only check reads a landed branch
 * as unmerged (validator finding I-2). The cases below pin each of the
 * helper's three proofs — ancestry, patch-id equivalence (`rev-list
 * --cherry-pick`), and a merge that changes nothing (`merge-tree
 * --write-tree` == base tree) — and each of its refusals.
 *
 * Exercises real git plumbing against throwaway repos under os.tmpdir()
 * (fast — no network, no Electron).
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/gitWorktreeContentLanded.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');

let tmpRoot;
let repoCwd;

function git(args, cwd = repoCwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Ten numbered lines, so a one-line hunk keeps its neighbours as diff context.
const text = (overrides = {}) =>
  Array.from({ length: 10 }, (_, i) => overrides[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

function commit(file, content, msg) {
  fs.writeFileSync(path.join(repoCwd, file), content, 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']).trim();
}

function isAncestor(a, b) {
  try {
    git(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

const cherryCount = (base, branch) =>
  git(['rev-list', '--right-only', '--cherry-pick', '--no-merges', '--count', `${base}...${branch}`]).trim();

const landed = (opts) => gitWorktree.isBranchContentLanded({ cwd: repoCwd, ...opts });

/** `feature` edits line 5 of f.txt; HEAD is back on main afterwards. */
function featureEditsLine5() {
  git(['checkout', '-q', '-b', 'feature']);
  commit('f.txt', text({ 5: 'line 5 (feature)' }), 'feature edits line 5');
  git(['checkout', '-q', 'main']);
}

/** Replays `feature` onto main's tip and lands it: main fast-forwards to the replay tip. */
async function replayAndLand() {
  const onto = git(['rev-parse', 'main']).trim();
  const r = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: onto, branch: 'feature' });
  expect(r.ok).toBe(true);
  expect(r.fastForward).toBeUndefined();
  expect(r.replayed).toHaveLength(1);
  git(['merge', '-q', '--ff-only', r.tipSha]);
  expect(git(['rev-parse', 'main']).trim()).toBe(r.tipSha);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-content-landed-'));
  repoCwd = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoCwd, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  commit('f.txt', text(), 'initial');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a branch or base that does not resolve -> null; bad input never throws', async () => {
  expect(await landed({ branch: 'no-such-branch' })).toBeNull();
  expect(await landed({ base: 'no-such-base', branch: 'main' })).toBeNull();
  expect(await landed({})).toBeNull();
  expect(await gitWorktree.isBranchContentLanded()).toBeNull();
  expect(await gitWorktree.isBranchContentLanded({ cwd: tmpRoot, branch: 'main' })).toBeNull();
});

test('a branch whose tip is an ancestor of base -> true', async () => {
  git(['checkout', '-q', '-b', 'feature']);
  commit('feature.txt', 'feature\n', 'feature work');
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--ff-only', 'feature']);
  commit('other.txt', 'main work\n', 'main moves on');

  expect(isAncestor('feature', 'main')).toBe(true);
  expect(await landed({ branch: 'feature' })).toBe(true);
  expect(await landed({ base: 'main', branch: 'feature' })).toBe(true);
  expect(await landed({ branch: 'main' })).toBe(true);
});

test('a branch replayed onto a moved base and landed -> true while the ancestry check is false', async () => {
  featureEditsLine5();
  commit('other.txt', 'main work\n', 'main moves on');
  await replayAndLand();

  expect(isAncestor('feature', 'main')).toBe(false);
  expect(cherryCount('main', 'feature')).toBe('0');
  expect(await landed({ branch: 'feature' })).toBe(true);
  expect(await landed({ base: 'main', branch: 'feature' })).toBe(true);
});

test('a replay whose context shifted (base changed a line next to the hunk first) -> true', async () => {
  featureEditsLine5();
  // Line 3 sits inside line 5's diff context but is not adjacent to it: the
  // replay is clean, yet the replayed commit's patch-id differs from the
  // original's, so only the merged-tree proof can see the branch as landed.
  commit('f.txt', text({ 3: 'line 3 (main)' }), 'main edits line 3');
  await replayAndLand();

  expect(isAncestor('feature', 'main')).toBe(false);
  expect(cherryCount('main', 'feature')).toBe('1');
  expect(await landed({ branch: 'feature' })).toBe(true);
});

test('a branch with unlanded work -> false', async () => {
  featureEditsLine5();
  commit('other.txt', 'main work\n', 'main moves on');
  expect(await landed({ branch: 'feature' })).toBe(false);

  // Landed, then the branch grows a commit the base never saw.
  await replayAndLand();
  git(['checkout', '-q', 'feature']);
  commit('f.txt', text({ 5: 'line 5 (feature)', 9: 'line 9 (feature, later)' }), 'feature edits line 9 after landing');
  git(['checkout', '-q', 'main']);
  expect(cherryCount('main', 'feature')).toBe('1');
  expect(await landed({ branch: 'feature' })).toBe(false);
});

test('a branch conflicting with base -> false', async () => {
  featureEditsLine5();
  commit('f.txt', text({ 5: 'line 5 (main)' }), 'main edits line 5 differently');

  expect(() => git(['merge-tree', '--write-tree', '--no-messages', 'main', 'feature'])).toThrow();
  expect(await landed({ branch: 'feature' })).toBe(false);
});

test('a name starting with "-" resolves only via refs/heads/, never as an option', async () => {
  const first = git(['rev-parse', 'HEAD']).trim();
  git(['update-ref', 'refs/heads/-x', first]);
  commit('other.txt', 'main work\n', 'main moves on');

  expect(await landed({ branch: '-x' })).toBe(true);
  expect(await landed({ base: '-x', branch: 'main' })).toBe(false);
  expect(await landed({ branch: '--no-such' })).toBeNull();
});
