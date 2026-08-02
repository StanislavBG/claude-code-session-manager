#!/usr/bin/env node
// Thin CLI wrapper around validateProjectPageSummary (src/renderer/lib/
// projectPages/summaryValidate.ts), compiled into
// scripts/project-pages-logic/dist/logic.cjs by `npm run
// build:project-pages-logic`. The project-home-builder Epic runs this
// against its own summary.json before proceeding to Stage 2/3 (see
// .claude/agents/project-home-builder.md).
//
// Usage: node scripts/validate-project-pages-summary.cjs <summary.json path>
// Exits 0 and prints "valid" on success; exits 1 and prints each error on
// failure. Same CLI-wrapper pattern as scripts/render-project-pages.cjs.
//
// The path argument is used as-is (no allowedRoots validation like
// config.cjs's validatePath) — this is a standalone local dev/ops script run
// by a trusted human or agent shell, not an IPC-reachable surface, so it's
// out of scope for that guard by design.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(`validate-project-pages-summary: ${message}`);
  process.exit(1);
}

function main() {
  const [summaryPath] = process.argv.slice(2);
  if (!summaryPath) {
    fail('usage: node scripts/validate-project-pages-summary.cjs <summary.json path>');
  }

  const bundlePath = path.join(__dirname, 'project-pages-logic', 'dist', 'logic.cjs');
  if (!fs.existsSync(bundlePath)) {
    fail(`build bundle not found at ${bundlePath} — run "npm run build:project-pages-logic" first`);
  }

  let validateProjectPageSummary;
  try {
    ({ validateProjectPageSummary } = require(bundlePath));
  } catch (err) {
    fail(`failed to load ${bundlePath}: ${err.message}`);
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch (err) {
    fail(`could not read/parse ${summaryPath}: ${err.message}`);
  }

  const result = validateProjectPageSummary(summary);
  if (!result.ok) {
    console.error('validate-project-pages-summary: invalid summary:');
    for (const err of result.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  console.log('valid');
}

main();
