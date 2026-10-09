'use strict';

/**
 * coverage-map.cjs — per-test-file v8 coverage attribution (dev-only).
 *
 * Runs each vitest test file on its own with v8 coverage, records the source
 * statements ("<line>:<col>") and branch arms ("<line>:<col>:<arm>") it
 * executes, then computes each file's UNIQUE coverage: keys no other test
 * file covers. First signal for "is this test worth keeping or is it bloat".
 *
 * CLI: node scripts/test-quality/coverage-map.cjs [--all | <testFile>...] [--jobs N] [--out path]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_OUT = path.join(ROOT, 'test-results', 'test-quality', 'coverage-map.json');
const TEST_FILE_RE = /\.(test|spec)\.(cjs|ts|tsx)$/;

function isTrackedSource(rel) {
  if (!(rel.startsWith('src/') || rel.startsWith('scripts/'))) return false;
  if (rel.split('/').includes('__tests__')) return false;
  if (TEST_FILE_RE.test(rel)) return false;
  return true;
}

function parseCoverage(reportsDir) {
  const file = path.join(reportsDir, 'coverage-final.json');
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const [abs, cov] of Object.entries(raw)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (rel.startsWith('..') || !isTrackedSource(rel)) continue;
    const s = [];
    const b = [];
    for (const [id, count] of Object.entries(cov.s || {})) {
      if (count > 0) {
        const loc = cov.statementMap[id].start;
        s.push(`${loc.line}:${loc.column}`);
      }
    }
    for (const [id, counts] of Object.entries(cov.b || {})) {
      const loc = cov.branchMap[id].loc.start;
      counts.forEach((count, arm) => {
        if (count > 0) b.push(`${loc.line}:${loc.column}:${arm}`);
      });
    }
    if (s.length || b.length) out[rel] = { s: [...new Set(s)], b: [...new Set(b)] };
  }
  return out;
}

function runTestFile(file, opts = {}) {
  const coverage = opts.coverage !== false;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-map-tmp-'));
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-map-rep-'));
  const env = { ...process.env, TMPDIR: tmpDir };
  for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'VITEST_MODE']) delete env[k];

  const args = ['vitest', 'run', file];
  if (coverage) {
    args.push(
      '--coverage.enabled=true',
      '--coverage.provider=v8',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${reportsDir}`,
      '--coverage.include=src/**',
      '--coverage.include=scripts/**',
      '--coverage.exclude=**/__tests__/**',
    );
  }

  const started = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn('npx', args, { cwd: ROOT, env, stdio: 'ignore' });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let cov = {};
      if (coverage && !timedOut) {
        try {
          cov = parseCoverage(reportsDir);
        } catch {
          cov = {};
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(reportsDir, { recursive: true, force: true });
      resolve({
        file,
        passed: code === 0 && !timedOut,
        timedOut,
        durationMs: Date.now() - started,
        coverage: cov,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code));
  });
}

async function buildMap(files, { jobs, ...runOpts } = {}) {
  const concurrency = jobs || Math.max(1, Math.floor(os.cpus().length / 2));
  const results = {};
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      const r = await runTestFile(file, runOpts);
      results[file] = {
        passed: r.passed,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        coverage: r.coverage,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  let headSha = null;
  try {
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    headSha = null;
  }
  return { generatedAt: new Date().toISOString(), headSha, files: results };
}

function attribute(map) {
  const files = map.files || {};
  const sCount = new Map();
  const bCount = new Map();
  const keysOf = (entry) => {
    const s = new Set();
    const b = new Set();
    for (const [src, c] of Object.entries(entry.coverage || {})) {
      for (const k of c.s) s.add(`${src}|${k}`);
      for (const k of c.b) b.add(`${src}|${k}`);
    }
    return { s, b };
  };
  const per = {};
  for (const [tf, entry] of Object.entries(files)) {
    const keys = keysOf(entry);
    per[tf] = keys;
    for (const k of keys.s) sCount.set(k, (sCount.get(k) || 0) + 1);
    for (const k of keys.b) bCount.set(k, (bCount.get(k) || 0) + 1);
  }
  const out = {};
  for (const [tf, keys] of Object.entries(per)) {
    let uniqueS = 0;
    let uniqueB = 0;
    for (const k of keys.s) if (sCount.get(k) === 1) uniqueS++;
    for (const k of keys.b) if (bCount.get(k) === 1) uniqueB++;
    out[tf] = {
      coveredS: keys.s.size,
      coveredB: keys.b.size,
      uniqueS,
      uniqueB,
      durationMs: files[tf].durationMs,
      passed: files[tf].passed,
    };
  }
  return out;
}

async function main(argv) {
  const files = [];
  let all = false;
  let jobs;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--jobs') jobs = Number(argv[++i]);
    else if (a === '--out') out = path.resolve(argv[++i]);
    else files.push(a);
  }
  const targets = all ? require('../list-pure-tests.cjs').listIncludedFiles().sort() : files;
  if (!targets.length) {
    console.error('usage: coverage-map.cjs [--all | <testFile>...] [--jobs N] [--out path]');
    process.exit(2);
  }
  const map = await buildMap(targets, { jobs });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(map));
  const attr = attribute(map);
  const rows = Object.values(attr);
  const passed = rows.filter((r) => r.passed).length;
  const zeroUnique = rows.filter((r) => r.uniqueS === 0 && r.uniqueB === 0).length;
  console.log(
    `coverage-map: ${rows.length} files, ${passed} passed, ${zeroUnique} with zero unique coverage -> ${path.relative(process.cwd(), out)}`,
  );
}

module.exports = { runTestFile, buildMap, attribute };

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
