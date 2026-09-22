/**
 * epicWorktreeProjectConfig.test.cjs — PRD 1035/1390: the per-project "disable
 * Epic worktree isolation" UI toggle, now stored at
 * `<cwd>/session-manager-operations/prompt-sessions/epic-worktree-config.json`
 * instead of a single machine-wide map. Uses real mkdtemp'd project cwds (the
 * same convention as epicStatusMirror.test.cjs) since the file location is
 * now derived from `cwd` via opsPath(), not from a single overridable path.
 * SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH still points the LEGACY global map (the
 * one-shot migration source) at a throwaway tmpdir file, so tests never touch
 * the real ~/.claude/session-manager/epic-worktree-project-config.json.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicWorktreeProjectConfig.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpRoot;
let legacyConfigFile;
let originalOverride;
const projectDirs = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-worktree-project-config-'));
  legacyConfigFile = path.join(tmpRoot, 'legacy-config.json');
  originalOverride = process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH;
  process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH = legacyConfigFile;
});

afterEach(() => {
  if (originalOverride === undefined) delete process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH;
  else process.env.SM_EPIC_WORKTREE_PROJECT_CONFIG_PATH = originalOverride;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  while (projectDirs.length) fs.rmSync(projectDirs.pop(), { recursive: true, force: true });
});

function freshModule() {
  return require('../epicWorktreeProjectConfig.cjs');
}

function mkProjectCwd(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sm-epic-worktree-project-${name}-`));
  projectDirs.push(dir);
  return dir;
}

function perProjectFile(m, cwd) {
  return m.perProjectConfigPath(cwd);
}

test('defaults to not disabled for a project never touched', () => {
  const m = freshModule();
  const cwd = mkProjectCwd('a');
  expect(m.isEpicWorktreeDisabledForProject(cwd)).toBe(false);
});

test('setEpicWorktreeDisabledForProject(true) persists across a fresh read, in the per-project ops file', () => {
  const m = freshModule();
  const cwd = mkProjectCwd('a');
  m.setEpicWorktreeDisabledForProject(cwd, true);
  expect(m.isEpicWorktreeDisabledForProject(cwd)).toBe(true);
  const file = perProjectFile(m, cwd);
  expect(fs.existsSync(file)).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ disabled: true });
});

test('is scoped per cwd — a different project is unaffected', () => {
  const m = freshModule();
  const cwdA = mkProjectCwd('a');
  const cwdB = mkProjectCwd('b');
  m.setEpicWorktreeDisabledForProject(cwdA, true);
  expect(m.isEpicWorktreeDisabledForProject(cwdB)).toBe(false);
});

test('setEpicWorktreeDisabledForProject(false) writes disabled:false rather than deleting the file', () => {
  const m = freshModule();
  const cwd = mkProjectCwd('a');
  m.setEpicWorktreeDisabledForProject(cwd, true);
  m.setEpicWorktreeDisabledForProject(cwd, false);
  expect(m.isEpicWorktreeDisabledForProject(cwd)).toBe(false);
  const file = perProjectFile(m, cwd);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ disabled: false });
});

test('a missing or corrupt per-project config file reads as not-disabled rather than throwing', () => {
  const m = freshModule();
  const cwd = mkProjectCwd('a');
  const file = perProjectFile(m, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not valid json');
  expect(m.isEpicWorktreeDisabledForProject(cwd)).toBe(false);
});

test('isEpicWorktreeDisabledForProject rejects a non-string cwd instead of throwing', () => {
  const m = freshModule();
  expect(m.isEpicWorktreeDisabledForProject(null)).toBe(false);
  expect(m.isEpicWorktreeDisabledForProject(undefined)).toBe(false);
});

test('one-shot migration: a legacy global entry seeds the new per-project file on first read', () => {
  const m = freshModule();
  const cwd = mkProjectCwd('a');
  fs.writeFileSync(legacyConfigFile, JSON.stringify({ [cwd]: true }));

  expect(m.isEpicWorktreeDisabledForProject(cwd)).toBe(true);
  const file = perProjectFile(m, cwd);
  expect(fs.existsSync(file)).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ disabled: true });

  // The legacy file itself is left in place, untouched.
  expect(JSON.parse(fs.readFileSync(legacyConfigFile, 'utf8'))).toEqual({ [cwd]: true });
});

test('migration leaves the legacy map intact for OTHER, still-unmigrated projects', () => {
  const m = freshModule();
  const cwdA = mkProjectCwd('a');
  const cwdB = mkProjectCwd('b');
  fs.writeFileSync(legacyConfigFile, JSON.stringify({ [cwdA]: true, [cwdB]: true }));

  // Touching cwdA migrates only cwdA's own per-project file.
  expect(m.isEpicWorktreeDisabledForProject(cwdA)).toBe(true);
  expect(fs.existsSync(perProjectFile(m, cwdB))).toBe(false);

  // cwdB still resolves correctly straight from the untouched legacy map.
  expect(m.isEpicWorktreeDisabledForProject(cwdB)).toBe(true);
});

test('a project with no legacy entry migrates to disabled:false without throwing', () => {
  const m = freshModule();
  const cwd = mkProjectCwd('a');
  fs.writeFileSync(legacyConfigFile, JSON.stringify({ '/some/other/project': true }));
  expect(m.isEpicWorktreeDisabledForProject(cwd)).toBe(false);
});
