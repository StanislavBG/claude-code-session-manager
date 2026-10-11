/**
 * mutants.test.cjs — findMutationSites on inline source, plus the real CLI on
 * atomicFs.cjs (byte-identical afterwards, also after SIGTERM mid-run).
 *
 * Run: timeout 400 npx vitest run scripts/test-quality/__tests__/mutants.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { findMutationSites, testsMentioning } = require('../mutants.cjs');
const { buildMap } = require('../coverage-map.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(REPO_ROOT, 'scripts/test-quality/mutants.cjs');
const SRC = 'src/main/lib/util/atomicFs.cjs';
const SRC_ABS = path.join(REPO_ROOT, SRC);

let dir;
let mapPath;

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'VITEST_MODE']) delete env[k];
  return env;
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-test-'));
  mapPath = path.join(dir, 'map.json');
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
  const out = path.join(dir, 'out.json');
  const r = spawnSync(
    'node',
    [CLI, SRC, '--map', mapPath, '--max', '4', '--seed', '1', '--jobs', '2', '--out', out],
    { cwd: REPO_ROOT, env: cleanEnv(), encoding: 'utf8' },
  );
  expect(r.status, r.stderr).toBe(0);
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(res.src).toBe(SRC);
  expect(res.mutants).toHaveLength(4);
  for (const m of res.mutants) expect(Array.isArray(m.killedBy)).toBe(true);
  expect(fs.readFileSync(SRC_ABS).equals(before)).toBe(true);
}, 240000);

test('SIGTERM mid-run leaves atomicFs.cjs byte-identical', async () => {
  const before = fs.readFileSync(SRC_ABS);
  const child = spawn(
    'node',
    [CLI, SRC, '--map', mapPath, '--max', '4', '--seed', '1', '--jobs', '2', '--out', path.join(dir, 'o2.json')],
    { cwd: REPO_ROOT, env: cleanEnv(), stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => child.on('close', resolve));
  let mutated = false;
  for (let i = 0; i < 40 && !mutated; i++) {
    await new Promise((r) => setTimeout(r, 250));
    mutated = !fs.readFileSync(SRC_ABS).equals(before);
  }
  child.kill('SIGTERM');
  await exited;
  expect(mutated).toBe(true);
  expect(fs.readFileSync(SRC_ABS).equals(before)).toBe(true);
}, 240000);
