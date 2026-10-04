'use strict';

/**
 * Scans the test files matched by vitest.config.ts's `include` globs and prints
 * (newline-separated, relative to repo root) the subset with no observed
 * isolation-breaking side effect: process.env mutation, child_process,
 * require.cache manipulation, vi.mock/vi.resetModules, mkdtemp, fake timers,
 * a jsdom environment pragma, or raw fs writes/removals.
 *
 * Used by vitest.config.ts to build the `pure` project's `include` allowlist —
 * run directly (`node scripts/list-pure-tests.cjs`) to print the list for
 * inspection, or require() it for the array.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const INCLUDE_GLOBS = [
  'tests/unit/**/*.spec.ts',
  'src/renderer/**/*.test.ts',
  'src/renderer/**/*.test.tsx',
  'src/renderer/**/*.spec.ts',
  'src/**/__tests__/**/*.test.cjs',
  'src/**/__tests__/**/*.spec.cjs',
  'scripts/**/__tests__/**/*.test.cjs',
  'web/**/__tests__/**/*.test.cjs',
];

const SIDE_EFFECT_PATTERNS = [
  /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=/, // process.env.X = ... assignment
  /delete\s+process\.env/, // delete process.env.X
  /\bchild_process\b/,
  /require\.cache/,
  /\bvi\.mock\s*\(/,
  /\bvi\.resetModules\s*\(/,
  /\bmkdtemp(?:Sync)?\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bvi\.useFakeTimers\s*\(/,
  /@vitest-environment\s+jsdom/,
  /\bwriteFile(?:Sync)?\s*\(/,
  /\brmSync\s*\(/,
];

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

// Minimal glob matcher covering only the patterns used in INCLUDE_GLOBS above
// (`**` = any depth, a literal filename segment with one leading `*`/exact suffix).
function globToRegExp(glob) {
  const escaped = glob
    .split('/')
    .map((segment) => {
      if (segment === '**') return '.*';
      return segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*');
    })
    .join('/');
  return new RegExp(`^${escaped}$`);
}

function listIncludedFiles() {
  const allFiles = [];
  walk(ROOT, allFiles);
  const relFiles = allFiles.map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  const matchers = INCLUDE_GLOBS.map(globToRegExp);
  return relFiles.filter((f) => matchers.some((re) => re.test(f)));
}

function isPure(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  return !SIDE_EFFECT_PATTERNS.some((re) => re.test(content));
}

function listPureTests() {
  return listIncludedFiles()
    .filter((relPath) => isPure(path.join(ROOT, relPath)))
    .sort();
}

module.exports = { listPureTests, INCLUDE_GLOBS, SIDE_EFFECT_PATTERNS };

if (require.main === module) {
  for (const f of listPureTests()) {
    console.log(f);
  }
}
