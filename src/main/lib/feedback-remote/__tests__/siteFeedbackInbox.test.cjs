/**
 * siteFeedbackInbox.test.cjs — the single writer of feedback-inbox/: write, dedupe, list,
 * get, status/link, prune, hostId rejection, runtime .gitignore.
 *
 * Run: timeout 120 npx vitest run src/main/lib/feedback-remote/__tests__/siteFeedbackInbox.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const inbox = require('../siteFeedbackInbox.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTmpCwd() {
  const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-site-inbox-')));
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  return dir;
}

const ns = (cwd) => path.join(cwd, 'session-manager-operations', 'feedback-inbox');
const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
let seq = 0;

function report(over = {}) {
  seq += 1;
  return {
    schemaVersion: 1,
    clientReportId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    project: 'three-winds',
    type: 'bug',
    title: `Broken thing ${seq}`,
    details: 'it broke',
    user: { id: 'u1', name: 'Ann', email: 'ann@example.com' },
    ...over,
  };
}

function item(cwd, hostId, receivedAt, over = {}) {
  return {
    cwd, hostId, boxId: 'box_1', receivedAt, origin: 'https://example.com',
    report: report(over), screenshot: PNG_A, annotated: PNG_B,
  };
}

test('lib-layout lists siteFeedbackInbox under feedback-remote', () => {
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../scripts/lib-layout.json'), 'utf8'));
  expect(layout.siteFeedbackInbox).toBe('feedback-remote');
});

test('writeItem stores report, meta and both PNGs, and the namespace .gitignore', async () => {
  const cwd = await mkTmpCwd();
  const args = item(cwd, 'FB-AB123', '2026-11-20T10:00:00.000Z');
  expect(await inbox.writeItem(args)).toEqual({ duplicate: false, hostId: 'FB-AB123' });
  const dir = path.join(ns(cwd), 'items', 'FB-AB123');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))).toEqual(args.report);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))).toEqual({
    hostId: 'FB-AB123', boxId: 'box_1', receivedAt: '2026-11-20T10:00:00.000Z', origin: 'https://example.com',
    status: 'open', statusNote: null, epicId: null, statusChangedAt: '2026-11-20T10:00:00.000Z',
  });
  expect(fs.readFileSync(path.join(dir, 'screenshot.png')).equals(PNG_A)).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'annotated.png')).equals(PNG_B)).toBe(true);
  expect(fs.readFileSync(path.join(ns(cwd), '.gitignore'), 'utf8')).toBe('*\n');
});

test('writeItem is a no-op for an already stored clientReportId', async () => {
  const cwd = await mkTmpCwd();
  const first = item(cwd, 'FB-AAAAA', '2026-11-20T10:00:00.000Z');
  await inbox.writeItem(first);
  const again = { ...first, hostId: 'FB-BBBBB' };
  expect(await inbox.writeItem(again)).toEqual({ duplicate: true, hostId: 'FB-AAAAA' });
  expect(fs.existsSync(path.join(ns(cwd), 'items', 'FB-BBBBB'))).toBe(false);
  expect(await inbox.list(cwd)).toHaveLength(1);
});

test('list is newest first with summary, and filters by status', async () => {
  const cwd = await mkTmpCwd();
  await inbox.writeItem(item(cwd, 'FB-00001', '2026-11-20T10:00:00.000Z'));
  await inbox.writeItem(item(cwd, 'FB-00002', '2026-11-22T10:00:00.000Z', { type: 'feature', user: null }));
  await inbox.writeItem(item(cwd, 'FB-00003', '2026-11-21T10:00:00.000Z'));
  const all = await inbox.list(cwd);
  expect(all.map((i) => i.hostId)).toEqual(['FB-00002', 'FB-00003', 'FB-00001']);
  expect(all[0]).toMatchObject({ type: 'feature', reporter: null, status: 'open' });
  expect(all[1].reporter).toEqual({ id: 'u1', name: 'Ann', email: 'ann@example.com' });
  expect(typeof all[1].title).toBe('string');
  await inbox.setStatus(cwd, 'FB-00003', 'resolved');
  expect((await inbox.list(cwd, { status: 'resolved' })).map((i) => i.hostId)).toEqual(['FB-00003']);
  expect((await inbox.list(cwd, { status: 'open' })).map((i) => i.hostId)).toEqual(['FB-00002', 'FB-00001']);
  expect(await inbox.list(await mkTmpCwd())).toEqual([]);
});

test('get returns meta, report and image paths; null when absent', async () => {
  const cwd = await mkTmpCwd();
  const args = item(cwd, 'FB-GET01', '2026-11-20T10:00:00.000Z');
  await inbox.writeItem(args);
  const got = await inbox.get(cwd, 'FB-GET01');
  expect(got.meta.hostId).toBe('FB-GET01');
  expect(got.report).toEqual(args.report);
  const dir = path.join(ns(cwd), 'items', 'FB-GET01');
  expect(got.imagePaths).toEqual({ screenshot: path.join(dir, 'screenshot.png'), annotated: path.join(dir, 'annotated.png') });
  expect(await inbox.get(cwd, 'FB-NONE0')).toBeNull();
});

test('setStatus, linkEpic and remove', async () => {
  const cwd = await mkTmpCwd();
  await inbox.writeItem(item(cwd, 'FB-ST001', '2026-11-20T10:00:00.000Z'));
  const now = Date.parse('2026-11-23T00:00:00.000Z');
  await inbox.setStatus(cwd, 'FB-ST001', 'in_progress', 'looking', { now });
  let { meta } = await inbox.get(cwd, 'FB-ST001');
  expect(meta).toMatchObject({ status: 'in_progress', statusNote: 'looking', statusChangedAt: '2026-11-23T00:00:00.000Z' });
  await expect(inbox.setStatus(cwd, 'FB-ST001', /** @type {any} */ ('done'))).rejects.toThrow(/status/);
  await expect(inbox.setStatus(cwd, 'FB-ST001', 'open', 'x'.repeat(501))).rejects.toThrow(/note/);
  await inbox.setStatus(cwd, 'FB-ST001', 'open', 'x'.repeat(500));
  await inbox.linkEpic(cwd, 'FB-ST001', 'epic-123');
  ({ meta } = await inbox.get(cwd, 'FB-ST001'));
  expect(meta).toMatchObject({ epicId: 'epic-123', status: 'open' });
  await expect(inbox.setStatus(cwd, 'FB-NONE0', 'open')).rejects.toThrow(/no item/);
  expect(await inbox.remove(cwd, 'FB-ST001')).toEqual({ removed: true });
  expect(await inbox.get(cwd, 'FB-ST001')).toBeNull();
  expect(fs.existsSync(path.join(ns(cwd), 'items', 'FB-ST001'))).toBe(false);
});

