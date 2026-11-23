/**
 * scheduler-mcp-server-htmlPath.test.cjs — the htmlPath reader's size cap:
 * project_video_write scales it by lengthS (2 MiB per started 30 s, the same
 * rule as POST /admin/project-home/videos/write), other tools keep 2 MiB, and
 * the absolute-path and extension checks still refuse bad paths.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-mcp-server-htmlPath.test.cjs
 */
'use strict';

import { test, expect, afterAll, beforeAll } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const server = require('../../../scripts/scheduler-mcp-server.cjs');
const { maxVideoBytes, maxExportMp4Bytes, MAX_EXPORT_POSTER_BYTES } = require('../lib/feedback-remote/projectHomeAdminRoutes.cjs');

const MiB = 1024 * 1024;
const callTool = (name, args) => server.handleCallTool({ params: { name, arguments: args } });
let dir;
let bigHtml;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-htmlpath-'));
  bigHtml = path.join(dir, 'video.html');
  await fsp.writeFile(bigHtml, '<!doctype html>' + 'x'.repeat(3 * MiB - 15));
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

test('maxVideoBytesFor agrees with the route rule', () => {
  for (const s of [1, 30, 31, 45, 60]) {
    expect(server.maxVideoBytesFor(s)).toBe(maxVideoBytes(s));
  }
  expect(server.maxVideoBytesFor(30)).toBe(2 * MiB);
  expect(server.maxVideoBytesFor(60)).toBe(4 * MiB);
});

test('missing or non-numeric lengthS keeps the 2 MiB cap', () => {
  expect(server.maxVideoBytesFor(undefined)).toBe(2 * MiB);
  expect(server.maxVideoBytesFor('60')).toBe(2 * MiB);
  expect(server.maxVideoBytesFor(NaN)).toBe(2 * MiB);
});

test('a 3 MiB file is read for lengthS 60', async () => {
  const r = await server.resolveHtmlArg({ htmlPath: bigHtml }, { maxBytes: server.maxVideoBytesFor(60), lengthS: 60 });
  expect(r.error).toBeUndefined();
  expect(r.html.length).toBe(3 * MiB);
});

test('the same file is refused for lengthS 30, naming the cap and lengthS', async () => {
  const r = await callTool('project_video_write', {
    videoId: 'v', title: 't', kind: 'feature', lengthS: 30, htmlPath: bigHtml, meta: {},
  });
  expect(r.isError).toBe(true);
  const text = r.content[0].text;
  expect(text).toContain(String(2 * MiB));
  expect(text).toContain('lengthS 30');
});

test('other tools keep the 2 MiB cap', async () => {
  const r = await callTool('project_page_write', { pageId: 'p', title: 't', htmlPath: bigHtml });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain(String(2 * MiB));
});

test('absolute-path and extension checks still refuse bad paths', async () => {
  const rel = await server.resolveHtmlArg({ htmlPath: 'video.html' }, { maxBytes: server.maxVideoBytesFor(60), lengthS: 60 });
  expect(rel.error).toMatch(/absolute path/);
  const txt = path.join(dir, 'video.txt');
  await fsp.writeFile(txt, 'x');
  const ext = await server.resolveHtmlArg({ htmlPath: txt }, { maxBytes: server.maxVideoBytesFor(60), lengthS: 60 });
  expect(ext.error).toMatch(/\.html or \.htm/);
  const viaTool = await callTool('project_video_write', {
    videoId: 'v', title: 't', kind: 'feature', lengthS: 60, htmlPath: 'video.html', meta: {},
  });
  expect(viaTool.isError).toBe(true);
  expect(viaTool.content[0].text).toMatch(/absolute path/);
});

// ───────────────────────── project_video_write mp4Path / posterPath

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 9)]);

async function writeTmp(name, buf) {
  const p = path.join(dir, name);
  await fsp.writeFile(p, buf);
  return p;
}

test('export caps agree with the route rule', () => {
  for (const s of [1, 30, 31, 60]) expect(server.maxExportMp4BytesFor(s)).toBe(maxExportMp4Bytes(s));
  expect(server.MAX_EXPORT_POSTER_BYTES).toBe(MAX_EXPORT_POSTER_BYTES);
});

