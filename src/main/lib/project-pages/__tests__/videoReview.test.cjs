/**
 * videoReview.test.cjs — the review step store: dispatch / material / decision
 * records under videos/<id>/review/ and the pure status derived from them.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/videoReview.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  REVIEW_MATERIAL_REL, REVIEW_TEXT_MAX,
  recordDispatch, writeMaterial, writeDecision, readReview, listReviews, reviewStatus,
} = require('../videoReview.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTmpCwd() {
  const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-video-review-')));
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

const reviewDir = (cwd, id) => path.join(cwd, 'session-manager-operations', 'project-pages', 'videos', id, 'review');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
const DISPATCH = { macroId: 'm1', epicId: 'e1', slug: 'ep-1', stage: 'draft', inputValues: { a: '1' }, extraInstructions: '' };

async function withMaterial(cwd, id = 'vid-1') {
  expect((await recordDispatch(cwd, id, DISPATCH)).ok).toBe(true);
  expect((await writeMaterial(cwd, id, { text: 'script', images: [{ bytes: PNG }] })).ok).toBe(true);
}

test('constants', () => {
  expect(REVIEW_MATERIAL_REL).toBe('session-manager-operations/project-pages/videos/{id}/review/material.json');
  expect(REVIEW_TEXT_MAX).toBe(32000);
});

test('recordDispatch writes dispatch.json and status is building', async () => {
  const cwd = await mkTmpCwd();
  const r = await recordDispatch(cwd, 'vid-1', DISPATCH);
  expect(r.ok).toBe(true);
  expect(r.path).toBe(path.join(reviewDir(cwd, 'vid-1'), 'dispatch.json'));
  const rev = await readReview(cwd, 'vid-1');
  expect(rev.dispatch).toMatchObject({ macroId: 'm1', epicId: 'e1', slug: 'ep-1', stage: 'draft', inputValues: { a: '1' } });
  expect(rev.status).toBe('building');
  expect(rev.material).toBeNull();
  expect(rev.decision).toBeNull();
});

test('writeMaterial refused when no dispatch.json', async () => {
  const cwd = await mkTmpCwd();
  const r = await writeMaterial(cwd, 'vid-1', { text: 'x', images: [{ bytes: PNG }] });
  expect(r).toEqual({ ok: false, error: expect.stringMatching(/no dispatch/) });
  expect(fs.existsSync(reviewDir(cwd, 'vid-1'))).toBe(false);
});

test('traversal-looking entryId refused everywhere', async () => {
  const cwd = await mkTmpCwd();
  for (const id of ['../evil', 'a/b', '..', 'Vid', '']) {
    expect((await recordDispatch(cwd, id, DISPATCH)).ok).toBe(false);
    expect((await writeMaterial(cwd, id, { text: 'x', images: [{ bytes: PNG }] })).ok).toBe(false);
    expect((await writeDecision(cwd, id, { decision: 'approve', at: 'now' })).ok).toBe(false);
    expect(await readReview(cwd, id)).toBeNull();
  }
  expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'project-pages'))).toBe(false);
});

test('image validation: bad magic bytes, 7 images, 2 MiB + 1 byte', async () => {
  const cwd = await mkTmpCwd();
  await recordDispatch(cwd, 'vid-1', DISPATCH);
  const bad = await writeMaterial(cwd, 'vid-1', { text: 'x', images: [{ bytes: Buffer.from('GIF89a-not-allowed') }] });
  expect(bad).toEqual({ ok: false, error: expect.stringMatching(/PNG, JPEG or WebP/) });
  const seven = await writeMaterial(cwd, 'vid-1', { text: 'x', images: Array.from({ length: 7 }, () => ({ bytes: PNG })) });
  expect(seven).toEqual({ ok: false, error: expect.stringMatching(/1-6/) });
  const none = await writeMaterial(cwd, 'vid-1', { text: 'x', images: [] });
  expect(none.ok).toBe(false);
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1 - PNG.length)]);
  expect(big.length).toBe(2 * 1024 * 1024 + 1);
  expect((await writeMaterial(cwd, 'vid-1', { text: 'x', images: [{ bytes: big }] })).error).toMatch(/2 MiB/);
  const exact = big.subarray(0, 2 * 1024 * 1024);
  expect((await writeMaterial(cwd, 'vid-1', { text: 'x', images: [{ bytes: exact }] })).ok).toBe(true);
});

test('text: 32000 chars saved, 32001 refused, empty refused', async () => {
  const cwd = await mkTmpCwd();
  await recordDispatch(cwd, 'vid-1', DISPATCH);
  const ok = await writeMaterial(cwd, 'vid-1', { text: 'a'.repeat(32000), images: [{ bytes: PNG }] });
  expect(ok.ok).toBe(true);
  expect((await readReview(cwd, 'vid-1')).material.text.length).toBe(32000);
  const over = await writeMaterial(cwd, 'vid-1', { text: 'a'.repeat(32001), images: [{ bytes: PNG }] });
  expect(over).toEqual({ ok: false, error: expect.stringMatching(/32000/) });
  expect((await writeMaterial(cwd, 'vid-1', { text: '', images: [{ bytes: PNG }] })).ok).toBe(false);
});

test('writeMaterial names images by index, replaces previous set, absolute paths read back', async () => {
  const cwd = await mkTmpCwd();
  await recordDispatch(cwd, 'vid-1', DISPATCH);
  const first = await writeMaterial(cwd, 'vid-1', {
    text: 'one',
    images: [{ bytes: PNG, name: '../../x.png' }, { bytes: JPG }, { bytes: WEBP }],
  });
  expect(first.ok).toBe(true);
  const dir = reviewDir(cwd, 'vid-1');
  expect(fs.readdirSync(dir).sort()).toEqual(['dispatch.json', 'image-1.png', 'image-2.jpg', 'image-3.webp', 'material.json']);
  expect(first.material.savedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  const second = await writeMaterial(cwd, 'vid-1', { text: 'two', images: [{ bytes: JPG }] });
  expect(second.ok).toBe(true);
  expect(fs.readdirSync(dir).sort()).toEqual(['dispatch.json', 'image-1.jpg', 'material.json']);
  expect(fs.readFileSync(path.join(dir, 'image-1.jpg')).equals(JPG)).toBe(true);
  const rev = await readReview(cwd, 'vid-1');
  expect(rev.material.text).toBe('two');
  expect(rev.material.images).toEqual([{ name: 'image-1.jpg', path: path.join(dir, 'image-1.jpg') }]);
  expect(path.isAbsolute(rev.material.images[0].path)).toBe(true);
  expect(rev.status).toBe('waiting');
});

test('writeDecision refused without material', async () => {
  const cwd = await mkTmpCwd();
  await recordDispatch(cwd, 'vid-1', DISPATCH);
  expect(await writeDecision(cwd, 'vid-1', { decision: 'approve', at: '2026-11-22 13:05 PST' }))
    .toEqual({ ok: false, error: expect.stringMatching(/no material/) });
});

test('second decision on the same material refused: already decided', async () => {
  const cwd = await mkTmpCwd();
  await withMaterial(cwd);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'changes', note: 'fix intro' })).ok).toBe(true);
  expect(await writeDecision(cwd, 'vid-1', { decision: 'approve', at: 'x' }))
    .toEqual({ ok: false, error: 'already decided' });
  // New material re-opens the decision.
  await writeMaterial(cwd, 'vid-1', { text: 'v2', images: [{ bytes: PNG }] });
  expect((await writeDecision(cwd, 'vid-1', { decision: 'approve', at: 'x' })).ok).toBe(true);
});

test("'changes' needs a 1-2000 char note; newlines collapse to spaces", async () => {
  const cwd = await mkTmpCwd();
  await withMaterial(cwd);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'changes' })).ok).toBe(false);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'changes', note: '   \n ' })).ok).toBe(false);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'changes', note: 'a'.repeat(2001) })).ok).toBe(false);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'nope', note: 'x' })).ok).toBe(false);
  const r = await writeDecision(cwd, 'vid-1', { decision: 'changes', note: 'line one\nline two\r\n  three' });
  expect(r.ok).toBe(true);
  const rev = await readReview(cwd, 'vid-1');
  expect(rev.decision.note).toBe('line one line two three');
  expect(rev.decision.decidedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(rev.status).toBe('changes-requested');
});

test("'approve' without at refused; its at is read back", async () => {
  const cwd = await mkTmpCwd();
  await withMaterial(cwd);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'approve' })).ok).toBe(false);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'approve', at: '' })).ok).toBe(false);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'approve', at: 'a'.repeat(41) })).ok).toBe(false);
  expect((await writeDecision(cwd, 'vid-1', { decision: 'approve', at: 'two\nlines' })).ok).toBe(false);
  const r = await writeDecision(cwd, 'vid-1', { decision: 'approve', at: '2026-11-22 13:05 PST', decidedAt: 'ignored' });
  expect(r.ok).toBe(true);
  const rev = await readReview(cwd, 'vid-1');
  expect(rev.decision.at).toBe('2026-11-22 13:05 PST');
  expect(rev.decision.decidedAt).not.toBe('ignored');
  expect(rev.status).toBe('approved');
});

test("a 'final' dispatch recorded after approve keeps status 'approved'", async () => {
  const cwd = await mkTmpCwd();
  await withMaterial(cwd);
  await writeDecision(cwd, 'vid-1', { decision: 'approve', at: '2026-11-22 13:05 PST' });
  expect((await recordDispatch(cwd, 'vid-1', { ...DISPATCH, stage: 'final' })).ok).toBe(true);
  const rev = await readReview(cwd, 'vid-1');
  expect(rev.dispatch.stage).toBe('final');
  expect(rev.status).toBe('approved');
  expect(rev.decision.at).toBe('2026-11-22 13:05 PST');
});

test('a non-final re-dispatch after changes-requested goes back to building', async () => {
  const cwd = await mkTmpCwd();
  await withMaterial(cwd);
  await writeDecision(cwd, 'vid-1', { decision: 'changes', note: 'redo' });
  await recordDispatch(cwd, 'vid-1', DISPATCH);
  expect((await readReview(cwd, 'vid-1')).status).toBe('building');
});

test('reviewStatus: every status, purely', () => {
  const d = (t, stage = 'draft') => ({ dispatchedAt: t, stage });
  const m = (t) => ({ savedAt: t });
  const x = (t, decision) => ({ decidedAt: t, decision });
  const T1 = '2026-11-22T10:00:00.000Z';
  const T2 = '2026-11-22T11:00:00.000Z';
  const T3 = '2026-11-22T12:00:00.000Z';
  const T4 = '2026-11-22T13:00:00.000Z';
  expect(reviewStatus({})).toBeNull();
  expect(reviewStatus(null)).toBeNull();
  expect(reviewStatus({ dispatch: d(T1) })).toBe('building');
  expect(reviewStatus({ dispatch: d(T1), material: m(T2) })).toBe('waiting');
  expect(reviewStatus({ dispatch: d(T3), material: m(T2) })).toBe('building');
  expect(reviewStatus({ dispatch: d(T1), material: m(T2), decision: x(T3, 'approve') })).toBe('approved');
  expect(reviewStatus({ dispatch: d(T1), material: m(T2), decision: x(T3, 'changes') })).toBe('changes-requested');
  expect(reviewStatus({ dispatch: d(T4), material: m(T2), decision: x(T3, 'changes') })).toBe('building');
  expect(reviewStatus({ dispatch: d(T4, 'final'), material: m(T2), decision: x(T3, 'approve') })).toBe('approved');
  expect(reviewStatus({ dispatch: d(T1, 'final') })).toBe('building');
  expect(reviewStatus({ dispatch: d(T1), material: m(T4), decision: x(T3, 'approve') })).toBe('waiting');
});

test('listReviews returns every entry with a review folder, newest first', async () => {
  const cwd = await mkTmpCwd();
  expect(await listReviews(cwd)).toEqual([]);
  await recordDispatch(cwd, 'vid-a', DISPATCH);
  await recordDispatch(cwd, 'vid-b', DISPATCH);
  fs.mkdirSync(path.join(cwd, 'session-manager-operations', 'project-pages', 'videos', 'no-review'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'session-manager-operations', 'project-pages', 'videos', '_character'), { recursive: true });
  await writeMaterial(cwd, 'vid-a', { text: 'x', images: [{ bytes: PNG }] });
  const list = await listReviews(cwd);
  expect(list.map((r) => r.entryId)).toEqual(['vid-a', 'vid-b']);
  expect(list.map((r) => r.status)).toEqual(['waiting', 'building']);
});
