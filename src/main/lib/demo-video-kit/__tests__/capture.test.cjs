'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { capture, IMAGE_BUDGET, CLIP_BUDGET } = require('../capture.cjs');

function fakePw(log = {}) {
  const page = {
    setDefaultTimeout() {},
    async goto(u, o) { (log.gotos ||= []).push([u, o.timeout]); },
    locator() { return { first: () => ({ boundingBox: async () => ({ x: 1, y: 2, width: 30, height: 40 }), scrollIntoViewIfNeeded: async () => {} }) }; },
  };
  return { chromium: { launch: async () => ({ newPage: async () => page, close: async () => { log.closed = true; } }) } };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));

describe('capture', () => {
  it('skips without a url', async () => {
    expect(await capture({ outDir: tmp(), loadPlaywright: () => fakePw() })).toEqual({ skipped: 'no-url' });
  });
  it('skips without playwright', async () => {
    expect(await capture({ url: 'http://x', outDir: tmp(), loadPlaywright: () => null })).toEqual({ skipped: 'no-playwright' });
  });
  it('steps quality down within 6 tries and records focus', async () => {
    const qs = [];
    const encode = async (_p, { quality }) => { qs.push(quality); return Buffer.alloc(quality > 40 ? IMAGE_BUDGET + 1 : 1000); };
    const log = {};
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{ selector: '#a' }], loadPlaywright: () => fakePw(log), encode, navTimeoutMs: 999999 });
    expect(qs).toEqual([80, 65, 52, 40]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'image', bytes: 1000, focus: { x: 1, y: 2, w: 30, h: 40 } });
    expect(log.gotos).toEqual([['http://x', 30000]]);
    expect(log.closed).toBe(true);
  });
  it('drops an image never fitting after 6 tries and oversized clips', async () => {
    let calls = 0;
    const encode = async (_p, { kind }) => { calls++; return Buffer.alloc((kind === 'image' ? IMAGE_BUDGET : CLIP_BUDGET) + 1); };
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: [{}, { kind: 'clip' }], loadPlaywright: () => fakePw(), encode });
    expect(r.items).toEqual([]);
    expect(calls).toBeLessThanOrEqual(6 + 6);
  });
  it('caps at 6 shots', async () => {
    const encode = async () => Buffer.alloc(10);
    const r = await capture({ url: 'http://x', outDir: tmp(), shots: Array.from({ length: 10 }, () => ({})), max: 20, loadPlaywright: () => fakePw(), encode });
    expect(r.items).toHaveLength(6);
  });
});
