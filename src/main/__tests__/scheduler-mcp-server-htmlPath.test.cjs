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
const { maxVideoBytes } = require('../lib/feedback-remote/projectHomeAdminRoutes.cjs');

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
