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
  // Project Pages pipeline (PRD 1088): the CLIs a foreign machine's
  // project-home-builder Epic runs, plus the shipped catalog + spec copy.
  'scripts/render-project-pages.cjs',
  'scripts/validate-project-pages-summary.cjs',
  'src/main/templates/project-pages-catalog.json',
  'src/main/templates/project-pages-pipeline.md',
  // The seeded persona itself (PRD 1091) — without this, a foreign machine
  // never gets a project-home-builder agent to run in the first place.
  'src/seed/agents/project-home-builder.md',
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

// ---------------------------------------------------------------------------
// Real-tarball, real-unpack, real-render end-to-end proof.
//
// Edge case resolved: `npm pack --dry-run --ignore-scripts` (the test above)
// never runs `prepublishOnly`, so it would happily pass even if the two
// esbuild bundles were never built — a real `npm publish` would still ship a
// tarball whose `files` entries point at nothing. Chosen fix: build the two
// bundles ourselves (they're fast — well under a second each, see
// scripts/build-project-pages-renderer.mjs / build-project-pages-logic.mjs)
// and THEN run a real (non-dry-run) `npm pack --ignore-scripts`. --ignore-scripts
// is kept here too so this test doesn't also re-run `vite build` (slow, and
// already covered by the normal build/typecheck gate) — the point of this
// test is proving the two bundle paths reach a REAL tarball once they exist
// on disk, not re-proving prepublishOnly's own build steps. This also
// answers the sibling requirement (bundle paths not silently excluded by
// .gitignore's bare `dist` rule): a real `npm pack` DOES still honor
// .gitignore for files not explicitly listed in package.json's `files`
// array, so if the trailing-slash entries in `files` didn't actually
// override that exclusion, the assertions below would fail.
const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const FIXTURE_SUMMARY = {
  identity: {
    name: 'Acme Widgets',
    tag: 'acme-widgets',
    version: 'v1.0.0',
    oneLine: 'Widgets, but faster.',
    claim: 'Ship widgets without the wait.',
    sub: 'Acme Widgets automates the boring parts of widget assembly.',
    audience: 'For widget teams',
    install: 'npx acme-widgets',
  },
  stats: [{ v: '42', k: 'widgets/day', n: 'across all lines' }],
  pillars: [{ t: 'One line, four stations', d: 'Every widget passes through the same four stations.', k: 'Assembly' }],
  quotes: [],
  feature: {
    name: 'Auto-QA',
    kicker: 'Feature',
    status: 'Shipping · v1.0',
    owner: 'Core',
    oneLine: 'Every widget is inspected before it leaves the line.',
    problem: 'Manual inspection missed defects under load.',
    solution: 'A camera station scores each widget against spec automatically.',
    steps: [{ t: 'Capture', d: 'A camera captures the widget at station 4.' }],
    rules: [{ t: 'No silent pass', d: 'Every widget gets a recorded score.' }],
    specs: [['Throughput', '120/min', 'per station']],
    faq: [{ q: 'What if the camera fails?', a: 'The line halts and the station flags itself.' }],
    timeline: [{ w: 'v0.9', t: 'Camera station shipped', s: 'done' }],
  },
  architecture: {
    summary: 'A line controller coordinating four stations and a scoring service.',
    principles: [{ t: 'Fail loud', d: 'A station that cannot score halts rather than guesses.' }],
    layers: [{ n: 'Controller', d: 'Coordinates stations', f: '6 files', tone: 'accent' }],
    modules: [{ n: 'scoring', d: 'Scores captures against spec', f: 4, dep: [], heat: 0.6 }],
    flow: [{ a: 'Station', b: 'Controller', t: 'capture()', n: 'sent on each widget' }],
    decisions: [{ id: 'ADR-01', t: 'Scoring runs on-line, not batched', w: 'Batch scoring missed the halt window.', s: 'accepted' }],
    risks: [{ t: 'Camera drift', d: 'Uncalibrated cameras drift over months.', s: 'watching' }],
  },
};

