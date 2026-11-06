'use strict';

import { test, expect, describe } from 'vitest';
const { schemas, ENTRY_ID_RE } = require('../ipcSchemas.cjs');

const video = () => ({
  id: 'my-demo-1', title: 'Demo', kind: 'project-demo', style: 'clean', lengthS: 30,
  createdAt: '2026-11-05T10:00:00.000Z', character: null,
  sources: [{ claim: 'c', source: 's', ref: 'r' }],
  report: { lufs: -16, truePeakDb: null, speechS: 20, readingGrade: null, bytes: 1000,
    checks: [{ id: 'a', ok: true, detail: 'fine' }] },
  macroVersion: 1, seedVersion: 0, model: 'sonnet', effort: 'high',
});
const page = () => ({ id: 'p1', title: 'T', topic: 'x', createdAt: '2026-11-05T10:00:00.000Z', model: 'm' });

describe('projectVideoMeta', () => {
  const ok = (v) => schemas.projectVideoMeta.safeParse(v).success;
  test('accepts full valid', () => expect(ok(video())).toBe(true));
  test('rejects unknown key', () => expect(ok({ ...video(), extra: 1 })).toBe(false));
  test('rejects kind ad', () => expect(ok({ ...video(), kind: 'ad' })).toBe(false));
  test('rejects lengthS 61', () => expect(ok({ ...video(), lengthS: 61 })).toBe(false));
  test('rejects _character id', () => expect(ok({ ...video(), id: '_character' })).toBe(false));
  test('rejects id A B', () => expect(ok({ ...video(), id: 'A B' })).toBe(false));
  test('rejects 301-char claim', () => {
    const v = video(); v.sources[0].claim = 'x'.repeat(301); expect(ok(v)).toBe(false);
  });
  test('rejects check missing ok', () => {
    const v = video(); v.report.checks = [{ id: 'a', detail: 'd' }]; expect(ok(v)).toBe(false);
  });
});

describe('projectPageMeta', () => {
  const ok = (v) => schemas.projectPageMeta.safeParse(v).success;
  test('accepts full valid', () => expect(ok(page())).toBe(true));
  test('rejects unknown key', () => expect(ok({ ...page(), z: 1 })).toBe(false));
  test('rejects bad id', () => expect(ok({ ...page(), id: 'A B' })).toBe(false));
});

describe('admin write bodies', () => {
  test('page body', () => {
    expect(schemas.projectPageAdminWriteBody.safeParse({ pageId: 'p1', title: 'T', html: '<p/>' }).success).toBe(true);
  });
  test('video body: meta has no id/createdAt/bytes', () => {
    const { id, createdAt, ...m } = video();
    delete m.report.bytes;
    const body = { videoId: 'v1', title: 'T', kind: 'feature', lengthS: 30, html: '<p/>', meta: m };
    expect(schemas.projectVideoAdminWriteBody.safeParse(body).success).toBe(true);
    expect(schemas.projectVideoAdminWriteBody.safeParse({ ...body, meta: { ...m, id: 'x' } }).success).toBe(false);
  });
  test('ENTRY_ID_RE exported', () => expect(ENTRY_ID_RE.test('_character')).toBe(false));
});
