'use strict';

/**
 * coverage-guard.cjs — safety net for cutting test bloat (dev-only).
 *
 * For a diff that only deletes, merges or rewrites tests, checks that every
 * source statement/branch the OLD tests covered is still covered by the NEW
 * tests plus the unchanged tests. Exit 0 = nothing dropped, 1 = dropped keys
 * listed, 2 = diff touches non-test source (or bad usage).
 *
 * CLI: node scripts/test-quality/coverage-guard.cjs --base <ref>   (cwd = repo)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { INCLUDE_GLOBS } = require('../list-pure-tests.cjs');

const TEST_RES = INCLUDE_GLOBS.map((glob) => {
  const body = glob
    .split('/')
    .map((seg) =>
      seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
    )
    .join('/');
  return new RegExp(`^${body}$`);
});
const isTestFile = (rel) => TEST_RES.some((re) => re.test(rel));
const isSourceFile = (rel) =>
  (rel.startsWith('src/') || rel.startsWith('scripts/')) &&
  !rel.split('/').includes('__tests__') &&
  !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Parse `git diff --name-status`: renames/copies become delete(old) + add(new). */
function parseNameStatus(text) {
  const changes = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [st, a, b] = line.split('\t');
    const c = st[0];
    if (c === 'R') {
      changes.push({ status: 'D', file: a }, { status: 'A', file: b });
    } else if (c === 'C') changes.push({ status: 'A', file: b });
    else changes.push({ status: c === 'T' ? 'M' : c, file: a });
  }
  return changes;
}

function findNodeModules(repoRoot) {
  const local = path.join(repoRoot, 'node_modules');
  if (fs.existsSync(local)) return local;
  // Linked worktree without its own install: use the main checkout's.
  const common = path.resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir']).trim());
  return path.join(path.dirname(common), 'node_modules');
}

async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Union of "<src>|s:<key>" / "<src>|b:<key>" over the given test files, run inside `root`. */
async function unionCoverage(root, files, label) {
  // coverage-map resolves ROOT from its own location, so load the copy living in `root`.
  const { runTestFile } = require(path.join(root, 'scripts/test-quality/coverage-map.cjs'));
  const keys = new Set();
  const results = await pool(files, Math.max(1, Math.floor(os.cpus().length / 2)), (f) =>
    runTestFile(f),
  );
  results.forEach((r) => {
    if (!r.passed) console.error(`coverage-guard: warning: ${label} test did not pass: ${r.file}`);
    for (const [src, c] of Object.entries(r.coverage || {})) {
      for (const k of c.s) keys.add(`${src}|s:${k}`);
      for (const k of c.b) keys.add(`${src}|b:${k}`);
    }
  });
  return keys;
}

async function main(argv) {
  const bi = argv.indexOf('--base');
  const base = bi >= 0 ? argv[bi + 1] : null;
  if (!base) {
    console.error('usage: coverage-guard.cjs --base <ref>');
    return 2;
  }
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const changes = parseNameStatus(git(repoRoot, ['diff', '--name-status', base, 'HEAD']));

  const nonTest = changes.filter((c) => !isTestFile(c.file) && isSourceFile(c.file));
  if (nonTest.length) {
    console.error('coverage-guard: needs a test-only diff');
    for (const c of nonTest) console.error(`  ${c.status} ${c.file}`);
    return 2;
  }

  const testChanges = changes.filter((c) => isTestFile(c.file));
  const beforeFiles = testChanges.filter((c) => c.status !== 'A').map((c) => c.file);
  const added = testChanges.filter((c) => c.status === 'A').map((c) => c.file);
  const modified = testChanges.filter((c) => c.status === 'M').map((c) => c.file);

  // Before: base versions of changed + deleted tests, inside a detached worktree of HEAD.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-guard-'));
  const wt = path.join(tmp, 'wt');
  let before = new Set();
  try {
    git(repoRoot, ['worktree', 'add', '--detach', wt, 'HEAD']);
    for (const f of beforeFiles) git(wt, ['checkout', base, '--', f]);
    for (const f of added) fs.rmSync(path.join(wt, f), { force: true });
    fs.symlinkSync(findNodeModules(repoRoot), path.join(wt, 'node_modules'), 'dir');
    before = await unionCoverage(wt, beforeFiles, 'before');
  } finally {
    try {
      git(repoRoot, ['worktree', 'remove', '--force', wt]);
    } catch {
      /* worktree never created */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      git(repoRoot, ['worktree', 'prune']);
    } catch {
      /* best effort */
    }
  }

  const beforeSrcs = [...new Set([...before].map((k) => k.split('|')[0]))];
  const basenames = beforeSrcs.map((s) => path.basename(s).replace(/\.[^.]+$/, ''));

  // After: current changed/added tests + unchanged tests that mention a Before source.
  const changedSet = new Set(testChanges.map((c) => c.file));
  const touched = [...modified, ...added].filter((f) => fs.existsSync(path.join(repoRoot, f)));
  const unchanged = git(repoRoot, ['ls-files'])
    .split('\n')
    .filter((f) => f && isTestFile(f) && !changedSet.has(f))
    .filter((f) => {
      const text = fs.readFileSync(path.join(repoRoot, f), 'utf8');
      return basenames.some((b) => text.includes(b));
    });
  const after = await unionCoverage(repoRoot, [...touched, ...unchanged], 'after');

  const dropped = [...before].filter((k) => !after.has(k)).sort();
  if (!dropped.length) {
    console.log(`coverage-guard: OK ${beforeSrcs.length} src files, 0 dropped`);
    return 0;
  }
  const lineCache = new Map();
  const lineText = (src, line) => {
    if (!lineCache.has(src)) {
      try {
        lineCache.set(src, fs.readFileSync(path.join(repoRoot, src), 'utf8').split('\n'));
      } catch {
        lineCache.set(src, []);
      }
    }
    return (lineCache.get(src)[line - 1] || '').trim();
  };
  for (const k of dropped) {
    const [src, rest] = k.split('|');
    const key = rest.slice(2);
    console.log(`${src}  ${rest}  ${lineText(src, Number(key.split(':')[0]))}`);
  }
  console.log(`coverage-guard: DROPPED ${dropped.length} keys`);
  return 1;
}

module.exports = { parseNameStatus, isTestFile };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
