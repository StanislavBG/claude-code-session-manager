/**
 * epicWorktreeProjectConfig.test.cjs — PRD 1035: the per-project "disable
 * Epic worktree isolation" UI toggle. Points the module at a throwaway
 * tmpdir file via SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH so it never touches
 * the real ~/.claude/session-manager/epic-worktree-project-config.json on
 * the machine running the tests.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicWorktreeProjectConfig.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpRoot;
let configFile;
let originalOverride;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-worktree-project-config-'));
  configFile = path.join(tmpRoot, 'config.json');
  originalOverride = process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH;
  process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH = configFile;
});

afterEach(() => {
  if (originalOverride === undefined) delete process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH;
  else process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH = originalOverride;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function freshModule() {
  return require('../epicWorktreeProjectConfig.cjs');
}

test('defaults to not disabled for a project never touched', () => {
  const m = freshModule();
  expect(m.isEpicWorktreeDisabledForProject('/some/project')).toBe(false);
});

test('setEpicWorktreeDisabledForProject(true) persists across a fresh read', () => {
  const m = freshModule();
  m.setEpicWorktreeDisabledForProject('/proj/a', true);
  expect(m.isEpicWorktreeDisabledForProject('/proj/a')).toBe(true);
  expect(fs.existsSync(configFile)).toBe(true);
  const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  expect(onDisk).toEqual({ '/proj/a': true });
});

test('is scoped per cwd — a different project is unaffected', () => {
  const m = freshModule();
  m.setEpicWorktreeDisabledForProject('/proj/a', true);
  expect(m.isEpicWorktreeDisabledForProject('/proj/b')).toBe(false);
});

test('setEpicWorktreeDisabledForProject(false) clears the entry rather than writing false', () => {
  const m = freshModule();
  m.setEpicWorktreeDisabledForProject('/proj/a', true);
  m.setEpicWorktreeDisabledForProject('/proj/a', false);
  expect(m.isEpicWorktreeDisabledForProject('/proj/a')).toBe(false);
  const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  expect(onDisk).toEqual({});
});

test('a missing or corrupt config file reads as not-disabled rather than throwing', () => {
  const m = freshModule();
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '{ not valid json');
  expect(m.isEpicWorktreeDisabledForProject('/proj/a')).toBe(false);
});

test('isEpicWorktreeDisabledForProject rejects a non-string cwd instead of throwing', () => {
  const m = freshModule();
  expect(m.isEpicWorktreeDisabledForProject(null)).toBe(false);
  expect(m.isEpicWorktreeDisabledForProject(undefined)).toBe(false);
});
