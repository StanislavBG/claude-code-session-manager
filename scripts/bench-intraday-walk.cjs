#!/usr/bin/env node
/**
 * bench-intraday-walk.cjs — read-only wall-clock comparison of the OLD
 * unconditional-stat-every-file walk vs. the NEW directory-mtime-skip +
 * bounded-concurrency walk (historyAggregator.cjs's refreshIntradayToday),
 * against the REAL ~/.claude/projects tree.
 *
 * Never writes anything: run the two walks against the live filesystem, but
 * skip historyAggregator's own rollup-append step (this script reimplements
 * just the walk/parse portion, not the appendRollupDays call).
 *
 * Run: node scripts/bench-intraday-walk.cjs
 */

'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const historyAggregator = require('../src/main/historyAggregator.cjs');

function localDate(d) {
  return d.toLocaleDateString('en-CA');
}

async function legacyWalk() {
  const today = localDate(new Date());
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { touched: 0, statCount: 0 };
  }
  let statCount = 0;
  let touched = 0;
  for (const projEntry of projectDirs) {
    if (!projEntry.isDirectory()) continue;
    const projectDir = path.join(PROJECTS_DIR, projEntry.name);
    let files;
    try { files = await fsp.readdir(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const fileEntry of files) {
      if (!fileEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, fileEntry.name);
      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }
      statCount++;
      const mtimeDate = localDate(new Date(stat.mtimeMs));
      if (mtimeDate < today) continue;
      touched++;
    }
  }
  return { touched, statCount };
}

async function main() {
  const t0 = Date.now();
  const legacy = await legacyWalk();
  const legacyMs = Date.now() - t0;

  // Cold-registry run of the new implementation (worst case: first tick ever,
  // no cached directory file-lists yet). computeIntradayBuckets() is the pure
  // walk/parse step with no rollup write, so this whole script never touches
  // disk beyond the reads the walk itself performs.
  const t1 = Date.now();
  const cold = await historyAggregator.computeIntradayBuckets();
  const coldMs = Date.now() - t1;

  // Warm-registry run #2: the exclusion set is still being populated as the
  // first not-today file is confirmed and dropped forever, so this is a
  // transitional tick, not steady state yet.
  const t2 = Date.now();
  const warm2 = await historyAggregator.computeIntradayBuckets();
  const warm2Ms = Date.now() - t2;

  // Warm-registry run #3: steady state — matches every subsequent 5-min
  // timer tick in the running app, once the exclusion set has converged.
  const t3 = Date.now();
  const warm3 = await historyAggregator.computeIntradayBuckets();
  const warm3Ms = Date.now() - t3;

  console.log('--- bench-intraday-walk (read-only; no rollup writes) ---');
  console.log(`legacy (sequential stat-everything): ${legacyMs}ms, ${legacy.statCount} stats, ${legacy.touched} touched-today files found`);
  console.log(`new walk, cold registry (tick 1):     ${coldMs}ms, projectsUpdated=${cold.buckets.size}`);
  console.log(`new walk, warm registry (tick 2):     ${warm2Ms}ms, projectsUpdated=${warm2.buckets.size}`);
  console.log(`new walk, steady state (tick 3):      ${warm3Ms}ms, projectsUpdated=${warm3.buckets.size}`);
  console.log(`speedup (legacy / steady state): ${(legacyMs / Math.max(warm3Ms, 1)).toFixed(1)}x`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
