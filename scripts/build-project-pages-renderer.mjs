#!/usr/bin/env node
// Precompiles src/renderer/lib/projectPages/render.tsx (the Stage 0 Project
// Pages renderer, see project-pages-pipeline.md) into a single CJS bundle at
// scripts/render-project-pages/dist/renderer.cjs. Font bytes are inlined at
// bundle time — render.tsx imports them from library/fontData.ts (a
// generated module of base64 strings, see
// scripts/generate-project-pages-font-data.mjs), not read from disk at
// render time, so there is no separate asset-copy step here.
//
// Run via `npm run build:project-pages`. scripts/render-project-pages.cjs
// (the CLI) requires this bundle and prints a clear error if it's missing —
// re-run this script whenever render.tsx or the library changes.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(REPO_ROOT, 'src/renderer/lib/projectPages/render.tsx');
const OUT_DIR = join(REPO_ROOT, 'scripts/render-project-pages/dist');
const OUT_FILE = join(OUT_DIR, 'renderer.cjs');

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  await build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    jsx: 'automatic',
    // No externals: react + react-dom/server are devDependencies, so a machine
    // that installed the npm tarball has neither on its require path. The
    // bundle must be self-sufficient for `node scripts/render-project-pages.cjs`
    // to run there (PRD 1088).
  });

  console.log(`Built ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
