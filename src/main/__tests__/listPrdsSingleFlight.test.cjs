'use strict';
// PRD 3063 — concurrent schedule:list-prds calls share one in-flight scan per cwd.
import { describe, it, expect } from 'vitest';

const {
  createSingleFlight,
  listKeyFor,
  flatString,
  flattenPrdEntry,
  MACHINE_WIDE_KEY,
} = require('../lib/prd/listPrdsSingleFlight.cjs');

function deferredScan() {
  const calls = [];
  const fn = (arg) => new Promise((resolve, reject) => { calls.push({ arg, resolve, reject }); });
  return { calls, fn };
}

const keyOf = (arg) => listKeyFor(arg && arg.cwd);

describe('listPrdsSingleFlight', () => {
  it('5 concurrent calls with the same cwd run 1 scan and share its result', async () => {
    const { calls, fn } = deferredScan();
    const shared = createSingleFlight(fn, keyOf);
    const ps = Array.from({ length: 5 }, () => shared({ cwd: '/p/a' }));
    expect(calls.length).toBe(1);
    calls[0].resolve(['x']);
    const results = await Promise.all(ps);
    for (const r of results) expect(r).toBe(results[0]);
    // After settling, a new call starts a fresh scan.
    const p6 = shared({ cwd: '/p/a' });
    expect(calls.length).toBe(2);
    calls[1].resolve([]);
    await p6;
  });

  it('absent cwd shares one machine-wide key', async () => {
    const { calls, fn } = deferredScan();
    const shared = createSingleFlight(fn, keyOf);
    const ps = [shared(), shared({}), shared({ cwd: '' }), shared(undefined)];
    expect(calls.length).toBe(1);
    expect(shared.inFlight.has(MACHINE_WIDE_KEY)).toBe(true);
    calls[0].resolve([]);
    await Promise.all(ps);
    expect(shared.inFlight.size).toBe(0);
  });

  it('different cwds run separate scans', async () => {
    const { calls, fn } = deferredScan();
    const shared = createSingleFlight(fn, keyOf);
    const pa = shared({ cwd: '/p/a' });
    const pb = shared({ cwd: '/p/b' });
    const pAll = shared();
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.arg && c.arg.cwd)).toEqual(['/p/a', '/p/b', undefined]);
    calls.forEach((c, i) => c.resolve([i]));
    expect(await pa).toEqual([0]);
    expect(await pb).toEqual([1]);
    expect(await pAll).toEqual([2]);
  });

  it('a rejected scan clears the slot so the next call rescans', async () => {
    const { calls, fn } = deferredScan();
    const shared = createSingleFlight(fn, keyOf);
    const p1 = shared({ cwd: '/p/a' });
    const p2 = shared({ cwd: '/p/a' });
    calls[0].reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    expect(shared.inFlight.size).toBe(0);
    const p3 = shared({ cwd: '/p/a' });
    expect(calls.length).toBe(2);
    calls[1].resolve(['ok']);
    expect(await p3).toEqual(['ok']);
  });

  it('a synchronous throw also clears the slot', async () => {
    let n = 0;
    const shared = createSingleFlight(() => { n++; throw new Error('sync'); }, keyOf);
    await expect(shared()).rejects.toThrow('sync');
    await expect(shared()).rejects.toThrow('sync');
    expect(n).toBe(2);
  });

  it('flattens string fields and string array items, leaving other values alone', () => {
    const text = 'title: Hello world\n'.repeat(1000);
    const title = text.slice(7, 18);
    const entry = flattenPrdEntry({ title, dependsOn: [text.slice(0, 5), 'b'], mtimeMs: 5, epicId: null, archived: false });
    expect(entry).toEqual({ title: 'Hello world', dependsOn: ['title', 'b'], mtimeMs: 5, epicId: null, archived: false });
    expect(flatString(undefined)).toBe(undefined);
    expect(flatString('')).toBe('');
    expect(flatString('héllo ✓')).toBe('héllo ✓');
  });
});
