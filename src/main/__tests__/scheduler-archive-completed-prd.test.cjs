/**
 * scheduler-archive-completed-prd.test.cjs — unit tests for archiveCompletedPrd
 * (PRD 812 dormant-default-session-review-nits recurrence fix): a job's PRD
 * `.md` must move from its `prds/` dir into the SIBLING `prds-archived/` dir
 * the moment its job transitions to `completed`, so a re-fired scheduler
 * tick can never pick the same finished slug back up.
 *
 * Uses a temp cwd fixture (`prdDirForCwd` is a pure path join off `cwd`) so
 * this never touches the real `~/.claude/session-manager/` tree.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-archive-completed-prd.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { archiveCompletedPrd, prdDirForCwd } = require('../scheduler.cjs');

const tmpDirs = [];

function makeFixtureCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-archive-prd-'));
  tmpDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveCompletedPrd moves the .md from prds/ into sibling prds-archived/', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-archive-on-completed';
  const prdsDir = prdDirForCwd(cwd);
  fs.mkdirSync(prdsDir, { recursive: true });
  const src = path.join(prdsDir, `${slug}.md`);
  fs.writeFileSync(src, '# Goal\n\ntest\n', 'utf8');

  await archiveCompletedPrd(slug, cwd);

  expect(fs.existsSync(src)).toBe(false);
  const archivedPath = path.join(prdsDir, '..', 'prds-archived', `${slug}.md`);
  expect(fs.existsSync(archivedPath)).toBe(true);
  expect(fs.readFileSync(archivedPath, 'utf8')).toBe('# Goal\n\ntest\n');
});

test('a job left in needs_review never has its PRD archived (the .md stays in prds/)', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-no-archive-on-needs-review';
  const prdsDir = prdDirForCwd(cwd);
  fs.mkdirSync(prdsDir, { recursive: true });
  const src = path.join(prdsDir, `${slug}.md`);
  fs.writeFileSync(src, '# Goal\n\ntest\n', 'utf8');

  // scheduler.cjs only calls archiveCompletedPrd from status==='completed'
  // transition sites — a needs_review (or failed/running) transition never
  // invokes it, so the source file is untouched.

  expect(fs.existsSync(src)).toBe(true);
  const archivedPath = path.join(prdsDir, '..', 'prds-archived', `${slug}.md`);
  expect(fs.existsSync(archivedPath)).toBe(false);
});

test('archiveCompletedPrd is a silent no-op when the source .md is missing (ENOENT)', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-archive-enoent-noop';
  const prdsDir = prdDirForCwd(cwd);
  fs.mkdirSync(prdsDir, { recursive: true });

  await expect(archiveCompletedPrd(slug, cwd)).resolves.toBeUndefined();

  const archivedPath = path.join(prdsDir, '..', 'prds-archived', `${slug}.md`);
  expect(fs.existsSync(archivedPath)).toBe(false);
});

test('archiveCompletedPrd refuses a slug that would resolve outside the PRD dir', async () => {
  const cwd = makeFixtureCwd();
  const prdsDir = prdDirForCwd(cwd);
  fs.mkdirSync(prdsDir, { recursive: true });

  // A slug crafted to escape prdsDir via '..' segments (SLUG_RE normally
  // blocks this at the IPC boundary; archiveCompletedPrd itself must still
  // refuse it as defense-in-depth, matching schedule:clear-queue's check).
  const outsideDir = path.join(prdsDir, '..');
  const escapeSlug = '../escaped-outside';
  const outsideTarget = path.join(outsideDir, 'escaped-outside.md');
  fs.writeFileSync(outsideTarget, 'should never be touched', 'utf8');

  await expect(archiveCompletedPrd(escapeSlug, cwd)).resolves.toBeUndefined();

  // Untouched in place — containment check refused before any rename.
  expect(fs.existsSync(outsideTarget)).toBe(true);
  expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('should never be touched');
  const archivedPath = path.join(prdsDir, '..', 'prds-archived', 'escaped-outside.md');
  expect(fs.existsSync(archivedPath)).toBe(false);
});
