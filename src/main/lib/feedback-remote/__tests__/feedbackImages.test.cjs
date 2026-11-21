/**
 * feedbackImages.test.cjs — prepareFeedbackImages validation, sniffing, downscale and caps.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/feedbackImages.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fi = require('../feedbackImages.cjs');

// 1x1 transparent PNG.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TINY_PNG = Buffer.from(TINY_PNG_B64, 'base64');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-images-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Buffer starting with `sig`, padded to `size` bytes. */
function padded(sig, size) {
  const b = Buffer.alloc(size, 0x41);
  sig.copy(b, 0);
  return b;
}

test('constants', () => {
  expect(fi.MAX_FEEDBACK_IMAGES).toBe(5);
  expect(fi.MAX_IMAGE_DATAURL_CHARS).toBe(1900000);
  expect(fi.MAX_TOTAL_DATAURL_CHARS).toBe(8000000);
  expect(fi.MAX_RAW_IMAGE_BYTES).toBe(26214400);
});

test('empty and undefined input resolve no images', async () => {
  expect(await fi.prepareFeedbackImages([])).toEqual({ ok: true, images: [] });
  expect(await fi.prepareFeedbackImages(undefined)).toEqual({ ok: true, images: [] });
});

test('6 inputs are refused naming the 5-image limit', async () => {
  const dataUrl = `data:image/png;base64,${TINY_PNG_B64}`;
  const r = await fi.prepareFeedbackImages(Array.from({ length: 6 }, () => ({ dataUrl })));
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/5 images/);
});

test('a real tiny PNG file path is accepted', async () => {
  const p = path.join(dir, 'shot.png');
  fs.writeFileSync(p, TINY_PNG);
  const r = await fi.prepareFeedbackImages([{ path: p }]);
  expect(r.ok).toBe(true);
  expect(r.images).toHaveLength(1);
  expect(r.images[0].mime).toBe('image/png');
  expect(r.images[0].bytes).toBe(TINY_PNG.length);
  expect(r.images[0].dataUrl).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
});

test('a relative path is refused with the 1-based index', async () => {
  const dataUrl = `data:image/png;base64,${TINY_PNG_B64}`;
  const r = await fi.prepareFeedbackImages([{ dataUrl }, { path: 'shot.png' }]);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Image 2/);
  expect(r.error).toMatch(/absolute/);
});

test('a non-image file is refused without leaking its contents', async () => {
  const p = path.join(dir, 'notes.txt');
  fs.writeFileSync(p, 'SECRET-CONTENTS do not leak');
  const r = await fi.prepareFeedbackImages([{ path: p }]);
  expect(r.ok).toBe(false);
  expect(r.error).toBe('Image 1 (notes.txt) is not a PNG, JPEG, WebP or GIF file.');
  expect(r.error).not.toMatch(/SECRET/);
});

test('an input with both or neither of path/dataUrl is refused', async () => {
  expect((await fi.prepareFeedbackImages([{}])).ok).toBe(false);
  const both = await fi.prepareFeedbackImages([{ path: '/x.png', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` }]);
  expect(both.ok).toBe(false);
});

test('a data URL whose bytes do not match the declared mime is refused', async () => {
  const r = await fi.prepareFeedbackImages([{ dataUrl: `data:image/jpeg;base64,${TINY_PNG_B64}` }]);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Image 1/);
  const svg = await fi.prepareFeedbackImages([{ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }]);
  expect(svg.ok).toBe(false);
});

test('an oversize PNG is downscaled to JPEG through the nativeImage seam', async () => {
  const big = padded(PNG_SIG, 1500000); // base64 ≈ 2,000,000 chars > cap
  const calls = [];
  const fakeImg = {
    isEmpty: () => false,
    getSize: () => ({ width: 4000, height: 3000 }),
    resize(opts) { calls.push(['resize', opts]); return fakeImg; },
    toJPEG(q) {
      calls.push(['toJPEG', q]);
      // Only 1600px at q70 is small enough.
      const lastResize = calls.filter((c) => c[0] === 'resize').pop();
      const fits = lastResize && lastResize[1].width === 1600 && q === 70;
      return padded(JPEG_SIG, fits ? 1000 : 1500000);
    },
  };
  const nativeImage = { createFromBuffer: () => fakeImg };
  const r = await fi.prepareFeedbackImages([{ dataUrl: `data:image/png;base64,${big.toString('base64')}` }], { nativeImage });
  expect(r.ok).toBe(true);
  expect(r.images[0].mime).toBe('image/jpeg');
  expect(r.images[0].bytes).toBe(1000);
  expect(r.images[0].dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(calls).toEqual([
    ['resize', { width: 2000, quality: 'good' }], ['toJPEG', 85], ['toJPEG', 70],
    ['resize', { width: 1600, quality: 'good' }], ['toJPEG', 85], ['toJPEG', 70],
  ]);
});

test('an oversize PNG that never fits is refused', async () => {
  const big = padded(PNG_SIG, 1500000);
  const fakeImg = {
    isEmpty: () => false,
    getSize: () => ({ width: 1000, height: 3000 }),
    resize: () => fakeImg,
    toJPEG: () => padded(JPEG_SIG, 1500000),
  };
  const r = await fi.prepareFeedbackImages([{ dataUrl: `data:image/png;base64,${big.toString('base64')}` }],
    { nativeImage: { createFromBuffer: () => fakeImg } });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Image 1 is too large/);
});

test('an oversize WebP is refused', async () => {
  const webp = Buffer.alloc(1500000, 0x41);
  Buffer.from('RIFF').copy(webp, 0);
  Buffer.from('WEBP').copy(webp, 8);
  const r = await fi.prepareFeedbackImages([{ dataUrl: `data:image/webp;base64,${webp.toString('base64')}` }],
    { nativeImage: { createFromBuffer: () => { throw new Error('must not be called'); } } });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/WebP and GIF/);
});

test('the sum of data URLs above the total cap is refused', async () => {
  const each = padded(PNG_SIG, 1400000); // ≈1,866,690 chars each; 5 ≈ 9.3M > 8M
  const dataUrl = `data:image/png;base64,${each.toString('base64')}`;
  expect(dataUrl.length).toBeLessThanOrEqual(fi.MAX_IMAGE_DATAURL_CHARS);
  const r = await fi.prepareFeedbackImages(Array.from({ length: 5 }, () => ({ dataUrl })));
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/in total/);
});
