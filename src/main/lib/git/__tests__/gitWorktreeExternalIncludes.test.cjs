/**
 * gitWorktreeExternalIncludes.test.cjs — createWorktree copies the parent's
 * CLAUDE.md external-include approval onto the new worktree path in a temp
 * CLAUDE_CONFIG_DIR (never the real home config).
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/gitWorktreeExternalIncludes.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');

const A = 'hasClaudeMdExternalIncludesApproved';
const W = 'hasClaudeMdExternalIncludesWarningShown';
const ENV = ['CLAUDE_CONFIG_DIR', 'SM_WORKTREE_ROOT', 'SM_JOB_WORKTREE_DISABLE', 'SM_EPIC_WORKTREE_DISABLE', 'SM_JOB_WORKTREE_MAX', 'SM_EPIC_WORKTREE_MAX', 'SM_WORKTREE_DEP_LINK_DISABLE'];
let saved; let tmpRoot; let repo; let cfgFile;

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gw-incl-'));
  repo = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const cfgDir = path.join(tmpRoot, 'cfg');
  fs.mkdirSync(cfgDir);
  cfgFile = path.join(cfgDir, '.claude.json');
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  process.env.SM_WORKTREE_ROOT = path.join(tmpRoot, 'worktrees');
  process.env.SM_WORKTREE_DEP_LINK_DISABLE = '1';
  for (const k of ['SM_JOB_WORKTREE_DISABLE', 'SM_EPIC_WORKTREE_DISABLE', 'SM_JOB_WORKTREE_MAX', 'SM_EPIC_WORKTREE_MAX']) delete process.env[k];
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
  gitWorktree._resetActiveWorktreeCountForTests('epic', 0);
  gitWorktree._resetObservedWorktreeCountCacheForTests();
});

afterEach(() => {
  try { git(['worktree', 'prune'], repo); } catch { /* ignore */ }
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const writeCfg = (approved) => fs.writeFileSync(cfgFile, JSON.stringify({ projects: { [fs.realpathSync(repo)]: { [A]: approved, hasTrustDialogAccepted: true } } }, null, 2) + '\n');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

test('approved parent: epic and job worktrees inherit both flags (and epic reuse keeps them)', async () => {
  writeCfg(true);
  const epic = await gitWorktree.createEpicWorktree({ cwd: repo, epicId: 'e1' });
  const job = await gitWorktree.createJobWorktree({ cwd: repo, slug: 'j1' });
  expect(epic.ok).toBe(true);
  expect(job.ok).toBe(true);
  for (const dir of [epic.dir, job.dir]) {
    const entry = readCfg().projects[path.resolve(dir)];
    expect(entry[A]).toBe(true);
    expect(entry[W]).toBe(true);
    expect(entry.hasTrustDialogAccepted).toBe(false);
  }
  // Reuse path backfills an entry that went missing.
  const cfg = readCfg();
  delete cfg.projects[path.resolve(epic.dir)];
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const again = await gitWorktree.createEpicWorktree({ cwd: repo, epicId: 'e1' });
  expect(again.reused).toBe(true);
  expect(readCfg().projects[path.resolve(epic.dir)][A]).toBe(true);
});

test('unapproved parent: config file is byte-identical', async () => {
  writeCfg(false);
  const before = fs.readFileSync(cfgFile);
  expect((await gitWorktree.createEpicWorktree({ cwd: repo, epicId: 'e2' })).ok).toBe(true);
  expect((await gitWorktree.createJobWorktree({ cwd: repo, slug: 'j2' })).ok).toBe(true);
  expect(fs.readFileSync(cfgFile).equals(before)).toBe(true);
});

test('malformed config: creation still returns ok', async () => {
  fs.writeFileSync(cfgFile, '{not json');
  expect((await gitWorktree.createEpicWorktree({ cwd: repo, epicId: 'e3' })).ok).toBe(true);
  expect((await gitWorktree.createJobWorktree({ cwd: repo, slug: 'j3' })).ok).toBe(true);
  expect(fs.readFileSync(cfgFile, 'utf8')).toBe('{not json');
});
