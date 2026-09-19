/**
 * package-files.test.cjs — packaging regression test. Ensures
 * scripts/scheduler-mcp-server.cjs (and any future required file) is never
 * silently dropped from package.json's "files" array again, since a dropped
 * file means the scheduler_create_prd MCP tool can never register on any
 * machine that installed via npx.
 *
 * Also (PRD 1093, closing the Project Home cross-machine bug loop) packs the
 * REAL tarball, unpacks it into a scratch dir outside this repo, and proves
 * the render CLI works end to end there and that every generated HTML file
 * is genuinely self-contained.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/package-files.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const REQUIRED_PATHS = [
  'scripts/scheduler-mcp-server.cjs',
  // Portable ops sweeps the ops-sweep skill tells npm-installed users to run.
  'scripts/ops-sweep.cjs',
  'scripts/audit-ops-hygiene.cjs',
  // The seeded persona itself (PRD 1091) — without this, a foreign machine
  // never gets a project-home-builder agent to run in the first place.
  'src/seed/agents/project-home-builder.md',
];

// Every PreToolUse guard script (GUARD_NAMES in guardShims.cjs) that the shims
// require() from the app root. If any is missing from "files", every remote npx
// install has that guard silently dead. Derived, so a fifth guard cannot ship
// unpacked without this test going red.
const { GUARD_NAMES } = require('../../src/main/lib/guardShims.cjs');
const GUARD_SCRIPT_PATHS = GUARD_NAMES.map((n) => `scripts/hooks/${n}`);

test(
  'npm pack --dry-run includes every file required by the scheduler MCP server and the delegation-readiness guard scripts',
  () => {
    const raw = execFileSync(
      'npm',
      ['pack', '--dry-run', '--ignore-scripts', '--json'],
      { cwd: REPO_ROOT, timeout: 240000, encoding: 'utf8' },
    );
    const [{ files }] = JSON.parse(raw);
    const packedPaths = new Set(files.map((f) => f.path));

    const missing = [...REQUIRED_PATHS, ...GUARD_SCRIPT_PATHS].filter((p) => !packedPaths.has(p));
    expect(
      missing,
      `npm pack is missing required file(s): ${missing.join(', ')}. ` +
        `Add them to package.json's "files" array.`,
    ).toEqual([]);

    // The guards ship; their test fixtures do not — a directory entry for
    // "scripts/hooks/" would drag __tests__/ in too, so "files" must list
    // every guard script individually (see the entries above).
    const draggedInTests = [...packedPaths].filter((p) => p.startsWith('scripts/hooks/__tests__/'));
    expect(draggedInTests, `npm pack must not ship guard test fixtures: ${draggedInTests.join(', ')}`).toEqual([]);
  },
  240000,
);

test(
  'build-info.json is gitignored, absent from a clean pack, and packed after scripts/write-build-info.cjs runs',
  () => {
    const buildInfoPath = path.join(REPO_ROOT, 'src', 'main', 'build-info.json');
    const preexisting = fs.existsSync(buildInfoPath) ? fs.readFileSync(buildInfoPath, 'utf8') : null;

    try {
      fs.rmSync(buildInfoPath, { force: true });
      expect(
        execFileSync('git', ['check-ignore', 'src/main/build-info.json'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      ).toBe('src/main/build-info.json');

      const rawBefore = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: REPO_ROOT, timeout: 120000, encoding: 'utf8',
      });
      const [{ files: filesBefore }] = JSON.parse(rawBefore);
      expect(filesBefore.some((f) => f.path === 'src/main/build-info.json')).toBe(false);

      // eslint-disable-next-line global-require
      const { writeBuildInfo } = require('../write-build-info.cjs');
      const info = writeBuildInfo();
      expect(info.gitSha).toMatch(/^[0-9a-f]{40}$/);

      const rawAfter = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: REPO_ROOT, timeout: 120000, encoding: 'utf8',
      });
      const [{ files: filesAfter }] = JSON.parse(rawAfter);
      expect(filesAfter.some((f) => f.path === 'src/main/build-info.json')).toBe(true);
    } finally {
      if (preexisting === null) fs.rmSync(buildInfoPath, { force: true });
      else fs.writeFileSync(buildInfoPath, preexisting);
    }
  },
  240000,
);

test('package.json "files" would fail this same check if scripts/hooks were dropped from it — proving the check above is load-bearing', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const covers = (entry, p) => (entry.endsWith('/') ? p.startsWith(entry) : p === entry);

  // Simulate the regression this PRD fixes: strip every "files" entry that
  // covers a guard script (as if "scripts/hooks/*" had never been added).
  const filesWithoutGuards = pkg.files.filter((entry) => !GUARD_SCRIPT_PATHS.some((p) => covers(entry, p)));
  const missingUnderRegression = GUARD_SCRIPT_PATHS.filter(
    (p) => !filesWithoutGuards.some((entry) => covers(entry, p)),
  );
  expect(
    missingUnderRegression,
    'sanity check failed: removing the guard entries from "files" should have made every guard script unpacked',
  ).toEqual(GUARD_SCRIPT_PATHS);
});

// ---------------------------------------------------------------------------
// Real-tarball, real-unpack proof for the guard scripts. `npm pack --dry-run`
// (above) never runs a real pack; this unpacks an actual tarball outside the
// repo and asserts the guard scripts survive it — the simulated-install proof
// for the "guards are dead on every npx install" regression.
const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test(
  'a real tarball, unpacked outside this repo, contains every guard script',
  () => {
    const packDest = mkTmp('sm-pack-dest-');
    const raw = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDest],
      { cwd: REPO_ROOT, timeout: 120000, encoding: 'utf8' },
    );
    const [{ filename }] = JSON.parse(raw);
    const tarballPath = path.join(packDest, filename);
    expect(fs.existsSync(tarballPath)).toBe(true);

    const unpackRoot = mkTmp('sm-unpack-');
    execFileSync('tar', ['-xzf', tarballPath, '-C', unpackRoot], { timeout: 60000 });
    const pkgDir = path.join(unpackRoot, 'package');
    expect(pkgDir.startsWith(REPO_ROOT)).toBe(false);

    for (const rel of GUARD_SCRIPT_PATHS) {
      expect(fs.existsSync(path.join(pkgDir, rel)), `${rel} missing from the unpacked tarball`).toBe(true);
    }
  },
  240000,
);
