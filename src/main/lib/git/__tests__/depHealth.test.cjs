/**
 * depHealth.test.cjs — checkMainDependencyHealth branches + a real pnpm repair round-trip.
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/depHealth.test.cjs
 */

'use strict';

import { test, expect, describe, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkMainDependencyHealth, findWorktreeEscapingLinks, repairMainDependencies } = require('../depHealth.cjs');

const hasPnpm = (() => {
  try { execFileSync('pnpm', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

let dir;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dephealth-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const write = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
const pkgJson = (deps) => JSON.stringify({ name: 'root', dependencies: deps });

test('not-pnpm: no lockfile is skipped', () => {
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: true, skipped: 'not-pnpm' });
});

test('node_modules-missing', () => {
  write('pnpm-lock.yaml', '');
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: false, reason: 'node_modules-missing' });
});

test('modules-yaml-missing', () => {
  write('pnpm-lock.yaml', '');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: false, reason: 'modules-yaml-missing' });
});

test('unresolved-deps lists the missing name', () => {
  write('pnpm-lock.yaml', '');
  write('package.json', pkgJson({ present: '1.0.0', gone: '1.0.0' }));
  write('node_modules/.modules.yaml', '');
  write('node_modules/present/package.json', '{}');
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: false, reason: 'unresolved-deps', missing: ['gone'] });
});

test('dangling symlink counts as missing (caught by the link scan before the deps check)', () => {
  write('pnpm-lock.yaml', '');
  write('package.json', pkgJson({ dangling: '1.0.0' }));
  write('node_modules/.modules.yaml', '');
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'node_modules', 'dangling'));
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: false, reason: 'dangling-links', missing: ['dangling'] });
});

test('ok when all deps resolve', () => {
  write('pnpm-lock.yaml', '');
  write('package.json', pkgJson({ present: '1.0.0' }));
  write('node_modules/.modules.yaml', '');
  write('node_modules/present/package.json', '{}');
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: true });
});

test('malformed package.json is skipped', () => {
  write('pnpm-lock.yaml', '');
  write('package.json', '{nope');
  write('node_modules/.modules.yaml', '');
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: true, skipped: 'no-package-json' });
});

test.skipIf(!hasPnpm)('repair restores a deleted workspace dep', async () => {
  write('package.json', JSON.stringify({ name: 'root', private: true, dependencies: { lib: 'workspace:*' } }));
  write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  write('packages/lib/package.json', JSON.stringify({ name: 'lib', version: '1.0.0' }));
  execFileSync('pnpm', ['install', '--offline'], { cwd: dir, env: { ...process.env, CI: '1' }, stdio: 'pipe' });
  // pnpm 10 writes no .modules.yaml for a workspace-only install; real projects (registry deps) have one.
  const modulesYaml = path.join(dir, 'node_modules', '.modules.yaml');
  if (!fs.existsSync(modulesYaml)) fs.writeFileSync(modulesYaml, '');
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: true });

  fs.rmSync(path.join(dir, 'node_modules', 'lib'), { recursive: true, force: true });
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: false, reason: 'unresolved-deps', missing: ['lib'] });

  const res = await repairMainDependencies(dir);
  expect(res.ok).toBe(true);
  expect(checkMainDependencyHealth(dir)).toEqual({ ok: true });
}, 60_000);

describe('worktree-escaping links', () => {
  const setup = () => {
    write('pnpm-lock.yaml', '');
    write('package.json', pkgJson({}));
    write('node_modules/.modules.yaml', '');
    const wt = path.join(dir, 'fake-wt-root');
    fs.mkdirSync(path.join(wt, 'job1', 'packages', 'a'), { recursive: true });
    return wt;
  };

  test('link into worktree root -> links-into-worktree', () => {
    const wt = setup();
    fs.symlinkSync(path.join(wt, 'job1', 'packages', 'a'), path.join(dir, 'node_modules', 'a'));
    expect(checkMainDependencyHealth(dir, { worktreeRoots: [wt] }))
      .toEqual({ ok: false, reason: 'links-into-worktree', missing: ['a'] });
  });

  test('scoped link into worktree is listed as @s/x', () => {
    const wt = setup();
    fs.mkdirSync(path.join(dir, 'node_modules', '@s'), { recursive: true });
    fs.symlinkSync(path.join(wt, 'job1', 'packages', 'a'), path.join(dir, 'node_modules', '@s', 'x'));
    expect(findWorktreeEscapingLinks(dir, { worktreeRoots: [wt] }))
      .toEqual({ intoWorktree: ['@s/x'], dangling: [] });
  });

  test('dangling link -> dangling-links', () => {
    const wt = setup();
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'node_modules', 'gone'));
    expect(checkMainDependencyHealth(dir, { worktreeRoots: [wt] }))
      .toEqual({ ok: false, reason: 'dangling-links', missing: ['gone'] });
  });

  test('sibling link inside mainCwd is ok', () => {
    const wt = setup();
    write('packages/a/package.json', '{}');
    fs.symlinkSync(path.join('..', 'packages', 'a'), path.join(dir, 'node_modules', 'a'));
    expect(checkMainDependencyHealth(dir, { worktreeRoots: [wt] })).toEqual({ ok: true });
  });
});
