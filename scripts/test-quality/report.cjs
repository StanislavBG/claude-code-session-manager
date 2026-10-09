/**
 * report.cjs — one verdict per test file (keep / review / merge / bloat / unmeasured)
 * from the smell scan joined with per-file unique-coverage attribution, plus
 * consolidation clusters (src modules spread over many merge/bloat test files).
 *
 * CLI: node scripts/test-quality/report.cjs --map <coverage-map.json> [--out-md path] [--out-json path]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERDICTS = ['keep', 'review', 'merge', 'bloat', 'unmeasured'];
const REVIEW_SMELLS = ['source-text', 'no-assert', 'mock-only'];
const MERGE_UNIQUE_MAX = 3;
const MERGE_MIN_OTHER_COVERERS = 2;
const CONSOLIDATE_MIN = 3;
const isPlaywrightSpec = (f) => /\.spec\.(ts|mjs)$/.test(f);

/** src file where the test covers the most statements, or null. */
function topSrcOf(entry) {
  let best = null;
  let bestN = 0;
  for (const [src, c] of Object.entries((entry && entry.coverage) || {})) {
    const n = (c.s || []).length;
    if (n > bestN) { best = src; bestN = n; }
  }
  return best;
}

/**
 * Pure. `smells` is a scanRepo result ({ files: [{ file, tests, loc, smells }] }),
 * `attribution` is attribute(map). `map` (optional) supplies the raw coverage
 * needed to find each test's top-covered src file for the merge rule.
 */
function classify({ smells, attribution, map }) {
  const mapFiles = (map && map.files) || {};
  const coverers = new Map();
  for (const [tf, entry] of Object.entries(mapFiles)) {
    for (const src of Object.keys(entry.coverage || {})) {
      if (!coverers.has(src)) coverers.set(src, new Set());
      coverers.get(src).add(tf);
    }
  }
  return (smells.files || []).map((sf) => {
    const a = (attribution || {})[sf.file];
    const row = {
      file: sf.file,
      verdict: 'keep',
      reasons: [],
      uniqueS: a ? a.uniqueS : 0,
      uniqueB: a ? a.uniqueB : 0,
      durationMs: a ? a.durationMs || 0 : 0,
      loc: sf.loc || 0,
      tests: sf.tests || 0,
      smells: sf.smells || [],
    };
    if (isPlaywrightSpec(sf.file)) {
      row.reasons.push('e2e-not-measured');
      return row;
    }
    if (!a || !a.passed) {
      row.verdict = 'unmeasured';
      row.reasons.push(a ? 'run-failed-or-timed-out' : 'no-coverage-entry');
      return row;
    }
    if (a.uniqueS === 0 && a.uniqueB === 0) {
      row.verdict = 'bloat';
      row.reasons.push('zero-unique-coverage');
      return row;
    }
    const small = row.smells.includes('micro-file') || a.uniqueS <= MERGE_UNIQUE_MAX;
    if (small) {
      const top = topSrcOf(mapFiles[sf.file]);
      const others = top ? [...coverers.get(top)].filter((t) => t !== sf.file).length : 0;
      if (others >= MERGE_MIN_OTHER_COVERERS) {
        row.verdict = 'merge';
        row.reasons.push(row.smells.includes('micro-file') ? 'micro-file' : `uniqueS<=${MERGE_UNIQUE_MAX}`);
        row.reasons.push(`top-src ${top} covered by ${others} other test files`);
        return row;
      }
    }
    const hit = row.smells.filter((s) => REVIEW_SMELLS.includes(s));
    if (hit.length) {
      row.verdict = 'review';
      row.reasons.push(...hit.map((s) => `smell:${s}`));
    }
    return row;
  });
}

/** Per src file the test files covering it; consolidate when >= 3 are merge/bloat. */
function clusters(attribution, map, rows) {
  const verdictOf = new Map((rows || []).map((r) => [r.file, r.verdict]));
  const bySrc = new Map();
  for (const [tf, entry] of Object.entries((map && map.files) || {})) {
    if (attribution && !attribution[tf]) continue;
    for (const src of Object.keys(entry.coverage || {})) {
      if (!bySrc.has(src)) bySrc.set(src, []);
      bySrc.get(src).push(tf);
    }
  }
  return [...bySrc]
    .map(([src, tests]) => {
      const mergeOrBloat = tests.filter((t) => ['merge', 'bloat'].includes(verdictOf.get(t))).length;
      return {
        src,
        tests: tests.sort().map((file) => ({ file, verdict: verdictOf.get(file) || 'keep' })),
        mergeOrBloat,
        consolidate: mergeOrBloat >= CONSOLIDATE_MIN,
      };
    })
    .sort((a, b) => b.mergeOrBloat - a.mergeOrBloat || b.tests.length - a.tests.length || a.src.localeCompare(b.src));
}

