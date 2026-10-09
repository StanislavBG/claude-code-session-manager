'use strict';

/**
 * mutants.cjs — small deterministic mutation-testing sampler (dev-only).
 *
 * Injects one bug at a time into a source file and runs only the test files
 * that cover the mutated line, using the repo's real test command (not
 * Stryker: its sandbox copy breaks git-dependent and source-reading tests).
 * A test file that kills a mutant no other file kills has proven value.
 *
 * CLI: node scripts/test-quality/mutants.cjs <srcFile> [--map path] [--max N] [--seed N] [--jobs N] [--out path]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { runTestFile, buildMap } = require('./coverage-map.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'test-results', 'test-quality', 'mutants.json');
const MUTANT_TIMEOUT_MS = 60000;

const K = ts.SyntaxKind;
const BINARY_SWAPS = new Map([
  [K.EqualsEqualsEqualsToken, '!=='],
  [K.ExclamationEqualsEqualsToken, '==='],
  [K.EqualsEqualsToken, '!='],
  [K.ExclamationEqualsToken, '=='],
  [K.LessThanToken, '>='],
  [K.GreaterThanToken, '<='],
  [K.LessThanEqualsToken, '>'],
  [K.GreaterThanEqualsToken, '<'],
  [K.AmpersandAmpersandToken, '||'],
  [K.BarBarToken, '&&'],
]);

function findMutationSites(relPath, text) {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  const sites = [];
  const add = (start, end, op, replacement) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    sites.push({
      id: `${relPath}:${line + 1}:${character + 1}:${op}`,
      line: line + 1,
      col: character + 1,
      op,
      original: text.slice(start, end),
      replacement,
      start,
      end,
    });
  };
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && BINARY_SWAPS.has(node.operatorToken.kind)) {
      const t = node.operatorToken;
      const rep = BINARY_SWAPS.get(t.kind);
      add(t.getStart(sf), t.getEnd(), `${text.slice(t.getStart(sf), t.getEnd())}->${rep}`, rep);
    } else if (node.kind === K.TrueKeyword) {
      add(node.getStart(sf), node.getEnd(), 'true->false', 'false');
    } else if (node.kind === K.FalseKeyword) {
      add(node.getStart(sf), node.getEnd(), 'false->true', 'true');
    } else if (ts.isIfStatement(node)) {
      const e = node.expression;
      const s = e.getStart(sf);
      add(s, e.getEnd(), 'if->if-not', `!(${text.slice(s, e.getEnd())})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites.sort((a, b) => a.start - b.start);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coveredLines(map, srcRel) {
  const lineToFiles = new Map();
  for (const [tf, entry] of Object.entries(map.files || {})) {
    const c = (entry.coverage || {})[srcRel];
    if (!c) continue;
    for (const key of [...c.s, ...c.b]) {
      const line = Number(key.split(':')[0]);
      if (!lineToFiles.has(line)) lineToFiles.set(line, new Set());
      lineToFiles.get(line).add(tf);
    }
  }
  return lineToFiles;
}

function sampleSites(sites, lineToFiles, max, seed) {
  const eligible = sites.filter((s) => lineToFiles.has(s.line));
  const rand = mulberry32(seed);
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  return eligible.slice(0, max).sort((a, b) => a.start - b.start);
}

async function runPool(files, jobs) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      results.push(await runTestFile(file, { coverage: false, timeoutMs: MUTANT_TIMEOUT_MS }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  return results;
}

function isDirty(srcRel) {
  try {
    execFileSync('git', ['diff', '--quiet', '--', srcRel], { cwd: ROOT, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

async function runMutants(srcRel, { map, max = 30, seed = 1, jobs } = {}) {
  const abs = path.join(ROOT, srcRel);
  const original = fs.readFileSync(abs);
  const text = original.toString('utf8');
  const concurrency = jobs || Math.max(1, Math.floor(os.cpus().length / 2));
  const picked = sampleSites(findMutationSites(srcRel, text), coveredLines(map, srcRel), max, seed);
  const lineToFiles = coveredLines(map, srcRel);

  const restore = () => fs.writeFileSync(abs, original);
  const onSigint = () => {
    restore();
    process.exit(130);
  };
  const onSigterm = () => {
    restore();
    process.exit(143);
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const mutants = [];
  const tests = {};
  try {
    for (const site of picked) {
      const covering = [...lineToFiles.get(site.line)].sort();
      fs.writeFileSync(abs, text.slice(0, site.start) + site.replacement + text.slice(site.end));
      let killedBy = [];
      try {
        const results = await runPool(covering, concurrency);
        killedBy = results.filter((r) => !r.passed).map((r) => r.file).sort();
      } finally {
        restore();
      }
      mutants.push({ id: site.id, line: site.line, op: site.op, killedBy, survived: killedBy.length === 0 });
    }
  } finally {
    restore();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  for (const m of mutants) {
    for (const f of m.killedBy) {
      tests[f] = tests[f] || { kills: 0, uniqueKills: 0 };
      tests[f].kills++;
      if (m.killedBy.length === 1) tests[f].uniqueKills++;
    }
  }
  return { src: srcRel, mutants, tests };
}

// listIncludedFiles()'s glob matcher needs >=1 directory under __tests__/, so it misses
// direct children like src/main/lib/__tests__/x.test.cjs; add those here.
function directTestFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (path.basename(dir) === '__tests__' && /\.(test|spec)\.cjs$/.test(e.name)) {
        out.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const top of ['src', 'scripts', 'web']) walk(path.join(ROOT, top));
  return out;
}

function testsMentioning(srcRel) {
  const base = path.basename(srcRel, path.extname(srcRel));
  const { listIncludedFiles } = require('../list-pure-tests.cjs');
  return [...new Set([...listIncludedFiles(), ...directTestFiles()])]
    .filter((f) => !f.startsWith('scripts/test-quality/'))
    .filter((f) => {
      try {
        return fs.readFileSync(path.join(ROOT, f), 'utf8').includes(base);
      } catch {
        return false;
      }
    })
    .sort();
}

async function main(argv) {
  let src;
  let mapPath;
  let max = 30;
  let seed = 1;
  let jobs;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map') mapPath = path.resolve(argv[++i]);
    else if (a === '--max') max = Number(argv[++i]);
    else if (a === '--seed') seed = Number(argv[++i]);
    else if (a === '--jobs') jobs = Number(argv[++i]);
    else if (a === '--out') out = path.resolve(argv[++i]);
    else src = a;
  }
  if (!src) {
    console.error('usage: mutants.cjs <srcFile> [--map path] [--max N] [--seed N] [--jobs N] [--out path]');
    process.exit(2);
  }
  const srcRel = path.relative(ROOT, path.resolve(src)).split(path.sep).join('/');
  if (isDirty(srcRel)) {
    console.error(`mutants: ${srcRel} has uncommitted changes; commit or stash first`);
    process.exit(2);
  }
  const map = mapPath
    ? JSON.parse(fs.readFileSync(mapPath, 'utf8'))
    : await buildMap(testsMentioning(srcRel), { jobs });
  const result = await runMutants(srcRel, { map, max, seed, jobs });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result));
  const survived = result.mutants.filter((m) => m.survived).length;
  console.log(
    `mutants: ${srcRel} ${result.mutants.length} mutants, ${survived} survived -> ${path.relative(process.cwd(), out)}`,
  );
}

module.exports = { findMutationSites, runMutants, testsMentioning };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
