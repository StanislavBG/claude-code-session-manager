/**
 * scheduler-porcelain-rename.test.cjs — PRD 1187/1186-follow-on: a staged
 * rename ("R  old -> new") was parsed by `parsePorcelainEntries` as ONE fused
 * path string `"old -> new"`. That string can never match a real path in
 * `dirtyAfter`, `pathsCommittedDuringRun`, or an `fs.existsSync` check, so
 * every staged rename in a shared-tree-guard baseline was structurally
 * guaranteed to be reported reverted — even when it was cleanly committed
 * during the run. On 2026-09-12 this flagged 45 paths and parked a clean,
 * committed run (job `1187-autoresolve-guard-verdict-parks`):
 *
 *   "job discarded pre-existing state in the shared tree: 45 path(s)
 *   reverted with no commit to explain it
 *   (scripts/__tests__/manual-chapter-links.test.cjs ->
 *   web/manual/__tests__/chapter-links.test.cjs, ...)" — exit 0, landedCommit
 *   recorded, nothing actually lost.
 *
 * Every test below is written to FAIL against the pre-fix implementation
 * (`path: l.slice(3)`, no rename/quote parsing at all).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-porcelain-rename.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const scheduler = require('../scheduler.cjs');
const { parsePorcelainEntries, evaluateSharedTreeGuard } = scheduler;

// --- parsePorcelainEntries: rename/copy lines split into real components ---

test('parsePorcelainEntries: a plain staged rename splits into new path + oldPath, not one fused string', () => {
  const entries = parsePorcelainEntries('R  old.txt -> new.txt\n');
  expect(entries).toEqual([{ code: 'R ', path: 'new.txt', oldPath: 'old.txt' }]);
});

test('parsePorcelainEntries: a rename-with-worktree-modification (RM) line still splits correctly', () => {
  const entries = parsePorcelainEntries('RM old.txt -> new.txt\n');
  expect(entries).toEqual([{ code: 'RM', path: 'new.txt', oldPath: 'old.txt' }]);
});

test('parsePorcelainEntries: a copy line (C) splits the same way as a rename', () => {
  const entries = parsePorcelainEntries('C  old.txt -> copy.txt\n');
  expect(entries).toEqual([{ code: 'C ', path: 'copy.txt', oldPath: 'old.txt' }]);
});

test('parsePorcelainEntries: a NEW path containing a space is quoted by git and must be unquoted', () => {
  // Real `git status --porcelain` output for `git mv new.txt "renamed with space.txt"`.
  const entries = parsePorcelainEntries('R  new.txt -> "renamed with space.txt"\n');
  expect(entries).toEqual([{ code: 'R ', path: 'renamed with space.txt', oldPath: 'new.txt' }]);
});

test('parsePorcelainEntries: an OLD path containing a space is quoted independently of the new path', () => {
  const entries = parsePorcelainEntries('R  "old with space.txt" -> new.txt\n');
  expect(entries).toEqual([{ code: 'R ', path: 'new.txt', oldPath: 'old with space.txt' }]);
});

test('parsePorcelainEntries: a non-ASCII path is quoted with per-byte octal escapes and must decode back to UTF-8', () => {
  // Real recorded `git status --porcelain` output for a rename onto
  // "résumé file.txt" — git's default core.quotepath escapes each raw UTF-8
  // byte >= 0x80 as \NNN octal: 'é' is UTF-8 bytes 0xC3 0xA9 -> \303\251.
  const line = 'R  new.txt -> "r\\303\\251sum\\303\\251 file.txt"\n';
  const entries = parsePorcelainEntries(line);
  expect(entries).toEqual([{ code: 'R ', path: 'résumé file.txt', oldPath: 'new.txt' }]);
});

test('parsePorcelainEntries: non-rename entries are unaffected (no oldPath, path as before)', () => {
  const entries = parsePorcelainEntries(' M src/foo.js\n?? untracked.txt\n');
  expect(entries).toEqual([
    { code: ' M', path: 'src/foo.js' },
    { code: '??', path: 'untracked.txt' },
  ]);
});

test('parsePorcelainEntries: a quoted plain (non-rename) path is also unquoted, not left with literal quotes', () => {
  const entries = parsePorcelainEntries('?? "plain space.txt"\n');
  expect(entries).toEqual([{ code: '??', path: 'plain space.txt' }]);
});

// --- The exact 1187 shape: committed rename must not be flagged reverted ---

test('evaluateSharedTreeGuard: a staged rename that is committed during the run is NOT reported reverted (real 1187 case)', () => {
  const oldPath = 'scripts/__tests__/manual-chapter-links.test.cjs';
  const newPath = 'web/manual/__tests__/chapter-links.test.cjs';
  const dirtyBefore = parsePorcelainEntries(`R  ${oldPath} -> ${newPath}\n`);
  // git diff --name-only <headBefore>..<headAfter> reports only the NEW path
  // for a committed rename (verified against real git 2.43 behavior).
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore,
    dirtyAfter: [], // fully committed, nothing left dirty
    pathsCommittedDuringRun: [newPath],
  });
  expect(result.reverted).toEqual([]);
});

test('evaluateSharedTreeGuard: a batch of committed renames (the real 45-path shape) are all cleared, none reverted', () => {
  const pairs = [
    ['scripts/__tests__/manual-chapter-links.test.cjs', 'web/manual/__tests__/chapter-links.test.cjs'],
    ['scripts/foo-old.js', 'src/foo-new.js'],
    ['docs/old-name.md', 'docs/new-name.md'],
  ];
  const porcelain = pairs.map(([o, n]) => `R  ${o} -> ${n}`).join('\n') + '\n';
  const dirtyBefore = parsePorcelainEntries(porcelain);
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore,
    dirtyAfter: [],
    pathsCommittedDuringRun: pairs.map(([, n]) => n),
  });
  expect(result.reverted).toEqual([]);
});

// --- The guard's real purpose survives: an UNDONE rename still parks ---

test('evaluateSharedTreeGuard: a staged rename that is UNDONE (old path restored, new path gone, nothing committed) IS still reported reverted', () => {
  // This test must FAIL if the fix is implemented as "blanket skip rename
  // entries" (dropping every rename-coded entry from consideration would
  // make `reverted` come back empty here, exactly like the committed case
  // above — but here nothing was committed to explain the disappearance).
  const dirtyBefore = parsePorcelainEntries('R  old.txt -> new.txt\n');
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore,
    dirtyAfter: [], // clean again — reverted to HEAD, old.txt restored, new.txt gone
    pathsCommittedDuringRun: [], // nothing committed
  });
  expect(result.reverted).toEqual(['new.txt']);
});

// --- The two already-fixed false-positive classes stay fixed (pinned here
// too, using parsePorcelainEntries as the real entry point rather than
// hand-built fixtures, so a future change to the parser can't silently
// regress them without failing a test right next to the rename fix). ---

test('evaluateSharedTreeGuard: nowIgnored still works for a real parsePorcelainEntries untracked baseline entry', () => {
  const dirtyBefore = parsePorcelainEntries('?? session-manager-operations/logs/errors-2026-09-12.jsonl\n');
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore,
    dirtyAfter: [],
    pathsCommittedDuringRun: ['.gitignore'],
    existsAfter: ['session-manager-operations/logs/errors-2026-09-12.jsonl'],
  });
  expect(result.reverted).toEqual([]);
  expect(result.nowIgnored).toEqual(['session-manager-operations/logs/errors-2026-09-12.jsonl']);
});

test('evaluateSharedTreeGuard: a genuine deletion of an untracked path (from a real parsePorcelainEntries entry) is still reverted', () => {
  const dirtyBefore = parsePorcelainEntries('?? data/scratch.txt\n');
  const result = evaluateSharedTreeGuard({
    stashBefore: [],
    stashAfter: [],
    dirtyBefore,
    dirtyAfter: [],
    pathsCommittedDuringRun: [],
    existsAfter: [],
  });
  expect(result.reverted).toEqual(['data/scratch.txt']);
  expect(result.nowIgnored).toEqual([]);
});
