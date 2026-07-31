/**
 * prdSourcePromptIdBackfill.test.cjs — PRD 830: a PRD file's location under
 * `.../scheduler/epics/<epicId>/prds/<slug>.md` already IS its Epic
 * membership, so ingest should stamp `sourcePromptId = <epicId>` whenever
 * frontmatter doesn't supply one — instead of leaving it null forever.
 *
 * Covers:
 *   - deriveEpicIdFromPrdPath: pure path-shape extraction (prdLocations.cjs)
 *   - parsePrdRaw: dir-derived stamping + frontmatter-wins precedence
 *   - reconcileSourcePromptId: pending-only backfill (scheduler.cjs)
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdSourcePromptIdBackfill.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { deriveEpicIdFromPrdPath, resolveEpicPrdWriteDir } = require('../lib/prdLocations.cjs');
const { parsePrdRaw, _resetCache } = require('../scheduler/prdParser.cjs');
const { reconcileSourcePromptId } = require('../scheduler.cjs');

async function mkProjectCwd() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-backfill-'));
}

// ---------- deriveEpicIdFromPrdPath ----------

test('deriveEpicIdFromPrdPath extracts the epic id from a well-formed epic PRD path', async () => {
  const cwd = await mkProjectCwd();
  const epicId = 'some-epic-abc123';
  const dir = resolveEpicPrdWriteDir(cwd, epicId);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, '900-example.md');
  expect(deriveEpicIdFromPrdPath(filePath)).toBe(epicId);
});

test('deriveEpicIdFromPrdPath returns null for the retired flat prds/ layout', () => {
  const filePath = '/home/user/Projects/foo/session-manager-operations/scheduler/prds/900-example.md';
  expect(deriveEpicIdFromPrdPath(filePath)).toBe(null);
});

test('deriveEpicIdFromPrdPath returns null for an unrelated path', () => {
  expect(deriveEpicIdFromPrdPath('/tmp/whatever/900-example.md')).toBe(null);
  expect(deriveEpicIdFromPrdPath(null)).toBe(null);
});

// ---------- parsePrdRaw: dir-derived stamping + frontmatter-wins ----------

test('parsePrdRaw derives sourcePromptId from the parent epic dir when frontmatter omits it', async () => {
  _resetCache();
  const cwd = await mkProjectCwd();
  const epicId = 'derive-me-epic-def456';
  const dir = resolveEpicPrdWriteDir(cwd, epicId);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, '901-hand-authored.md');
  await fsp.writeFile(filePath, [
    '---',
    'title: Hand-authored, no sourcePromptId',
    `cwd: ${cwd}`,
    '---',
    '# Goal',
    '',
    'Do the thing.',
    '',
  ].join('\n'));

  const parsed = await parsePrdRaw(filePath);
  expect(parsed.sourcePromptId).toBe(epicId);
});

test('parsePrdRaw: explicit frontmatter sourcePromptId wins over the dir-derived epic id', async () => {
  _resetCache();
  const cwd = await mkProjectCwd();
  const epicId = 'dir-epic-ghi789';
  const dir = resolveEpicPrdWriteDir(cwd, epicId);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, '902-explicit.md');
  await fsp.writeFile(filePath, [
    '---',
    'title: Explicit sourcePromptId',
    `cwd: ${cwd}`,
    'sourcePromptId: ticket-explicit-999',
    '---',
    '# Goal',
    '',
    'Do the thing.',
    '',
  ].join('\n'));

  const parsed = await parsePrdRaw(filePath);
  expect(parsed.sourcePromptId).toBe('ticket-explicit-999');
});

// ---------- reconcileSourcePromptId: pending-only backfill ----------

test('reconcileSourcePromptId backfills a pending job whose sourcePromptId is null', () => {
  const job = { slug: 'x', status: 'pending', sourcePromptId: null };
  expect(reconcileSourcePromptId(job, 'epic-abc')).toBe('epic-abc');
});

test('reconcileSourcePromptId leaves a running job untouched even if its sourcePromptId is null', () => {
  const job = { slug: 'x', status: 'running', sourcePromptId: null };
  expect(reconcileSourcePromptId(job, 'epic-abc')).toBe(null);
});

test('reconcileSourcePromptId leaves a completed job untouched even if its sourcePromptId is null', () => {
  const job = { slug: 'x', status: 'completed', sourcePromptId: null };
  expect(reconcileSourcePromptId(job, 'epic-abc')).toBe(null);
});

test('reconcileSourcePromptId keeps a pending job\'s existing value if the fresh parse yields null', () => {
  const job = { slug: 'x', status: 'pending', sourcePromptId: 'already-set' };
  expect(reconcileSourcePromptId(job, null)).toBe('already-set');
});
