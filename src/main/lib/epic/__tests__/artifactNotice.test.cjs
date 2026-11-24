/**
 * artifactNotice.test.cjs — postArtifactReadyNotice appends ONE 'artifact-ready'
 * response event per publish/ingest batch: one entry, several, >20 (moreCount),
 * empty (no append), missing epicId (no append), throwing append (logged, not thrown).
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/artifactNotice.test.cjs
 */
'use strict';

import { test, expect, vi, afterEach } from 'vitest';
const path = require('node:path');
const { postArtifactReadyNotice, MAX_ROWS } = require('../artifactNotice.cjs');

const CWD = path.resolve('/tmp/proj-notice');
const EPIC = 'epic-n1';
const STORE = path.join(CWD, 'session-manager-operations', 'artifacts', EPIC);

function item(i, extra = {}) {
  const name = `file-${i}.png`;
  return {
    storedPath: path.join(STORE, name),
    entry: { name, title: `File ${i}`, kind: 'image', size: 100 + i, sha256: 'x', ...extra },
  };
}

function recorder() {
  const calls = [];
  const append = vi.fn(async (...args) => { calls.push(args); return { ok: true }; });
  return { calls, append };
}

afterEach(() => vi.restoreAllMocks());

test('one entry → "Artifact ready: <title>" with one row, path relative to project root', async () => {
  const { calls, append } = recorder();
  const res = await postArtifactReadyNotice({ cwd: CWD, epicId: EPIC, entries: [item(1)], append });
  expect(res).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  const [cwd, epicId, text, meta] = calls[0];
  expect(cwd).toBe(CWD);
  expect(epicId).toBe(EPIC);
  expect(text).toBe('Artifact ready: File 1');
  expect(meta.notice).toBe('artifact-ready');
  expect(meta.artifacts).toEqual([
    { title: 'File 1', kind: 'image', path: `session-manager-operations/artifacts/${EPIC}/file-1.png`, size: 101 },
  ]);
  expect(meta.moreCount).toBeUndefined();
});

test('several entries → "<n> artifacts ready" with every row, one append', async () => {
  const { calls, append } = recorder();
  await postArtifactReadyNotice({ cwd: CWD, epicId: EPIC, entries: [item(1), item(2), item(3)], append });
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toBe('3 artifacts ready');
  expect(calls[0][3].artifacts.map((a) => a.title)).toEqual(['File 1', 'File 2', 'File 3']);
  expect(calls[0][3].moreCount).toBeUndefined();
});

test('more than 20 entries → 20 rows plus moreCount', async () => {
  const { calls, append } = recorder();
  const entries = Array.from({ length: 25 }, (_, i) => item(i));
  await postArtifactReadyNotice({ cwd: CWD, epicId: EPIC, entries, append });
  expect(MAX_ROWS).toBe(20);
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toBe('25 artifacts ready');
  expect(calls[0][3].artifacts).toHaveLength(20);
  expect(calls[0][3].moreCount).toBe(5);
});

test('empty entries or a missing epicId post nothing', async () => {
  const { append } = recorder();
  expect((await postArtifactReadyNotice({ cwd: CWD, epicId: EPIC, entries: [], append })).ok).toBe(false);
  expect((await postArtifactReadyNotice({ cwd: CWD, epicId: EPIC, append })).ok).toBe(false);
  expect((await postArtifactReadyNotice({ cwd: CWD, epicId: '', entries: [item(1)], append })).ok).toBe(false);
  expect((await postArtifactReadyNotice({ cwd: CWD, entries: [item(1)], append })).ok).toBe(false);
  expect(append).not.toHaveBeenCalled();
});

test('a throwing append is logged, never thrown', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const append = vi.fn(async () => { throw new Error('disk full'); });
  const res = await postArtifactReadyNotice({ cwd: CWD, epicId: EPIC, entries: [item(1)], append });
  expect(res.ok).toBe(false);
  expect(append).toHaveBeenCalledTimes(1);
  expect(err).toHaveBeenCalled();
  expect(String(err.mock.calls[0].join(' '))).toMatch(/disk full/);
});

test('a refused append (ok:false) is logged with its reason', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const append = vi.fn(async () => ({ ok: false, reason: 'not-active' }));
  const res = await postArtifactReadyNotice({ cwd: CWD, epicId: EPIC, entries: [item(1)], append });
  expect(res).toEqual({ ok: false, reason: 'not-active' });
  expect(String(warn.mock.calls[0].join(' '))).toMatch(/not-active/);
});
