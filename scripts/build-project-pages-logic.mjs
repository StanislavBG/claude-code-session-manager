#!/usr/bin/env node
// Precompiles src/renderer/lib/projectPages/logicBundle.ts (the non-React
// Project Pages logic — summary validation, component library metadata)
// into a single CJS bundle at scripts/project-pages-logic/dist/logic.cjs.
// Separate from build-project-pages-renderer.mjs's bundle because that one
// externals react/react-dom for renderToStaticMarkup; this bundle has no
// runtime react dependency, so its CLI consumer
// (validate-project-pages-summary.cjs) doesn't need react on its require
// path.
//
// Run via `npm run build:project-pages-logic`. Re-run whenever logicBundle.ts
// or anything it re-exports changes.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(REPO_ROOT, 'src/renderer/lib/projectPages/logicBundle.ts');
const OUT_DIR = join(REPO_ROOT, 'scripts/project-pages-logic/dist');
const OUT_FILE = join(OUT_DIR, 'logic.cjs');

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
    // logicBundle.ts re-exports LENS_LIBRARY/LENS_ORDER from library/index.ts
    // (the ported component library) — those slot modules are .tsx files with
    // JSX component definitions (never invoked here, only referenced by id),
    // so the bundle still needs the JSX transform + react as an external,
    // exactly like build-project-pages-renderer.mjs's config.
    jsx: 'automatic',
    external: ['react', 'react-dom'],
  });

  console.log(`Built ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
