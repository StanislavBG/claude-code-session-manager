'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ATTACHMENT_MIMES, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
  sniffImageMime, safeAttachmentName, saveChatImages, composeAttachedPrompt, removeSavedAttachments,
} = require('../epicAttachments.cjs');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const GIF = Buffer.from('GIF89a....', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1')]);
const b64 = (buf) => buf.toString('base64');

let root;
let attDir;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'epic-att-')));
  attDir = path.join(root, 'session-manager-operations', 'prompt-sessions', 'attachments');
  // Production registers each open project root with config.cjs's path boundary.
  require('../../../config.cjs').addAllowedRoot(root);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const listAtt = () => (fs.existsSync(attDir) ? fs.readdirSync(attDir) : []);

test('constants', () => {
  expect(ATTACHMENT_MIMES).toEqual({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' });
  expect(MAX_IMAGES).toBe(6);
  expect(MAX_IMAGE_BYTES).toBe(3 * 1024 * 1024);
  expect(MAX_TOTAL_BYTES).toBe(12 * 1024 * 1024);
});

test('sniffImageMime recognises each format', () => {
  expect(sniffImageMime(PNG)).toBe('image/png');
  expect(sniffImageMime(JPEG)).toBe('image/jpeg');
  expect(sniffImageMime(GIF)).toBe('image/gif');
  expect(sniffImageMime(Buffer.from('GIF87a', 'latin1'))).toBe('image/gif');
  expect(sniffImageMime(WEBP)).toBe('image/webp');
  expect(sniffImageMime(Buffer.from('hello world!'))).toBe(null);
});

test('safeAttachmentName sanitises', () => {
  expect(safeAttachmentName('../../etc/passwd.png', 'image/png')).toBe('passwd.png');
  expect(safeAttachmentName('my photo (1).HEIC', 'image/jpeg')).toBe('my-photo--1-.jpg');
  expect(safeAttachmentName('', 'image/gif')).toBe('image.gif');
  expect(safeAttachmentName(undefined, 'image/webp')).toBe('image.webp');
  expect(safeAttachmentName('a'.repeat(100) + '.png', 'image/png')).toBe('a'.repeat(60) + '.png');
});

test('refusal reasons write nothing', async () => {
  const ok = { name: 'a.png', mime: 'image/png', data: b64(PNG) };
  const cases = [
    [Array.from({ length: MAX_IMAGES + 1 }, () => ok), 'too-many'],
    [[ok, { name: 'x', mime: 'image/tiff', data: b64(PNG) }], 'bad-type'],
    [[ok, { name: 'x', mime: 'image/jpeg', data: b64(PNG) }], 'bad-type'],
    [[ok, { name: 'x', mime: 'image/png', data: 'not base64!' }], 'bad-data'],
    [[ok, { name: 'x', mime: 'image/png', data: 'abc' }], 'bad-data'],
    [[ok, { name: 'x', mime: 'image/png', data: b64(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])) }], 'too-large'],
  ];
  for (const [images, reason] of cases) {
    const r = await saveChatImages({ projectCwd: root, images });
    expect(r).toEqual({ ok: false, reason });
  }
  // total cap: 5 images just under per-image cap exceed 12 MiB together
  const big = b64(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length - 4)]));
  const r = await saveChatImages({ projectCwd: root, images: Array.from({ length: 5 }, () => ({ name: 'b', mime: 'image/png', data: big })) });
  expect(r).toEqual({ ok: false, reason: 'too-large' });
  expect(listAtt()).toEqual([]);
});

test('saves valid images into the attachments dir with identical bytes', async () => {
  const r = await saveChatImages({ projectCwd: root, images: [
    { name: '../../etc/passwd.png', mime: 'image/png', data: b64(PNG) },
    { name: 'pic.jpeg', mime: 'image/jpeg', data: b64(JPEG) },
  ] });
  expect(r.ok).toBe(true);
  expect(r.paths).toHaveLength(2);
  expect(r.paths[0].startsWith(attDir + path.sep)).toBe(true);
  expect(r.names[0]).toMatch(/^[0-9a-f]{8}-passwd\.png$/);
  expect(r.names[1]).toMatch(/^[0-9a-f]{8}-pic\.jpg$/);
  expect(fs.readFileSync(r.paths[0]).equals(PNG)).toBe(true);
  expect(fs.readFileSync(r.paths[1]).equals(JPEG)).toBe(true);
});

test('write failure removes already-written files', async () => {
  let n = 0;
  const writeBinary = async (p, buf) => {
    if (++n === 2) throw new Error('disk full');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  };
  const r = await saveChatImages({ projectCwd: root, images: [
    { name: 'a', mime: 'image/png', data: b64(PNG) },
    { name: 'b', mime: 'image/gif', data: b64(GIF) },
  ] }, { writeBinary });
  expect(r).toEqual({ ok: false, reason: 'write-failed' });
  expect(listAtt()).toEqual([]);
});

test('composeAttachedPrompt', () => {
  expect(composeAttachedPrompt('  hi  ', ['/a.png', '/b.png'])).toBe('hi\n\nAttached: /a.png\nAttached: /b.png');
  expect(composeAttachedPrompt('   ', ['/a.png'])).toBe('Attached: /a.png');
  expect(composeAttachedPrompt(' hi ', [])).toBe('hi');
});

test('removeSavedAttachments ignores paths outside the attachments dir and never throws', async () => {
  const r = await saveChatImages({ projectCwd: root, images: [{ name: 'a', mime: 'image/webp', data: b64(WEBP) }] });
  const outside = path.join(root, 'keep.txt');
  fs.writeFileSync(outside, 'x');
  const sneaky = path.join(attDir, '..', 'sneaky.txt');
  fs.writeFileSync(sneaky, 'x');
  await expect(removeSavedAttachments(root, [outside, sneaky, ...r.paths, path.join(attDir, 'missing.png'), 42])).resolves.toBeUndefined();
  expect(fs.existsSync(outside)).toBe(true);
  expect(fs.existsSync(sneaky)).toBe(true);
  expect(listAtt()).toEqual([]);
});