test('prune deletes only resolved/wontfix items whose status changed more than days ago', async () => {
  const cwd = await mkTmpCwd();
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-11-23T00:00:00.000Z');
  for (const id of ['FB-OLDR1', 'FB-OLDW1', 'FB-NEWR1', 'FB-OLDO1']) {
    await inbox.writeItem(item(cwd, id, '2026-01-01T00:00:00.000Z'));
  }
  await inbox.setStatus(cwd, 'FB-OLDR1', 'resolved', null, { now: now - 40 * day });
  await inbox.setStatus(cwd, 'FB-OLDW1', 'wontfix', null, { now: now - 31 * day });
  await inbox.setStatus(cwd, 'FB-NEWR1', 'resolved', null, { now: now - 5 * day });
  await inbox.setStatus(cwd, 'FB-OLDO1', 'in_progress', null, { now: now - 90 * day });
  const pruned = await inbox.prune(cwd, 30, { now });
  expect(pruned.sort()).toEqual(['FB-OLDR1', 'FB-OLDW1']);
  expect((await inbox.list(cwd)).map((i) => i.hostId).sort()).toEqual(['FB-NEWR1', 'FB-OLDO1']);
});

test('bad hostIds are rejected everywhere and nothing is written', async () => {
  const cwd = await mkTmpCwd();
  for (const bad of ['fb-ab123', 'FB-AB12', 'FB-AB1234', '../FB-AB123', 'FB-AB12/', 'FB-ab123', '', null]) {
    await expect(inbox.writeItem(item(cwd, /** @type {any} */ (bad), '2026-11-20T10:00:00.000Z'))).rejects.toThrow(/hostId/);
    await expect(inbox.get(cwd, /** @type {any} */ (bad))).rejects.toThrow(/hostId/);
    await expect(inbox.setStatus(cwd, /** @type {any} */ (bad), 'open')).rejects.toThrow(/hostId/);
    await expect(inbox.linkEpic(cwd, /** @type {any} */ (bad), 'e1')).rejects.toThrow(/hostId/);
    await expect(inbox.remove(cwd, /** @type {any} */ (bad))).rejects.toThrow(/hostId/);
  }
  expect(fs.existsSync(ns(cwd))).toBe(false);
});

test('writeItem registers an unregistered project root itself (real config.cjs boundary)', async () => {
  // validatePath only admits paths under the home directory, so the fresh root lives there.
  const base = path.join(os.homedir(), '.cache');
  fs.mkdirSync(base, { recursive: true });
  const cwd = fs.realpathSync(await fsp.mkdtemp(path.join(base, 'sm-site-inbox-unreg-')));
  tmpDirs.push(cwd);
  expect(config.getAllowedRoots()).not.toContain(cwd);
  expect(await inbox.writeItem(item(cwd, 'FB-UNRG1', '2026-11-24T10:00:00.000Z')))
    .toEqual({ duplicate: false, hostId: 'FB-UNRG1' });
  expect(fs.existsSync(path.join(ns(cwd), 'items', 'FB-UNRG1', 'meta.json'))).toBe(true);
  await inbox.setStatus(cwd, 'FB-UNRG1', 'resolved');
  await inbox.appendRejected({ cwd, at: '2026-11-24T10:00:00.000Z', boxId: 'box_1', hostId: 'FB-X', code: 'bad_envelope', bytes: 3 });
  expect(fs.existsSync(path.join(ns(cwd), 'rejected.jsonl'))).toBe(true);
});

test('write paths refuse a relative or missing cwd', async () => {
  const missing = path.join(os.homedir(), '.cache', `sm-site-inbox-missing-${process.pid}-${Date.now()}`);
  for (const cwd of ['relative/project', missing]) {
    await expect(inbox.writeItem(item(cwd, 'FB-MISS1', '2026-11-24T10:00:00.000Z'))).rejects.toThrow(/cwd/);
    await expect(inbox.setStatus(cwd, 'FB-MISS1', 'open')).rejects.toThrow(/cwd/);
    await expect(inbox.linkEpic(cwd, 'FB-MISS1', 'e1')).rejects.toThrow(/cwd/);
    await expect(inbox.remove(cwd, 'FB-MISS1')).rejects.toThrow(/cwd/);
    await expect(inbox.prune(cwd, 30)).rejects.toThrow(/cwd/);
    await expect(inbox.appendRejected({ cwd, at: 'x', boxId: 'b', hostId: '', code: 'bad_envelope', bytes: 0 })).rejects.toThrow(/cwd/);
  }
  expect(fs.existsSync(missing)).toBe(false);
});
