#!/usr/bin/env node
'use strict';

// Main-process micro-benchmarks (plain Node, no Electron). `npm run bench`.
// Prints one markdown table of median ms over REPS runs; `--json <file>` also
// writes the raw samples. NO thresholds: numbers are machine-relative, so the
// exit code is 0 whenever the benches ran.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const { __usageForOneForTest: usageForOne, __usageCacheForTest: usageCache } = require('../../src/main/transcripts.cjs');
const { LRUCache } = require('../../src/main/lib/lruCache.cjs');

const REPS = 9;
const FIXTURE_BYTES = 15 * 1024 * 1024;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function timeAsync(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

// One ~1 KB assistant line carrying a usage event (the shape usageForOne sums).
function fixtureLine(i) {
  return JSON.stringify({ type: 'assistant', usage: { input_tokens: 10 + (i % 7), output_tokens: 3 }, pad: 'x'.repeat(900) }) + '\n';
}

async function benchUsage(dir) {
  const file = path.join(dir, 'fixture.jsonl');
  const fd = fs.openSync(file, 'w');
  let written = 0;
  for (let i = 0; written < FIXTURE_BYTES; i++) written += fs.writeSync(fd, fixtureLine(i));
  fs.closeSync(fd);

  const cold = [];
  const tail = [];
  for (let r = 0; r < REPS; r++) {
    usageCache.delete(file);
    cold.push(await timeAsync(() => usageForOne(file)));
    fs.appendFileSync(file, fixtureLine(r)); // primed by the cold run above
    tail.push(await timeAsync(() => usageForOne(file)));
  }
  return { cold, tail, bytes: written };
}

function benchPs() {
  const out = [];
  for (let r = 0; r < REPS; r++) {
    const t = performance.now();
    execFileSync('ps', ['-eo', 'pid,pgrp,pcpu,etimes,comm'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    out.push(performance.now() - t);
  }
  return out;
}

function benchLru() {
  const OPS = 200_000;
  const out = { get: [], set: [] };
  for (let r = 0; r < REPS; r++) {
    const c = new LRUCache(200);
    let t = performance.now();
    for (let i = 0; i < OPS; i++) c.set(i % 400, i); // 2x cap: exercises eviction
    out.set.push(performance.now() - t);
    t = performance.now();
    for (let i = 0; i < OPS; i++) c.get(i % 400);
    out.get.push(performance.now() - t);
  }
  return { ...out, ops: OPS };
}

const fmt = (n) => n.toFixed(n < 10 ? 3 : 1);

async function main() {
  const jsonIdx = process.argv.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? process.argv[jsonIdx + 1] : null;
  if (jsonIdx !== -1 && !jsonPath) throw new Error('--json needs a file path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bench-'));
  let usage;
  try {
    usage = await benchUsage(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ps = benchPs();
  const lru = benchLru();

  const rows = [
    [`usageForOne cold full parse (${(usage.bytes / 1048576).toFixed(1)} MB)`, median(usage.cold)],
    ['usageForOne tail parse after 1-line append', median(usage.tail)],
    ['execFileSync ps -eo (pre-PRD-1353 per-job-exit block)', median(ps)],
    [`LRUCache set x${lru.ops} @ cap 200`, median(lru.set)],
    [`LRUCache get x${lru.ops} @ cap 200`, median(lru.get)],
  ];
  console.log(`| bench | median ms (n=${REPS}) |\n| --- | --- |`);
  for (const [name, ms] of rows) console.log(`| ${name} | ${fmt(ms)} |`);

  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({ reps: REPS, node: process.version, usage, ps, lru }, null, 2));
  }
}

main().catch((e) => {
  console.error(`bench failed: ${e.message}`);
  process.exit(1);
});