function summarize(rows) {
  const t = { files: rows.length, tests: 0, loc: 0, byVerdict: {}, bySmell: {}, reducibleLoc: 0, reducibleDurationMs: 0 };
  for (const v of VERDICTS) t.byVerdict[v] = 0;
  for (const r of rows) {
    t.tests += r.tests || 0;
    t.loc += r.loc;
    t.byVerdict[r.verdict]++;
    for (const s of r.smells) t.bySmell[s] = (t.bySmell[s] || 0) + 1;
    if (r.verdict === 'bloat' || r.verdict === 'merge') {
      t.reducibleLoc += r.loc;
      t.reducibleDurationMs += r.durationMs;
    }
  }
  return t;
}

function renderMarkdown(result) {
  const t = result.totals;
  const v = t.byVerdict;
  const lines = ['# Test quality report', ''];
  lines.push(
    `Totals: files=${t.files} tests=${t.tests} loc=${t.loc} | ` +
      VERDICTS.map((k) => `${k}=${v[k] || 0}`).join(' ') +
      ` | bloat+merge: loc=${t.reducibleLoc} duration=${(t.reducibleDurationMs / 1000).toFixed(1)}s`,
  );
  if (result.headSha) lines.push('', `Map HEAD: ${result.headSha}`);
  lines.push('', '## Top 40 bloat files by LOC', '', '| file | loc | duration ms | reasons |', '| --- | ---: | ---: | --- |');
  const bloat = result.files.filter((r) => r.verdict === 'bloat').sort((a, b) => b.loc - a.loc).slice(0, 40);
  for (const r of bloat) lines.push(`| ${r.file} | ${r.loc} | ${r.durationMs} | ${r.reasons.join('; ')} |`);
  if (!bloat.length) lines.push('| (none) | | | |');
  lines.push('', '## Top 20 consolidate clusters', '', '| src | test files | merge/bloat |', '| --- | ---: | ---: |');
  const cons = result.clusters.filter((c) => c.consolidate).slice(0, 20);
  for (const c of cons) lines.push(`| ${c.src} | ${c.tests.length} | ${c.mergeOrBloat} |`);
  if (!cons.length) lines.push('| (none) | | |');
  lines.push('', '## Smell counts', '');
  const smellKeys = Object.keys(t.bySmell).sort();
  for (const s of smellKeys) lines.push(`- ${s}: ${t.bySmell[s]}`);
  if (!smellKeys.length) lines.push('- (none)');
  return lines.join('\n') + '\n';
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mapPath = flag('--map');
  if (!mapPath) {
    console.error('usage: report.cjs --map <coverage-map.json> [--out-md path] [--out-json path]');
    process.exit(2);
  }
  const { scanRepo } = require('./smells.cjs');
  const { attribute } = require('./coverage-map.cjs');
  const root = path.resolve(__dirname, '../..');
  const map = JSON.parse(fs.readFileSync(path.resolve(mapPath), 'utf8'));
  const attribution = attribute(map);
  const files = classify({ smells: scanRepo(root), attribution, map });
  const result = {
    generatedAt: new Date().toISOString(),
    headSha: map.headSha || null,
    totals: summarize(files),
    files,
    clusters: clusters(attribution, map, files).filter((c) => c.tests.length >= 2),
  };
  const md = renderMarkdown(result);
  const outMd = flag('--out-md');
  const outJson = flag('--out-json');
  if (outMd) fs.writeFileSync(path.resolve(outMd), md);
  if (outJson) fs.writeFileSync(path.resolve(outJson), JSON.stringify(result));
  if (!outMd) process.stdout.write(md);
}

module.exports = { classify, clusters, summarize, renderMarkdown, topSrcOf };

if (require.main === module) main(process.argv.slice(2));
