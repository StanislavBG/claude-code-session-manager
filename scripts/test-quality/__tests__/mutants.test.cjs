/**
 * mutants.test.cjs — findMutationSites on inline source, plus the real CLI on
 * atomicFs.cjs (byte-identical afterwards, also after SIGTERM mid-run).
 *
 * The CLI runs in a private copy of the tracked tree, never the live checkout.
 * It rewrites its target in place for seconds at a time, and atomicFs.cjs is
 * required by hundreds of test files: run against the live file inside a full
 * `npm run test:unit`, every sibling process that loaded atomicFs during that
 * window got a mutant (e.g. readJsonOrSync's `=== ''` -> `!== ''` returns the
 * fallback for every non-empty file) and failed for no reason of its own —
 * restorableSessions.test.cjs's four claimed-id tests, 2026-11-20.
 *
 * Run: timeout 400 npx vitest run scripts/test-quality/__tests__/mutants.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { findMutationSites, testsMentioning } = require('../mutants.cjs');
const { buildMap } = require('../coverage-map.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SRC = 'src/main/lib/util/atomicFs.cjs';
const LIVE_SRC = path.join(REPO_ROOT, SRC);

let dir;
let mapPath;
let copyRoot; // private copy the CLI mutates; the live checkout is never written
let CLI_COPY;
let SRC_ABS;

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'VITEST_MODE']) delete env[k];
  return env;
};

/**
 * Copy every tracked file (working-tree contents) to `dest`, link node_modules,
 * and stage SRC in a fresh repo so the CLI's clean-file check passes there.
 */
function makeTreeCopy(dest) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(REPO_ROOT, f);
    let st;
    try { st = fs.lstatSync(from); } catch { continue; } // tracked but deleted in the working tree
    if (!st.isFile()) continue;
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.symlinkSync(fs.realpathSync(path.join(REPO_ROOT, 'node_modules')), path.join(dest, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q'], { cwd: dest });
  execFileSync('git', ['add', '--', SRC], { cwd: dest });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-test-'));
  mapPath = path.join(dir, 'map.json');
  copyRoot = path.join(dir, 'tree');
  makeTreeCopy(copyRoot);
  CLI_COPY = path.join(copyRoot, 'scripts/test-quality/mutants.cjs');
  SRC_ABS = path.join(copyRoot, SRC);
  const map = await buildMap(testsMentioning(SRC), { jobs: 2 });
  fs.writeFileSync(mapPath, JSON.stringify(map));
}, 240000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('findMutationSites returns the exact operators', () => {
  const text = [
    'function f(a, b) {',
    '  if (a === b && a < 2) return true;',
    '  return a >= 1 || b != 3;',
    '}',
  ].join('\n');
  const sites = findMutationSites('x.cjs', text);
  expect(sites.map((s) => [s.line, s.op])).toEqual([
    [2, 'if->if-not'],
    [2, '===->!=='],
    [2, '&&->||'],
    [2, '<->>='],
    [2, 'true->false'],
    [3, '>=-><'],
    [3, '||->&&'],
    [3, '!=->=='],
  ]);
  const ifSite = sites[0];
  expect(ifSite.original).toBe('a === b && a < 2');
  expect(ifSite.replacement).toBe('!(a === b && a < 2)');
  expect(text.slice(sites[1].start, sites[1].end)).toBe('===');
});

test('CLI on atomicFs.cjs returns 4 mutants and restores the file', () => {
  const before = fs.readFileSync(SRC_ABS);
  const live = fs.readFileSync(LIVE_SRC);
  const out = path.join(dir, 'out.json');
  const r = spawnSync(
    'node',
    [CLI_COPY, SRC, '--map', mapPath, '--max', '4', '--seed', '1', '--jobs', '2', '--out', out],
    { cwd: copyRoot, env: cleanEnv(), encoding: 'utf8' },
  );
  expect(r.status, r.stderr).toBe(0);
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(res.src).toBe(SRC);
  expect(res.mutants).toHaveLength(4);
  for (const m of res.mutants) expect(Array.isArray(m.killedBy)).toBe(true);
  expect(fs.readFileSync(SRC_ABS).equals(before)).toBe(true);
  expect(fs.readFileSync(LIVE_SRC).equals(live)).toBe(true);
}, 240000);

test('SIGTERM mid-run leaves atomicFs.cjs byte-identical, and the live checkout is never mutated', async () => {
  const before = fs.readFileSync(SRC_ABS);
  const live = fs.readFileSync(LIVE_SRC);
  const child = spawn(
    'node',
    [CLI_COPY, SRC, '--map', mapPath, '--max', '4', '--seed', '1', '--jobs', '2', '--out', path.join(dir, 'o2.json')],
    { cwd: copyRoot, env: cleanEnv(), stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => child.on('close', resolve));
  let mutated = false;
  let liveMutated = false;
  for (let i = 0; i < 40 && !mutated; i++) {
    await new Promise((r) => setTimeout(r, 250));
    mutated = !fs.readFileSync(SRC_ABS).equals(before);
    liveMutated = liveMutated || !fs.readFileSync(LIVE_SRC).equals(live);
  }
  child.kill('SIGTERM');
  await exited;
  expect(mutated).toBe(true);
  expect(liveMutated).toBe(false);
  expect(fs.readFileSync(SRC_ABS).equals(before)).toBe(true);
  expect(fs.readFileSync(LIVE_SRC).equals(live)).toBe(true);
}, 240000);
