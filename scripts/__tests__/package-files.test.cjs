/**
 * package-files.test.cjs — packaging regression test. Ensures
 * scripts/scheduler-mcp-server.cjs (and any future required file) is never
 * silently dropped from package.json's "files" array again, since a dropped
 * file means the scheduler_create_prd MCP tool can never register on any
 * machine that installed via npx.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/package-files.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const REQUIRED_PATHS = [
  'scripts/scheduler-mcp-server.cjs',
  // Project Pages pipeline (PRD 1088): the CLIs a foreign machine's
  // project-home-builder Epic runs, plus the shipped catalog + spec copy.
  'scripts/render-project-pages.cjs',
  'scripts/validate-project-pages-summary.cjs',
  'src/main/templates/project-pages-catalog.json',
  'src/main/templates/project-pages-pipeline.md',
];

// The two esbuild bundles are gitignored build artifacts (`dist` in
// .gitignore) produced by prepublishOnly, so they may not exist in a fresh
// checkout and `npm pack --dry-run` would not list them. Asserting that the
// `files` array COVERS their paths (directory-prefix match, which is how npm
// treats a trailing-slash entry) is deterministic regardless of build state;
// scripts/__tests__/project-pages-publish-gate.test.cjs covers their
// existence + freshness.
const BUILD_ARTIFACT_PATHS = [
  'scripts/render-project-pages/dist/renderer.cjs',
  'scripts/project-pages-logic/dist/logic.cjs',
];

test('package.json "files" covers the Project Pages build artifacts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const covered = (p) => pkg.files.some((entry) => (entry.endsWith('/') ? p.startsWith(entry) : p === entry));
  const missing = BUILD_ARTIFACT_PATHS.filter((p) => !covered(p));
  expect(missing, `package.json "files" does not cover: ${missing.join(', ')}`).toEqual([]);
});

test(
  'npm pack --dry-run includes every file required by the scheduler MCP server and Project Pages CLIs',
  () => {
    const raw = execFileSync(
      'npm',
      ['pack', '--dry-run', '--ignore-scripts', '--json'],
      { cwd: REPO_ROOT, timeout: 240000, encoding: 'utf8' },
    );
    const [{ files }] = JSON.parse(raw);
    const packedPaths = new Set(files.map((f) => f.path));

    const missing = REQUIRED_PATHS.filter((p) => !packedPaths.has(p));
    expect(
      missing,
      `npm pack is missing required file(s): ${missing.join(', ')}. ` +
        `Add them to package.json's "files" array.`,
    ).toEqual([]);
  },
  240000,
);
