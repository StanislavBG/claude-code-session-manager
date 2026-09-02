#!/usr/bin/env node
// Publish gate for the Project Pages pipeline assets (PRD 1088). Wired into
// package.json's `prepublishOnly` AFTER the two esbuild bundles are built and
// BEFORE `vite build`, so `npm publish` cannot proceed past:
//
//   1. a MISSING bundle  — scripts/render-project-pages/dist/renderer.cjs or
//                          scripts/project-pages-logic/dist/logic.cjs absent
//                          (both are gitignored build artifacts);
//   2. a STALE bundle    — older than any file under
//                          src/renderer/lib/projectPages/** (tests excluded);
//   3. a DRIFTED catalog — src/main/templates/project-pages-catalog.json no
//                          longer matches what the library sources generate;
//   4. a DRIFTED spec    — src/main/templates/project-pages-pipeline.md is not
//                          a byte-for-byte copy of the architecture spec.
//
// Every failure names the file and the npm script that fixes it.
//
// Staleness is decided by mtime comparison, not a content-hash manifest:
// the bundles are not committed (so there is nothing for a manifest to be
// committed against), `git checkout` bumps source mtimes to "now" which makes
// an older bundle read as stale — the SAFE direction (a false "stale" forces a
// 2-second rebuild; a false "fresh" would ship a broken renderer), and it
// needs no extra state file to keep in sync. The catalog, by contrast, IS
// committed, so it is compared by content (regenerated and diffed).
//
// Usage: node scripts/project-pages-publish-gate.cjs   (exit 1 on any failure)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assets = require('./project-pages-assets.cjs');

const SOURCE_ROOT_REL = 'src/renderer/lib/projectPages';

const BUNDLES = [
  { path: 'scripts/render-project-pages/dist/renderer.cjs', build: 'npm run build:project-pages' },
  { path: 'scripts/project-pages-logic/dist/logic.cjs', build: 'npm run build:project-pages-logic' },
];

function isTestPath(rel) {
  return rel.split(path.sep).includes('__tests__') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/**
 * Walk SOURCE_ROOT_REL recursively and return the newest non-test file.
 * O(n) in the number of files under the directory (a few dozen).
 */
function newestSource(repoRoot) {
  const root = path.join(repoRoot, SOURCE_ROOT_REL);
  let newest = null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, abs);
      if (isTestPath(rel)) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      const mtimeMs = fs.statSync(abs).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { rel, mtimeMs };
    }
  }
  return newest;
}

function checkBundles(repoRoot) {
  const errors = [];
  const newest = newestSource(repoRoot);
  for (const bundle of BUNDLES) {
    const abs = path.join(repoRoot, bundle.path);
    if (!fs.existsSync(abs)) {
      errors.push(`MISSING bundle ${bundle.path} — run \`${bundle.build}\` to produce it`);
      continue;
    }
    if (newest && fs.statSync(abs).mtimeMs < newest.mtimeMs) {
      errors.push(
        `STALE bundle ${bundle.path} is older than source ${newest.rel} — run \`${bundle.build}\` to rebuild it`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

function checkCatalog(repoRoot, { catalogPath = path.join(repoRoot, assets.CATALOG_REL) } = {}) {
  const errors = [];
  try {
    const expected = assets.serializeCatalog(assets.buildCatalog(repoRoot));
    const actual = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : null;
    if (actual === null) {
      errors.push(`MISSING catalog ${assets.CATALOG_REL} — run \`npm run build:project-pages-assets\` and commit it`);
    } else if (actual !== expected) {
      errors.push(
        `DRIFTED catalog ${assets.CATALOG_REL} no longer matches ${SOURCE_ROOT_REL}/library/*.tsx — run \`npm run build:project-pages-assets\` and commit it`,
      );
    }
  } catch (err) {
    errors.push(`catalog regeneration failed: ${err.message}`);
  }
  return { ok: errors.length === 0, errors };
}

function checkSpecCopy(repoRoot, { copyPath = path.join(repoRoot, assets.SPEC_COPY_REL) } = {}) {
  const errors = [];
  try {
    const expected = assets.readSpec(repoRoot);
    const actual = fs.existsSync(copyPath) ? fs.readFileSync(copyPath, 'utf8') : null;
    if (actual === null) {
      errors.push(`MISSING spec copy ${assets.SPEC_COPY_REL} — run \`npm run build:project-pages-assets\` and commit it`);
    } else if (actual !== expected) {
      errors.push(
        `DRIFTED spec copy ${assets.SPEC_COPY_REL} differs from ${assets.SPEC_REL} — run \`npm run build:project-pages-assets\` and commit it`,
      );
    }
  } catch (err) {
    errors.push(`spec comparison failed: ${err.message}`);
  }
  return { ok: errors.length === 0, errors };
}

function runGate(repoRoot) {
  const errors = [
    ...checkBundles(repoRoot).errors,
    ...checkCatalog(repoRoot).errors,
    ...checkSpecCopy(repoRoot).errors,
  ];
  return { ok: errors.length === 0, errors };
}

module.exports = { BUNDLES, SOURCE_ROOT_REL, newestSource, checkBundles, checkCatalog, checkSpecCopy, runGate };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const result = runGate(repoRoot);
  if (!result.ok) {
    console.error('project-pages-publish-gate: refusing to publish:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('project-pages-publish-gate: bundles fresh, catalog + spec copy current');
}
