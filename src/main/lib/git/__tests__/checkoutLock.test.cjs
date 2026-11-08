'use strict';
import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gw = require('../gitWorktree.cjs');

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cklock-')); dirs.push(d); return d; };
const tick = () => new Promise((r) => setTimeout(r, 15));

/** Runs two fns through the lock for (cwdA, cwdB); records start/end order. */
async function race(cwdA, cwdB, { firstRejects = false } = {}) {
  const log = [];
  let releaseFirst;
  const first = gw.withCheckoutLock(cwdA, () => new Promise((resolve, reject) => {
    log.push('a:start');
    releaseFirst = () => { log.push('a:end'); (firstRejects ? reject(new Error('boom')) : resolve('A')); };
  }));
  const second = gw.withCheckoutLock(cwdB, async () => { log.push('b:start'); return 'B'; });
  await tick();
  releaseFirst();
  const settled = await Promise.allSettled([first, second]);
  return { log, settled };
}

test('same cwd: second fn starts only after the first settles', async () => {
  const d = tmp();
  const { log, settled } = await race(d, d);
  expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  expect(settled.map((s) => s.status === 'fulfilled' && s.value)).toEqual(['A', 'B']);
});

test('same cwd: a rejecting first fn still releases the lock and keeps its own rejection', async () => {
  const d = tmp();
  const { log, settled } = await race(d, d, { firstRejects: true });
  expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  expect(settled[0].status).toBe('rejected');
  expect(settled[0].reason.message).toBe('boom');
  expect(settled[1]).toEqual({ status: 'fulfilled', value: 'B' });
});

test('a synchronously throwing fn rejects without wedging the next caller', async () => {
  const d = tmp();
  await expect(gw.withCheckoutLock(d, () => { throw new Error('sync'); })).rejects.toThrow('sync');
  await expect(gw.withCheckoutLock(d, () => 'next')).resolves.toBe('next');
});

test('trailing-slash path shares one lock with the plain path', async () => {
  const d = tmp();
  const { log } = await race(d, `${d}/`);
  expect(log).toEqual(['a:start', 'a:end', 'b:start']);
});

test('symlinked path shares one lock with the real checkout', async () => {
  const d = tmp();
  const real = path.join(d, 'real');
  fs.mkdirSync(real);
  const link = path.join(d, 'link');
  fs.symlinkSync(real, link);
  const { log } = await race(real, link);
  expect(log).toEqual(['a:start', 'a:end', 'b:start']);
});

test('different cwds overlap', async () => {
  const { log } = await race(tmp(), tmp());
  expect(log).toEqual(['a:start', 'b:start', 'a:end']);
});

test('map entry is deleted once a chain drains', async () => {
  const d = tmp();
  const key = fs.realpathSync(d);
  const p = gw.withCheckoutLock(d, async () => 1);
  const q = gw.withCheckoutLock(d, async () => 2);
  expect(gw._checkoutLocks.has(key)).toBe(true);
  await Promise.all([p, q]);
  await tick();
  expect(gw._checkoutLocks.has(key)).toBe(false);
});

test('integrateBranch takes the checkout lock with the checkout cwd', async () => {
  const root = tmp();
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  const git = (a) => execFileSync('git', a, { cwd: main, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@e.com']);
  git(['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(main, 'a.txt'), '1\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  git(['checkout', '-q', '-b', 'feat']);
  fs.writeFileSync(path.join(main, 'b.txt'), '2\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'feat']);
  git(['checkout', '-q', 'main']);

  const spy = vi.spyOn(gw, 'withCheckoutLock');
  const r = await gw.integrateBranch({ cwd: main, branch: 'feat', key: 'k', kind: 'job', baseBranch: 'main' });
  expect(r).toMatchObject({ ok: true, integrated: true });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0]).toBe(main);
});
