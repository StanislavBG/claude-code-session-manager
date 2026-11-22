/**
 * needsYouStore.test.cjs — machine-level store of outside apps' "Needs you" items.
 *
 * Run: timeout 180 npx vitest run src/main/lib/feedback-remote/__tests__/needsYouStore.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp;
let prevHome;
let store;
let paths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-you-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = tmp;
  paths = require('../../scheduler/schedulerPaths.cjs');
  store = require('../needsYouStore.cjs');
});

afterEach(() => {
  vi.useRealTimers();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const base = (over = {}) => ({ app: 'portfolio', id: 'q-1', title: 'Pick a plan', ...over });
const readFile = () => JSON.parse(fs.readFileSync(paths.needsYouPath(), 'utf8'));

test('needsYouPath sits in schedulerHome', () => {
  expect(paths.needsYouPath()).toBe(path.join(tmp, 'needs-you.json'));
});

test('lib-layout lists needsYouStore under feedback-remote', () => {
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../scripts/lib-layout.json'), 'utf8'));
  expect(layout.needsYouStore).toBe('feedback-remote');
});

test('missing file reads as empty', async () => {
  expect(await store.listNeedsYou({})).toEqual([]);
});

test('corrupt file reads as empty and is set aside on next write', async () => {
  fs.writeFileSync(paths.needsYouPath(), '{not json');
  expect(await store.listNeedsYou({})).toEqual([]);
  fs.writeFileSync(paths.needsYouPath(), '[1,2]');
  expect(await store.listNeedsYou({})).toEqual([]);
  const { created } = await store.postNeedsYou(base());
  expect(created).toBe(true);
  expect(fs.readdirSync(tmp).some((f) => f.startsWith('needs-you.json.corrupt-'))).toBe(true);
  expect(readFile().items).toHaveLength(1);
});

test('invalid stored entries are dropped on read', async () => {
  fs.writeFileSync(paths.needsYouPath(), JSON.stringify({ version: 1, items: [{ app: 'x' }] }));
  expect(await store.listNeedsYou({})).toEqual([]);
});

test('post creates an open item with the full on-disk shape', async () => {
  const { item, created } = await store.postNeedsYou(base({
    why: 'Budget', link: 'https://example.com/q/1', options: ['A', 'B'], externalRef: 'ext:1',
  }));
  expect(created).toBe(true);
  expect(item).toMatchObject({
    app: 'portfolio', id: 'q-1', title: 'Pick a plan', why: 'Budget', link: 'https://example.com/q/1',
    options: ['A', 'B'], externalRef: 'ext:1', status: 'open', answer: null, answeredAt: null,
  });
  expect(typeof item.createdAt).toBe('string');
  expect(typeof item.updatedAt).toBe('string');
  const disk = readFile();
  expect(disk.version).toBe(1);
  expect(disk.items).toEqual([item]);
  expect(Object.keys(disk.items[0]).sort()).toEqual(
    ['answer', 'answeredAt', 'app', 'createdAt', 'externalRef', 'id', 'link', 'options', 'status', 'title', 'updatedAt', 'why'].sort(),
  );
});

test('post on an existing open item updates title, why, link, options', async () => {
  await store.postNeedsYou(base({ why: 'one', options: ['A', 'B'] }));
  const { item, created } = await store.postNeedsYou(base({ title: 'New title', why: 'two', link: 'http://x.y', options: ['C', 'D', 'E'] }));
  expect(created).toBe(false);
  expect(item).toMatchObject({ title: 'New title', why: 'two', link: 'http://x.y', options: ['C', 'D', 'E'], status: 'open' });
  expect(await store.listNeedsYou({})).toHaveLength(1);
});

test('post reports changed: true on create and on a real change, false on an identical re-post', async () => {
  const first = await store.postNeedsYou(base({ options: ['A', 'B'], externalRef: 'ext:1' }));
  expect(first).toMatchObject({ created: true, changed: true });
  const same = await store.postNeedsYou(base({ options: ['A', 'B'], externalRef: 'ext:1' }));
  expect(same).toMatchObject({ created: false, changed: false });
  expect(same.item.updatedAt).toBe(first.item.updatedAt);
  const diff = await store.postNeedsYou(base({ options: ['A', 'C'], externalRef: 'ext:1' }));
  expect(diff).toMatchObject({ created: false, changed: true });
});

test('a re-post replaces externalRef; absent clears it', async () => {
  await store.postNeedsYou(base({ externalRef: 'ext:1' }));
  const r = await store.postNeedsYou(base({ externalRef: 'ext:2' }));
  expect(r).toMatchObject({ changed: true, item: { externalRef: 'ext:2' } });
  expect(readFile().items[0].externalRef).toBe('ext:2');
  const cleared = await store.postNeedsYou(base());
  expect(cleared).toMatchObject({ changed: true, item: { externalRef: null } });
  expect(readFile().items[0].externalRef).toBeNull();
});

test('two identical posts issued together: exactly one reports changed', async () => {
  await store.postNeedsYou(base());
  const results = await Promise.all([
    store.postNeedsYou(base({ title: 'Together' })),
    store.postNeedsYou(base({ title: 'Together' })),
  ]);
  expect(results.filter((r) => r.changed)).toHaveLength(1);
});

test('post on an answered or withdrawn item changes nothing', async () => {
  await store.postNeedsYou(base({ options: ['A', 'B'] }));
  await store.answerNeedsYou({ app: 'portfolio', id: 'q-1', answer: 'A' });
  const r = await store.postNeedsYou(base({ title: 'Changed', options: ['X', 'Y'] }));
  expect(r.created).toBe(false);
  expect(r.changed).toBe(false);
  expect(r.item).toMatchObject({ title: 'Pick a plan', status: 'answered', answer: 'A' });

  await store.postNeedsYou(base({ id: 'q-2' }));
  await store.withdrawNeedsYou({ app: 'portfolio', id: 'q-2' });
  const w = await store.postNeedsYou(base({ id: 'q-2', title: 'Changed' }));
  expect(w.created).toBe(false);
  expect(w.item).toMatchObject({ title: 'Pick a plan', status: 'withdrawn' });
});

test('eleventh open item for one app is refused with NEEDS_YOU_LIMIT', async () => {
  for (let i = 0; i < 10; i++) await store.postNeedsYou(base({ id: `q-${i}` }));
  await expect(store.postNeedsYou(base({ id: 'q-10' }))).rejects.toMatchObject({ code: 'NEEDS_YOU_LIMIT' });
  // updating an existing open item is still allowed at the cap
  expect((await store.postNeedsYou(base({ id: 'q-3', title: 'Upd' }))).created).toBe(false);
  // another app is fine
  expect((await store.postNeedsYou(base({ app: 'kiln', id: 'q-1' }))).created).toBe(true);
  // withdrawing frees a slot
  await store.withdrawNeedsYou({ app: 'portfolio', id: 'q-0' });
  expect((await store.postNeedsYou(base({ id: 'q-10' }))).created).toBe(true);
});

test('fifty-first open item in total is refused with NEEDS_YOU_LIMIT', async () => {
  for (let a = 0; a < 5; a++) {
    for (let i = 0; i < 10; i++) await store.postNeedsYou(base({ app: `app${a}`, id: `q-${i}` }));
  }
  await expect(store.postNeedsYou(base({ app: 'app9', id: 'q-0' }))).rejects.toMatchObject({ code: 'NEEDS_YOU_LIMIT' });
  expect(await store.listNeedsYou({ status: 'open' })).toHaveLength(50);
});

test('concurrent posts are serialized', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.postNeedsYou(base({ id: `c-${i}` }))));
  expect(readFile().items).toHaveLength(8);
});

test.each([
  ['app empty', { app: '' }],
  ['app too long', { app: 'a'.repeat(41) }],
  ['app bad char', { app: 'my app' }],
  ['app slash', { app: 'a/b' }],
  ['id missing', { id: undefined }],
  ['id bad char', { id: 'has space' }],
  ['id too long', { id: 'a'.repeat(201) }],
  ['externalRef bad', { externalRef: 'bad ref' }],
  ['title empty', { title: '' }],
  ['title too long', { title: 'x'.repeat(201) }],
  ['title two lines', { title: 'a\nb' }],
  ['title carriage return', { title: 'a\rb' }],
  ['why too long', { why: 'x'.repeat(1001) }],
  ['link not http', { link: 'ftp://x.y' }],
  ['link javascript', { link: 'javascript:alert(1)' }],
  ['link too long', { link: `https://${'x'.repeat(1993)}` }],
  ['one option', { options: ['A'] }],
  ['six options', { options: ['A', 'B', 'C', 'D', 'E', 'F'] }],
  ['duplicate options', { options: ['A', 'A'] }],
  ['empty option', { options: ['A', ''] }],
  ['long option', { options: ['A', 'x'.repeat(81)] }],
])('invalid input throws: %s', async (_name, over) => {
  await expect(store.postNeedsYou(base(over))).rejects.toThrow();
  expect(() => store.NeedsYouPostSchema.parse(base(over))).toThrow();
});

test('boundary inputs are accepted', async () => {
  const r = await store.postNeedsYou({
    app: 'a.b_c-D9'.padEnd(40, 'x'),
    id: 'x'.repeat(200),
    title: 't'.repeat(200),
    why: 'w'.repeat(1000),
    link: `https://${'x'.repeat(1992)}`,
    options: ['1', '2', '3', '4', 'o'.repeat(80)],
    externalRef: 'ref:a/b@c',
  });
  expect(r.created).toBe(true);
});

test('answer sets answered on an open item with matching option', async () => {
  await store.postNeedsYou(base({ options: ['A', 'B'] }));
  const item = await store.answerNeedsYou({ app: 'portfolio', id: 'q-1', answer: 'B' });
  expect(item).toMatchObject({ status: 'answered', answer: 'B' });
  expect(typeof item.answeredAt).toBe('string');
  expect(await store.listNeedsYou({ status: 'answered' })).toHaveLength(1);
  // already answered → null
  expect(await store.answerNeedsYou({ app: 'portfolio', id: 'q-1', answer: 'A' })).toBeNull();
});

test('answer returns null for no options, value outside options, missing or non-open item', async () => {
  await store.postNeedsYou(base({ id: 'no-opts' }));
  expect(await store.answerNeedsYou({ app: 'portfolio', id: 'no-opts', answer: 'A' })).toBeNull();
  await store.postNeedsYou(base({ id: 'opts', options: ['A', 'B'] }));
  expect(await store.answerNeedsYou({ app: 'portfolio', id: 'opts', answer: 'C' })).toBeNull();
  expect(await store.answerNeedsYou({ app: 'portfolio', id: 'missing', answer: 'A' })).toBeNull();
  await store.withdrawNeedsYou({ app: 'portfolio', id: 'opts' });
  expect(await store.answerNeedsYou({ app: 'portfolio', id: 'opts', answer: 'A' })).toBeNull();
  expect((await store.listNeedsYou({ app: 'portfolio', id: 'no-opts' })).find((i) => i.id === 'no-opts').status).toBe('open');
});

test('withdraw sets withdrawn on an open item, else null', async () => {
  await store.postNeedsYou(base());
  const item = await store.withdrawNeedsYou({ app: 'portfolio', id: 'q-1' });
  expect(item).toMatchObject({ status: 'withdrawn' });
  expect(await store.withdrawNeedsYou({ app: 'portfolio', id: 'q-1' })).toBeNull();
  expect(await store.withdrawNeedsYou({ app: 'portfolio', id: 'nope' })).toBeNull();
});

test('list filters by app and status', async () => {
  await store.postNeedsYou(base({ id: 'a' }));
  await store.postNeedsYou(base({ id: 'b' }));
  await store.postNeedsYou(base({ app: 'kiln', id: 'a' }));
  await store.withdrawNeedsYou({ app: 'portfolio', id: 'b' });
  expect(await store.listNeedsYou({ app: 'portfolio' })).toHaveLength(2);
  expect(await store.listNeedsYou({ app: 'portfolio', status: 'open' })).toHaveLength(1);
  expect(await store.listNeedsYou({ status: 'withdrawn' })).toHaveLength(1);
  expect(await store.listNeedsYou()).toHaveLength(3);
});

test('closed items older than 14 days are dropped at the next write', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  await store.postNeedsYou(base({ id: 'ans', options: ['A', 'B'] }));
  await store.postNeedsYou(base({ id: 'wd' }));
  await store.postNeedsYou(base({ id: 'open' }));
  await store.answerNeedsYou({ app: 'portfolio', id: 'ans', answer: 'A' });
  await store.withdrawNeedsYou({ app: 'portfolio', id: 'wd' });

  vi.setSystemTime(new Date('2026-11-14T23:00:00Z'));
  await store.postNeedsYou(base({ id: 'fresh' }));
  expect(readFile().items.map((i) => i.id).sort()).toEqual(['ans', 'fresh', 'open', 'wd']);

  vi.setSystemTime(new Date('2026-11-15T00:00:01Z'));
  // a read alone does not drop
  expect(await store.listNeedsYou({})).toHaveLength(4);
  await store.postNeedsYou(base({ id: 'later' }));
  expect(readFile().items.map((i) => i.id).sort()).toEqual(['fresh', 'later', 'open']);
});
