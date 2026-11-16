'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { makeRefResolver } = require('../lib/memoryRefResolve.cjs');

const HOME = '/home/u';
const CWD = '/home/u/proj';
const TRACKED = ['src/renderer/lib/epicIntake.ts', 'README.md'];

function make(existing = []) {
  const calls = [];
  const exists = (p) => { calls.push(p); return existing.includes(p); };
  return { resolve: makeRefResolver({ cwd: CWD, trackedFiles: TRACKED, exists, home: HOME }), calls };
}

test('repo-root hit via exists', () => {
  const { resolve } = make([`${CWD}/docs/a.md`]);
  assert.equal(resolve('docs/a.md'), true);
});

test('exact tracked hit', () => {
  assert.equal(make().resolve('README.md'), true);
});

test('suffix tracked hit', () => {
  assert.equal(make().resolve('lib/epicIntake.ts'), true);
});

test('suffix must align on a path segment', () => {
  assert.equal(make().resolve('ntake.ts'), false);
});

test('sibling root hit with ~ expansion and absolute root', () => {
  const { resolve } = make([`${HOME}/Projects/Bilko/server/routes/stripe.ts`]);
  assert.equal(resolve('server/routes/stripe.ts', ['~/Projects/Bilko']), true);
  assert.equal(resolve('server/routes/stripe.ts', [`${HOME}/Projects/Bilko`]), true);
});

test('root outside home is ignored', () => {
  const { resolve, calls } = make(['/etc/server/x.ts']);
  assert.equal(resolve('server/x.ts', ['/etc']), false);
  assert.equal(calls.includes('/etc/server/x.ts'), false);
});

test("'..', leading / and ~ rejected without calling exists", () => {
  const { resolve, calls } = make(['/etc/passwd']);
  assert.equal(resolve('../x.ts'), false);
  assert.equal(resolve('a/../b.ts'), false);
  assert.equal(resolve('/etc/passwd'), false);
  assert.equal(resolve('~/x.ts'), false);
  assert.deepEqual(calls, []);
});

test('no hit returns false', () => {
  assert.equal(make().resolve('nope/missing.ts', ['~/Projects/Bilko']), false);
});

const { listRenames } = require('../lib/memoryRefResolve.cjs');

test('extraBases: hit, miss, and outside-home ignored', () => {
  const calls = [];
  const existing = [`${HOME}/proj/session-manager-operations/scheduler/state/history.jsonl`, '/etc/ops/x.json'];
  const exists = (p) => { calls.push(p); return existing.includes(p); };
  const resolve = makeRefResolver({
    cwd: CWD, trackedFiles: [], exists, home: HOME,
    extraBases: [`${CWD}/session-manager-operations`, '/etc/ops'],
  });
  assert.equal(resolve('scheduler/state/history.jsonl'), true);
  assert.equal(resolve('scheduler/state/missing.jsonl'), false);
  assert.equal(resolve('x.json'), false);
  assert.equal(calls.some((p) => p.startsWith('/etc/')), false);
});

function stubExec(stdout, err = null) {
  const seen = [];
  const exec = (cmd, args, opts, cb) => { seen.push({ cmd, args, opts }); cb(err, stdout); };
  return { exec, seen };
}

test('listRenames parses one git log call, newest wins, follows chains', async () => {
  // git log prints newest first: a -> b (old), then b -> c (newer), and x -> y then x -> z (z newest)
  const out = [
    '', 'R100\tsrc/b.cjs\tsrc/c.cjs', '', 'R095\tsrc/x.cjs\tsrc/z.cjs', '',
    'R100\tsrc/a.cjs\tsrc/b.cjs', 'M\tsrc/other.cjs', 'R090\tsrc/x.cjs\tsrc/y.cjs', '',
  ].join('\n');
  const { exec, seen } = stubExec(out);
  const map = await listRenames('/repo', exec);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cmd, 'git');
  assert.deepEqual(seen[0].args, ['-C', '/repo', 'log', '--diff-filter=R', '--name-status', '--format=', '-M', 'HEAD']);
  assert.equal(seen[0].opts.timeout, 10_000);
  assert.equal(seen[0].opts.maxBuffer, 32 * 1024 * 1024);
  assert.equal(map.get('src/a.cjs'), 'src/c.cjs');
  assert.equal(map.get('src/b.cjs'), 'src/c.cjs');
  assert.equal(map.get('src/x.cjs'), 'src/z.cjs');
  assert.equal(map.has('src/other.cjs'), false);
});

test('listRenames stops cycles and caps at 10 hops', async () => {
  const cyc = ['R100\tb\ta', 'R100\ta\tb'].join('\n'); // a->b, later b->a
  const map = await listRenames('/repo', stubExec(cyc).exec);
  assert.equal(map.has('a'), false); // a -> b -> a: back where it started
  assert.equal(map.get('b'), 'a');
  const long = [];
  for (let i = 14; i >= 0; i--) long.push(`R100\tp${i}\tp${i + 1}`);
  const m2 = await listRenames('/repo', stubExec(long.join('\n')).exec);
  assert.equal(m2.get('p0'), 'p10');
});

test('listRenames returns empty Map on error', async () => {
  const map = await listRenames('/repo', stubExec('', new Error('boom')).exec);
  assert.equal(map instanceof Map, true);
  assert.equal(map.size, 0);
});
