'use strict';
// vitest globals (describe/it/expect).
const os = require('node:os');
const path = require('node:path');
const { makeRegisteredRootsCache } = require('../promptSessionsIpc.cjs');

describe('makeRegisteredRootsCache', () => {
  const a = path.join(os.tmpdir(), 'rc-proj-a');
  const b = path.join(os.tmpdir(), 'rc-proj-b');
  let t;
  let list;
  let calls;
  const source = () => { calls += 1; return list.slice(); };
  const make = () => makeRegisteredRootsCache(source, { ttlMs: 10000, missRefreshMs: 1000, now: () => t });
  beforeEach(() => { t = 1000000; list = [a]; calls = 0; });

  it('calls source once for many hits within ttl', () => {
    const c = make();
    for (let i = 0; i < 100; i++) expect(c.has(path.resolve(a))).toBe(true);
    expect(calls).toBe(1);
  });

  it('rebuilds once on a miss and not again within missRefreshMs', () => {
    const c = make();
    expect(c.has(a)).toBe(true);
    t += 2000; // past missRefreshMs, inside ttl
    expect(c.has(b)).toBe(false);
    expect(calls).toBe(2);
    t += 500;
    expect(c.has(b)).toBe(false);
    expect(calls).toBe(2);
  });

  it('accepts a root added to the source after missRefreshMs and after ttlMs', () => {
    const c = make();
    expect(c.has(a)).toBe(true);
    list = [a, b];
    t += 1500;
    expect(c.has(b)).toBe(true);
    const d = path.join(os.tmpdir(), 'rc-proj-d');
    list = [a, b, d];
    t += 11000;
    expect(c.has(d)).toBe(true);
  });

  it('refuses a cwd never in the source', () => {
    const c = make();
    expect(c.has(path.join(os.tmpdir(), 'never'))).toBe(false);
    t += 5000;
    expect(c.has(path.join(os.tmpdir(), 'never'))).toBe(false);
  });

  it('ignores non-string roots and accepts a root whose projectRootOf is itself', () => {
    list = [a, null, 5, ''];
    const c = make();
    expect(c.has(a)).toBe(true);
  });
});
