#!/usr/bin/env node
// Thin CLI wrapper around scoreVariants/mergePicks (src/renderer/lib/
// projectPages/select.ts), compiled into
// scripts/project-pages-logic/dist/logic.cjs by `npm run
// build:project-pages-logic` (same bundle validate-project-pages-summary.cjs
// uses — extended in place rather than adding a third bundle).
//
// Usage:
//   node scripts/select-project-pages-picks.cjs <summary.json> <existing picks.json or 'none'> <output picks.json> [comma-separated resetSlots]
//
// resetSlots entries are either a bare slotId (applies across every lens) or
// a "<lensId>.<slotId>" pair (applies to just that lens) — matches
// mergePicks's own key check.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(`select-project-pages-picks: ${message}`);
  process.exit(1);
}

function main() {
  const [summaryPath, existingPicksArg, outPath, resetSlotsArg] = process.argv.slice(2);
  if (!summaryPath || !existingPicksArg || !outPath) {
    fail('usage: node scripts/select-project-pages-picks.cjs <summary.json> <existing picks.json | none> <output picks.json> [resetSlots]');
  }

  const bundlePath = path.join(__dirname, 'project-pages-logic', 'dist', 'logic.cjs');
  if (!fs.existsSync(bundlePath)) {
    fail(`build bundle not found at ${bundlePath} — run "npm run build:project-pages-logic" first`);
  }

  let scoreVariants, mergePicks, LENS_LIBRARY, LENS_ORDER;
  try {
    ({ scoreVariants, mergePicks, LENS_LIBRARY, LENS_ORDER } = require(bundlePath));
  } catch (err) {
    fail(`failed to load ${bundlePath}: ${err.message}`);
  }

  let summary, existing;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    existing = existingPicksArg === 'none' ? null : JSON.parse(fs.readFileSync(existingPicksArg, 'utf8'));
  } catch (err) {
    fail(`failed to read input JSON: ${err.message}`);
  }
  const resetSlots = resetSlotsArg ? resetSlotsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const scored = {};
  for (const lensId of LENS_ORDER) {
    scored[lensId] = scoreVariants(LENS_LIBRARY[lensId], summary);
  }

  const merged = mergePicks(existing, scored, resetSlots);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
  console.log(`Wrote ${outPath}`);
}

main();