test(
  'a real tarball, unpacked outside this repo, renders all 5 lenses with no CDN/JSX-runtime/repo references',
  () => {
    // 1. Build the two bundles for real (see comment above for why this test
    //    doesn't rely on prepublishOnly or --dry-run for that).
    execFileSync('npm', ['run', 'build:project-pages'], { cwd: REPO_ROOT, timeout: 60000 });
    execFileSync('npm', ['run', 'build:project-pages-logic'], { cwd: REPO_ROOT, timeout: 60000 });

    // 2. Pack a REAL tarball (not --dry-run) into a scratch destination.
    const packDest = mkTmp('sm-pack-dest-');
    const raw = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDest],
      { cwd: REPO_ROOT, timeout: 120000, encoding: 'utf8' },
    );
    const [{ filename }] = JSON.parse(raw);
    const tarballPath = path.join(packDest, filename);
    expect(fs.existsSync(tarballPath)).toBe(true);

    // 3. Unpack it into a scratch dir OUTSIDE this repo — npm always unpacks
    //    a "package/" subdir.
    const unpackRoot = mkTmp('sm-unpack-');
    execFileSync('tar', ['-xzf', tarballPath, '-C', unpackRoot], { timeout: 60000 });
    const pkgDir = path.join(unpackRoot, 'package');
    expect(pkgDir.startsWith(REPO_ROOT)).toBe(false);

    // Both bundles actually reached the real tarball (not just "covered" by
    // a files-array prefix match, as the dry-run test above checks).
    for (const rel of BUILD_ARTIFACT_PATHS) {
      expect(fs.existsSync(path.join(pkgDir, rel)), `${rel} missing from the unpacked tarball`).toBe(true);
    }

    // 4. Run the render CLI end to end from inside the unpacked package.
    const summaryPath = path.join(unpackRoot, 'summary.json');
    const picksPath = path.join(unpackRoot, 'picks.json');
    const outDir = path.join(unpackRoot, 'output');
    fs.writeFileSync(summaryPath, JSON.stringify(FIXTURE_SUMMARY));
    fs.writeFileSync(picksPath, JSON.stringify({}));

    const renderOut = execFileSync(
      'node',
      [path.join(pkgDir, 'scripts', 'render-project-pages.cjs'), summaryPath, picksPath, outDir, new Date().toISOString()],
      { cwd: unpackRoot, timeout: 30000, encoding: 'utf8' },
    );
    // The renderer's own require(bundlePath) call is __dirname-relative
    // (see render-project-pages.cjs), so a successful run with no "Cannot
    // find module" against REPO_ROOT is itself proof module resolution
    // never left the unpacked dir. Assert that negatively too.
    expect(renderOut).not.toContain(REPO_ROOT);

    // The validate CLI is the other shipped entry point — prove it also runs
    // standalone from the unpacked package.
    const validateOut = execFileSync(
      'node',
      [path.join(pkgDir, 'scripts', 'validate-project-pages-summary.cjs'), summaryPath],
      { cwd: unpackRoot, timeout: 30000, encoding: 'utf8' },
    );
    expect(validateOut).toContain('valid');

    const LENSES = ['home', 'marketing', 'feature', 'architecture', 'brief'];
    for (const lens of LENSES) {
      expect(fs.existsSync(path.join(outDir, `${lens}.html`)), `${lens}.html was not generated`).toBe(true);
    }
    expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(true);

    // 5. Every generated HTML file must be genuinely self-contained — the
    //    spec's non-negotiable, and nothing asserted this before PRD 1093.
    for (const lens of LENSES) {
      const html = fs.readFileSync(path.join(outDir, `${lens}.html`), 'utf8');
      expect(html, `${lens}.html has an external <script src="http...">`).not.toMatch(/<script[^>]+src\s*=\s*["']https?:/i);
      expect(html, `${lens}.html has an external <link ... href="http...">`).not.toMatch(/<link[^>]+href\s*=\s*["']https?:/i);
      expect(html, `${lens}.html has an @import url(http...)`).not.toMatch(/@import\s+url\(\s*['"]?https?:/i);
      expect(html, `${lens}.html references a CDN`).not.toMatch(/cdn\.[a-z0-9.-]+/i);
      expect(html, `${lens}.html references Google Fonts`).not.toMatch(/fonts\.(googleapis|gstatic)\.com/i);
      expect(html, `${lens}.html loads a runtime JSX/Babel transform`).not.toMatch(/type\s*=\s*["']text\/babel["']|babel-standalone|@babel\/standalone/i);
      expect(html, `${lens}.html has no http(s) reference at all`).not.toMatch(/https?:\/\//i);
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    }
  },
  240000,
);
