/**
 * ipcSchemas-project-video.test.cjs — saved-video kinds, TikTok post copy,
 * MP4 + poster exports, and the Demo Video reviewStage press flag.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/ipcSchemas-project-video.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');

const ok = (s, p) => s.safeParse(p).success;

const reportFields = { lufs: -16, truePeakDb: -1.5, speechS: 20, readingGrade: 6, checks: [{ id: 'lufs', ok: true, detail: 'ok' }] };

// A saved project-demo meta exactly as written before tiktok/marketing existed: no post, no aspect.
const legacyMeta = {
  id: 'demo-abc123',
  title: 'Session Manager in 30 seconds',
  kind: 'project-demo',
  style: 'clean',
  lengthS: 30,
  createdAt: '2026-11-01T10:00:00.000Z',
  character: null,
  sources: [{ claim: 'Runs PRDs', source: 'README.md', ref: 'L10' }],
  report: { ...reportFields, bytes: 12345 },
  macroVersion: 3,
  seedVersion: 1,
  model: 'claude-opus-5-5',
  effort: 'medium',
};

const { id: _id, createdAt: _c, ...metaRest } = legacyMeta;
const writeBody = (over = {}) => ({
  videoId: 'demo-abc123',
  title: 'Session Manager in 30 seconds',
  kind: 'project-demo',
  lengthS: 30,
  html: '<html></html>',
  meta: { ...metaRest, report: reportFields },
  ...over,
});

const caption = (n) => 'x'.repeat(n);

describe('projectVideoMeta', () => {
  test('a pre-change project-demo meta (no post, no aspect) still parses', () => {
    expect(schemas.projectVideoMeta.parse(legacyMeta)).toEqual(legacyMeta);
  });

  test('accepts exactly the six kinds', () => {
    for (const kind of ['project-demo', 'blog-post', 'feature', 'episode', 'tiktok', 'marketing']) {
      expect(ok(schemas.projectVideoMeta, { ...legacyMeta, kind })).toBe(true);
    }
    expect(ok(schemas.projectVideoMeta, { ...legacyMeta, kind: 'reel' })).toBe(false);
  });

  test('post: optional strict caption 1-150 + audience 1-200', () => {
    const post = { caption: caption(150), audience: caption(200) };
    expect(schemas.projectVideoMeta.parse({ ...legacyMeta, kind: 'tiktok', aspect: '9:16', post }).post).toEqual(post);
    expect(ok(schemas.projectVideoMeta, { ...legacyMeta, post: { ...post, caption: caption(151) } })).toBe(false);
    expect(ok(schemas.projectVideoMeta, { ...legacyMeta, post: { ...post, caption: '' } })).toBe(false);
    expect(ok(schemas.projectVideoMeta, { ...legacyMeta, post: { ...post, audience: caption(201) } })).toBe(false);
    expect(ok(schemas.projectVideoMeta, { ...legacyMeta, post: { ...post, audience: '' } })).toBe(false);
    expect(ok(schemas.projectVideoMeta, { ...legacyMeta, post: { ...post, hashtags: '#x' } })).toBe(false);
  });
});

describe('projectVideoAdminWriteBody', () => {
  test('a pre-change write body still parses', () => {
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody())).toBe(true);
  });

  test('both new kinds parse; an unknown kind fails', () => {
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ kind: 'tiktok' }))).toBe(true);
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ kind: 'marketing' }))).toBe(true);
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ kind: 'reel' }))).toBe(false);
  });

  test('meta inherits post (and its limits) from projectVideoMeta', () => {
    const post = { caption: 'Ship PRDs while you sleep', audience: 'solo devs' };
    const parsed = schemas.projectVideoAdminWriteBody.parse(writeBody({ kind: 'tiktok', meta: { ...metaRest, kind: 'tiktok', report: reportFields, post } }));
    expect(parsed.meta.post).toEqual(post);
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ meta: { ...metaRest, report: reportFields, post: { ...post, caption: caption(151) } } }))).toBe(false);
  });

  test('exports: optional strict top-level mp4Base64 + posterBase64', () => {
    const exportsObj = { mp4Base64: 'AAAA', posterBase64: 'BBBB' };
    expect(schemas.projectVideoAdminWriteBody.parse(writeBody({ exports: exportsObj })).exports).toEqual(exportsObj);
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ exports: { ...exportsObj, gifBase64: 'CCCC' } }))).toBe(false);
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ exports: { ...exportsObj, mp4Base64: '' } }))).toBe(false);
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ exports: { mp4Base64: 'AAAA' } }))).toBe(false);
    // exports belongs at the top level, never inside meta.
    expect(ok(schemas.projectVideoAdminWriteBody, writeBody({ meta: { ...metaRest, report: reportFields, exports: exportsObj } }))).toBe(false);
  });
});

describe('macrosDispatchJob reviewStage', () => {
  const good = { cwd: '/proj', macroId: 'demo-video', epicId: 'e1' };

  test('reviewStage true parses; a non-boolean fails', () => {
    expect(schemas.macrosDispatchJob.parse({ ...good, reviewStage: true }).reviewStage).toBe(true);
    expect(schemas.macrosDispatchJob.parse({ ...good, reviewStage: false }).reviewStage).toBe(false);
    expect(ok(schemas.macrosDispatchJob, { ...good, reviewStage: 'yes' })).toBe(false);
    expect('reviewStage' in schemas.macrosDispatchJob.parse(good)).toBe(false);
  });

  test('an unknown key never reaches the handler', () => {
    const parsed = schemas.macrosDispatchJob.parse({ ...good, reviewStage: true, review: { decision: 'approved' } });
    expect('review' in parsed).toBe(false);
  });
});

describe('macrosDispatchJob voiceId', () => {
  const good = { cwd: '/proj', macroId: 'tool-narrated', epicId: 'e1' };

  test('a voice library id parses; omitted stays absent', () => {
    expect(schemas.macrosDispatchJob.parse({ ...good, voiceId: 'am_michael' }).voiceId).toBe('am_michael');
    expect(schemas.macrosDispatchJob.parse({ ...good, voiceId: 'narrator-2' }).voiceId).toBe('narrator-2');
    expect('voiceId' in schemas.macrosDispatchJob.parse(good)).toBe(false);
  });

  test('a malformed voiceId fails', () => {
    for (const voiceId of ['', 'Bad', '-x', 'a b', '../x', 'x'.repeat(65), 7, null]) {
      expect(ok(schemas.macrosDispatchJob, { ...good, voiceId })).toBe(false);
    }
  });
});
