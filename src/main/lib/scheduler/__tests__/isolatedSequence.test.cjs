'use strict';
import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGateSequence, runIsolatedSequence } = require('../definitionOfDone.cjs');

function mkcwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iso-seq-test-'));
}
// ~300 ms command that records CI + TMPDIR (and a marker) into its cwd.
function slowSeq(name = 'marker.txt') {
  const script =
    `const fs=require('fs');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(name)},` +
    `JSON.stringify({ci:process.env.CI,tmp:process.env.TMPDIR}))},300)`;
  return [{ argv: ['node', '-e', script], timeoutMs: 10_000, env: {} }];
}
const read = (cwd, name = 'marker.txt') => JSON.parse(fs.readFileSync(path.join(cwd, name), 'utf8'));

test('two concurrent runIsolatedSequence calls both go green', async () => {
  const a = mkcwd();
  const b = mkcwd();
  const [ra, rb] = await Promise.all([
    runIsolatedSequence(slowSeq(), { cwd: a }),
    runIsolatedSequence(slowSeq(), { cwd: b }),
  ]);
  expect(ra.status).toBe('green');
  expect(rb.status).toBe('green');
  expect(fs.existsSync(path.join(a, 'marker.txt'))).toBe(true);
  expect(fs.existsSync(path.join(b, 'marker.txt'))).toBe(true);
});

test('isolated run during a runGateSequence is green, not busy', async () => {
  const a = mkcwd();
  const b = mkcwd();
  const first = runGateSequence(slowSeq(), { cwd: a });
  const second = await runIsolatedSequence(slowSeq(), { cwd: b });
  expect(second.status).toBe('green');
  expect((await first).status).toBe('green');
});

test('runGateSequence during an isolated run is green, not busy', async () => {
  const a = mkcwd();
  const b = mkcwd();
  const first = runIsolatedSequence(slowSeq(), { cwd: a });
  const second = await runGateSequence(slowSeq(), { cwd: b });
  expect(second.status).toBe('green');
  expect((await first).status).toBe('green');
});

test('each run sees CI=1 and its own TMPDIR, removed afterwards', async () => {
  const a = mkcwd();
  const b = mkcwd();
  await Promise.all([
    runIsolatedSequence(slowSeq(), { cwd: a }),
    runIsolatedSequence(slowSeq(), { cwd: b }),
  ]);
  const ma = read(a);
  const mb = read(b);
  expect(ma.ci).toBe('1');
  expect(mb.ci).toBe('1');
  expect(ma.tmp).not.toBe(mb.tmp);
  expect(fs.existsSync(ma.tmp)).toBe(false);
  expect(fs.existsSync(mb.tmp)).toBe(false);
});

test('a step exiting 3 is red with code 3 and the next step does not run', async () => {
  const cwd = mkcwd();
  const seq = [
    { argv: ['node', '-e', 'process.exit(3)'], timeoutMs: 10_000, env: {} },
    { argv: ['node', '-e', "require('fs').writeFileSync('ran.txt','x')"], timeoutMs: 10_000, env: {} },
  ];
  const r = await runIsolatedSequence(seq, { cwd });
  expect(r.status).toBe('red');
  expect(r.results[0].code).toBe(3);
  expect(r.results).toHaveLength(1);
  expect(fs.existsSync(path.join(cwd, 'ran.txt'))).toBe(false);
});

test('empty sequence or missing cwd is unavailable', async () => {
  expect((await runIsolatedSequence([], { cwd: os.tmpdir() })).status).toBe('unavailable');
  expect((await runIsolatedSequence(slowSeq(), { cwd: '/nonexistent-iso-dir' })).status).toBe('unavailable');
});
