'use strict';
import { describe, it, expect, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getUpdateStatus, isBehind } = require('../updateCheck.cjs');

function mk(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const fetchJson = vi.fn().mockResolvedValue({ latest: '0.91.1' });
  const writeJson = vi.fn(async (f, data) => { fs.writeFileSync(f, JSON.stringify(data)); });
  const deps = {
    app: { getVersion: () => '0.89.0', getPath: () => dir },
    env: {}, now: () => 1_000_000, packageName: () => 'pkg-x', fetchJson, writeJson, ...over,
  };
  return { dir, fetchJson, writeJson, deps, cache: path.join(dir, 'update-check.json') };
}

describe('getUpdateStatus', () => {
  it('fresh fetch populates the cache and reports behind', async () => {
    const t = mk();
    expect(await getUpdateStatus({ deps: t.deps })).toEqual({ current: '0.89.0', latest: '0.91.1', behind: true });
    expect(t.fetchJson).toHaveBeenCalledWith('https://registry.npmjs.org/-/package/pkg-x/dist-tags', 3000);
    expect(JSON.parse(fs.readFileSync(t.cache, 'utf8'))).toEqual({ checkedAt: 1_000_000, latest: '0.91.1' });
  });
  it('cache hit inside 6h makes no network call', async () => {
    const t = mk();
    fs.writeFileSync(t.cache, JSON.stringify({ checkedAt: 1_000_000 - 1000, latest: '0.91.1' }));
    expect((await getUpdateStatus({ deps: t.deps })).behind).toBe(true);
    expect(t.fetchJson).not.toHaveBeenCalled();
  });
  it('expired cache refetches', async () => {
    const t = mk({ now: () => 1_000_000 + 6 * 3600_000 + 1 });
    fs.writeFileSync(t.cache, JSON.stringify({ checkedAt: 1_000_000, latest: '0.90.0' }));
    expect((await getUpdateStatus({ deps: t.deps })).latest).toBe('0.91.1');
    expect(t.fetchJson).toHaveBeenCalledTimes(1);
  });
  it('corrupt cache is a miss', async () => {
    const t = mk();
    fs.writeFileSync(t.cache, '{nope');
    expect((await getUpdateStatus({ deps: t.deps })).latest).toBe('0.91.1');
  });
  it('offline falls back to latest null', async () => {
    const t = mk({ fetchJson: vi.fn().mockRejectedValue(new Error('ENOTFOUND')) });
    expect(await getUpdateStatus({ deps: t.deps })).toEqual({ current: '0.89.0', latest: null, behind: false });
  });
  it('SM_UPDATE_CHECK=0 and E2E short-circuit with no network call', async () => {
    for (const env of [{ SM_UPDATE_CHECK: '0' }, { SM_E2E: '1' }]) {
      const t = mk({ env });
      expect(await getUpdateStatus({ deps: t.deps })).toEqual({ current: '0.89.0', latest: null, behind: false });
      expect(t.fetchJson).not.toHaveBeenCalled();
    }
  });
});

describe('isBehind', () => {
  it('compares numeric triples', () => {
    expect(isBehind('0.89.0', '0.91.1')).toBe(true);
    expect(isBehind('0.91.1', '0.91.1')).toBe(false);
    expect(isBehind('0.100.0', '0.91.1')).toBe(false);
    expect(isBehind('0.92.0', '0.91.1')).toBe(false);
  });
});
