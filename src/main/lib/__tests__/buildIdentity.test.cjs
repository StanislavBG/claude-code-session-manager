/**
 * buildIdentity.test.cjs — resolveBuildIdentity() resolution order:
 * build-info.json first, git fallback only when a real .git sits AT the
 * package root (never walking up), else null.
 *
 * Each test injects a distinct fixture `packageRoot` (see buildIdentity.cjs's
 * `opts.packageRoot`), which also keeps memoization scoped per-root so the
 * three cases don't clobber each other's cached result in one process.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/buildIdentity.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveBuildIdentity } = require('../buildIdentity.cjs');

const cleanupDirs = [];

function mkFixtureRoot(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'main'), { recursive: true });
  return dir;
}

function writePackageJson(root, version) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-pkg', version }));
}

function mkRealGitRepo(root) {
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init']);
  return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
}

afterEach(() => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('build-info.json present: its fields win over both git and package.json', () => {
  const root = mkFixtureRoot('sm-buildid-present-');
  writePackageJson(root, '0.1.0');
  fs.writeFileSync(path.join(root, 'src', 'main', 'build-info.json'), JSON.stringify({
    version: '9.9.9',
    gitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    gitShortSha: 'deadbee',
    gitBranch: 'main',
    builtAt: '2026-01-01T00:00:00.000Z',
    dirty: false,
  }));

  const identity = resolveBuildIdentity({ packageRoot: root, bootedAt: '2026-02-02T00:00:00.000Z' });

  expect(identity.version).toBe('9.9.9');
  expect(identity.codeSha).toBe('deadbee');
  expect(identity.builtAt).toBe('2026-01-01T00:00:00.000Z');
  expect(identity.appPath).toBe(root);
  expect(identity.bootedAt).toBe('2026-02-02T00:00:00.000Z');
});

test('build-info.json absent, real .git at the package root: codeSha falls back to git, builtAt stays null', () => {
  const root = mkFixtureRoot('sm-buildid-git-');
  writePackageJson(root, '1.2.3');
  const sha = mkRealGitRepo(root);

  const identity = resolveBuildIdentity({ packageRoot: root });

  expect(identity.version).toBe('1.2.3');
  expect(identity.codeSha).toBe(sha);
  expect(identity.builtAt).toBeNull();
});

test('build-info.json absent, no .git at the package root: codeSha is null, never walks up to an ancestor .git', () => {
  const ancestor = mkFixtureRoot('sm-buildid-ancestor-');
  mkRealGitRepo(ancestor); // a real repo one level UP from the fixture root — must never be found
  const root = path.join(ancestor, 'nested-pkg');
  fs.mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
  writePackageJson(root, '2.0.0');

  const identity = resolveBuildIdentity({ packageRoot: root });

  expect(identity.version).toBe('2.0.0');
  expect(identity.codeSha).toBeNull();
  expect(identity.builtAt).toBeNull();
});

test('bootedAt is echoed back verbatim, never re-captured, and defaults to null', () => {
  const root = mkFixtureRoot('sm-buildid-bootedat-');
  writePackageJson(root, '1.0.0');

  expect(resolveBuildIdentity({ packageRoot: root }).bootedAt).toBeNull();
  expect(resolveBuildIdentity({ packageRoot: root, bootedAt: 'fixed-value' }).bootedAt).toBe('fixed-value');
});

test('installChannel is reused from machineProfile.resolveInstallChannel, keyed off appPath', () => {
  const root = mkFixtureRoot('sm-buildid-channel-');
  writePackageJson(root, '1.0.0');
  const prevSmDev = process.env.SM_DEV;
  delete process.env.SM_DEV;
  try {
    const identity = resolveBuildIdentity({ packageRoot: root });
    // fixture root lives under os.tmpdir(), not an .npm/_npx cache path, and
    // SM_DEV is unset here, so resolveInstallChannel falls through to 'unknown'.
    expect(identity.installChannel).toBe('unknown');
  } finally {
    if (prevSmDev === undefined) delete process.env.SM_DEV;
    else process.env.SM_DEV = prevSmDev;
  }
});
