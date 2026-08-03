#!/usr/bin/env node
// Bash-invocable CLI wrapping the Stage 0 renderer (render.tsx →
// scripts/render-project-pages/dist/renderer.cjs, built by
// `npm run build:project-pages`). Requires that build to have already run —
// this script does NOT bundle on the fly, since PRD authoring standards
// forbid unbounded/slow steps inside a headless job.
//
// Usage:
//   node scripts/render-project-pages.cjs <summary.json> <picks.json> <output dir> <generatedAt>
//
// generatedAt (4th arg, required) is an ISO 8601 timestamp string the CALLER
// stamps — Date.now() is unavailable in some execution contexts (e.g.
// workflow scripts) that may drive this CLI, so this script never generates
// its own timestamp. This is the "accept generatedAt as a 4th CLI arg"
// option from the PRD's two documented choices (the alternative — omitting
// generatedAt from manifest.json entirely — was not taken).
//
// Writes <output dir>/home.html, marketing.html, feature.html,
// architecture.html, brief.html, and manifest.json ({ generatedAt }).
//
// Path arguments are used as-is (no allowedRoots validation like
// config.cjs's validatePath) — this is a standalone local dev/ops script run
// by a trusted human or agent shell, not an IPC-reachable surface, so it's
// out of scope for that guard by design.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(`render-project-pages: ${message}`);
  process.exit(1);
}

function main() {
  const [summaryPath, picksPath, outDir, generatedAt] = process.argv.slice(2);
  if (!summaryPath || !picksPath || !outDir || !generatedAt) {
    fail('usage: node scripts/render-project-pages.cjs <summary.json> <picks.json> <output dir> <generatedAt>');
  }
  if (Number.isNaN(Date.parse(generatedAt))) {
    fail(`generatedAt must be an ISO 8601 timestamp, got: ${generatedAt}`);
  }

  const bundlePath = path.join(__dirname, 'render-project-pages', 'dist', 'renderer.cjs');
  if (!fs.existsSync(bundlePath)) {
    fail(`build bundle not found at ${bundlePath} — run "npm run build:project-pages" first`);
  }

  let renderProjectPages;
  try {
    ({ renderProjectPages } = require(bundlePath));
  } catch (err) {
    fail(`failed to load ${bundlePath}: ${err.message}`);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const picks = JSON.parse(fs.readFileSync(picksPath, 'utf8'));

  const pages = renderProjectPages(summary, picks);

  fs.mkdirSync(outDir, { recursive: true });
  for (const lens of ['home', 'marketing', 'feature', 'architecture', 'brief']) {
    fs.writeFileSync(path.join(outDir, `${lens}.html`), pages[lens]);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ generatedAt }, null, 2));

  console.log(`Wrote home.html, marketing.html, feature.html, architecture.html, brief.html, manifest.json to ${outDir}`);
}

main();