test('mp4Path and posterPath are read and returned as exports base64', async () => {
  const mp4Path = await writeTmp('clip.mp4', MP4);
  const posterPath = await writeTmp('poster.png', PNG);
  const r = await server.resolveVideoExports({ mp4Path, posterPath, lengthS: 30 });
  expect(r.error).toBeUndefined();
  expect(Buffer.from(r.exports.mp4Base64, 'base64').equals(MP4)).toBe(true);
  expect(Buffer.from(r.exports.posterBase64, 'base64').equals(PNG)).toBe(true);
  expect(await server.resolveVideoExports({ lengthS: 30 })).toEqual({});
});

test('only one of mp4Path / posterPath is refused', async () => {
  const mp4Path = await writeTmp('one.mp4', MP4);
  const r = await server.resolveVideoExports({ mp4Path, lengthS: 30 });
  expect(r.error).toMatch(/both mp4Path and posterPath/);
});

test('a wrong extension or a relative path is refused, naming only the reason', async () => {
  const mp4Path = await writeTmp('ok.mp4', MP4);
  const posterPath = await writeTmp('ok.png', PNG);
  const movPath = await writeTmp('clip.mov', MP4);
  const jpgPath = await writeTmp('poster.jpg', PNG);
  expect((await server.resolveVideoExports({ mp4Path: movPath, posterPath, lengthS: 30 })).error).toBe('mp4Path must end in .mp4');
  expect((await server.resolveVideoExports({ mp4Path, posterPath: jpgPath, lengthS: 30 })).error).toBe('posterPath must end in .png');
  expect((await server.resolveVideoExports({ mp4Path: 'clip.mp4', posterPath, lengthS: 30 })).error).toMatch(/absolute path/);
  const viaTool = await callTool('project_video_write', {
    videoId: 'v', title: 't', kind: 'tiktok', lengthS: 30, html: '<p>x</p>', meta: {}, mp4Path: movPath, posterPath,
  });
  expect(viaTool.isError).toBe(true);
  expect(viaTool.content[0].text).toContain('mp4Path must end in .mp4');
  expect(viaTool.content[0].text).not.toContain('ftyp');
});

test('an over-cap file is refused: MP4 over 24 MiB for lengthS 30, poster over 4 MiB', async () => {
  const bigMp4 = path.join(dir, 'big.mp4');
  const fh = await fsp.open(bigMp4, 'w');
  await fh.truncate(24 * MiB + 1);
  await fh.close();
  const bigPng = path.join(dir, 'big.png');
  await fsp.writeFile(bigPng, Buffer.alloc(4 * MiB + 1));
  const posterPath = await writeTmp('small.png', PNG);
  const mp4Path = await writeTmp('small.mp4', MP4);
  const r1 = await server.resolveVideoExports({ mp4Path: bigMp4, posterPath, lengthS: 30 });
  expect(r1.error).toBe(`mp4Path file exceeds ${24 * MiB} bytes`);
  // the same MP4 fits the 48 MiB cap of a 60 s video
  expect((await server.resolveVideoExports({ mp4Path: bigMp4, posterPath, lengthS: 60 })).error).toBeUndefined();
  const r2 = await server.resolveVideoExports({ mp4Path, posterPath: bigPng, lengthS: 30 });
  expect(r2.error).toBe(`posterPath file exceeds ${4 * MiB} bytes`);
});

test('a directory named .mp4 is not a regular file', async () => {
  const d = path.join(dir, 'folder.mp4');
  await fsp.mkdir(d, { recursive: true });
  const posterPath = await writeTmp('p2.png', PNG);
  expect((await server.resolveVideoExports({ mp4Path: d, posterPath, lengthS: 30 })).error).toBe('mp4Path is not a regular file');
});

test('project_video_write lists tiktok and marketing in its kind enum and description, plus mp4Path / posterPath', () => {
  const tool = server.TOOLS.find((t) => t.name === 'project_video_write');
  expect(tool.inputSchema.properties.kind.enum).toEqual(expect.arrayContaining(['tiktok', 'marketing']));
  expect(tool.inputSchema.properties.kind.description).toMatch(/tiktok/);
  expect(tool.inputSchema.properties.kind.description).toMatch(/marketing/);
  expect(tool.description).toMatch(/'tiktok'/);
  expect(tool.description).toMatch(/'marketing'/);
  expect(tool.inputSchema.properties.mp4Path.type).toBe('string');
  expect(tool.inputSchema.properties.posterPath.type).toBe('string');
});
