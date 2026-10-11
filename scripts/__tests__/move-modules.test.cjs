/**
 * move-modules.test.cjs — the lib partition codemod moves modules + tests,
 * rewrites relative requires and literal path strings, is idempotent, and
 * refuses bad mappings, all against a scratch git repo.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/move-modules.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../move-modules.cjs');
const L = 'src/main/lib';
const FILES = {
  [`${L}/alpha.cjs`]: "const b = require('./beta.cjs')\nconst c = require('./gamma')\nconst p = require('../../../package.json')\nmodule.exports = { b, c, p }\n",
  [`${L}/beta.cjs`]: "module.exports = {}\n",
  [`${L}/gamma.cjs`]: "const a = require('./alpha.cjs')\nmodule.exports = { a }\n",
  [`${L}/__tests__/alpha.test.cjs`]: "const a = require('../alpha.cjs')\nconst g = require('../gamma.cjs')\nvoid a; void g\n",
  'src/main/index.cjs': "const a = require('./lib/alpha.cjs')\nconst b = require('./lib/beta.cjs')\nvoid a; void b\n",
  'docs/notes.md': 'See `src/main/lib/alpha.cjs` and lib/beta.cjs, plus src/main/lib/gamma.cjs.\n',
};

let root;
const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' }).toString();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
const mapFile = () => path.join(root, '..', path.basename(root) + '.map.json');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-modules-'));
  for (const [p, c] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  }
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  fs.writeFileSync(mapFile(), JSON.stringify({ alpha: 'core', beta: 'util' }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(mapFile(), { force: true });
});

test('moves modules and tests, rewrites requires and path strings', () => {
  const r = run(mapFile(), root);
  expect(r.status).toBe(0);
  expect(fs.existsSync(path.join(root, `${L}/core/alpha.cjs`))).toBe(true);
  expect(fs.existsSync(path.join(root, `${L}/util/beta.cjs`))).toBe(true);
  expect(fs.existsSync(path.join(root, `${L}/core/__tests__/alpha.test.cjs`))).toBe(true);
  expect(fs.existsSync(path.join(root, `${L}/alpha.cjs`))).toBe(false);
  expect(read(`${L}/core/alpha.cjs`)).toContain("require('../util/beta.cjs')");
  expect(read(`${L}/core/alpha.cjs`)).toContain("require('../gamma')");
  expect(read(`${L}/core/alpha.cjs`)).toContain("require('../../../../package.json')");
  expect(read(`${L}/gamma.cjs`)).toContain("require('./core/alpha.cjs')");
  expect(read(`${L}/core/__tests__/alpha.test.cjs`)).toContain("require('../alpha.cjs')");
  expect(read(`${L}/core/__tests__/alpha.test.cjs`)).toContain("require('../../gamma.cjs')");
  expect(read('src/main/index.cjs')).toContain("require('./lib/core/alpha.cjs')");
  expect(read('src/main/index.cjs')).toContain("require('./lib/util/beta.cjs')");
  expect(read('docs/notes.md')).toBe('See `src/main/lib/core/alpha.cjs` and lib/util/beta.cjs, plus src/main/lib/gamma.cjs.\n');
});

test('second run changes nothing', () => {
  expect(run(mapFile(), root).status).toBe(0);
  git('add', '-A');
  const before = git('status', '--porcelain') + git('diff', 'HEAD');
  const r = run(mapFile(), root);
  expect(r.status).toBe(0);
  expect(git('status', '--porcelain') + git('diff', 'HEAD')).toBe(before);
  expect(r.stdout).toMatch(/0 edit/);
});

test('--dry-run reports and writes nothing', () => {
  const r = run(mapFile(), root, '--dry-run');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('alpha.cjs');
  expect(r.stdout).toMatch(/edit/);
  expect(git('status', '--porcelain')).toBe('');
  expect(fs.existsSync(path.join(root, `${L}/alpha.cjs`))).toBe(true);
});

test('exits 1 when a mapped module is missing', () => {
  fs.writeFileSync(mapFile(), JSON.stringify({ nope: 'core' }));
  const r = run(mapFile(), root);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('nope');
  expect(git('status', '--porcelain')).toBe('');
});

test('exits 1 when a target already exists', () => {
  fs.mkdirSync(path.join(root, `${L}/core`), { recursive: true });
  fs.writeFileSync(path.join(root, `${L}/core/alpha.cjs`), '');
  const r = run(mapFile(), root);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('already exists');
});
