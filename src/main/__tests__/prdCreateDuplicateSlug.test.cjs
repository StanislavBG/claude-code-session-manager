/**
 * prdCreateDuplicateSlug.test.cjs — createPrd() refuses a slug whose bare name already exists
 * in the same Epic's prds/ or prds-archived/ (2110/2111 phone-drop-summary-state incident).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreateDuplicateSlug.test.cjs
 */

'use strict';

import { test, expect, beforeEach, vi } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { createPrd } = require('../lib/prd/prdCreate.cjs');
const { resolveEpicPrdWriteDir } = require('../lib/prd/prdLocations.cjs');

let cwd;
let alloc;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-dup-slug-'));
  config.addAllowedRoot(cwd);
  alloc = vi.fn(async () => 7);
  remote = {
    allocateParallelGroup: alloc,
    async readPrd() { return { ok: false }; },
    async writePrd() { return { ok: true }; },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
  };
});

async function seed(epicId, sub, file, title = 'seed') {
  const prds = resolveEpicPrdWriteDir(cwd, epicId);
  const dir = sub === 'prds' ? prds : path.join(path.dirname(prds), sub);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, file), `---\ntitle: ${title}\n---\n`);
}

const body = (o = {}) => ({
  title: 'Phone drop', slug: 'phone-drop-summary-state', cwd, sourcePromptId: 'epic-a',
  estimateMinutes: 10, goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});

test('same slug in the Epic prds/ → 409 and no NN allocated', async () => {
  await seed('epic-a', 'prds', '2110-phone-drop-summary-state.md');
  const r = await createPrd(body(), remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(r.error).toContain('2110-phone-drop-summary-state.md');
  expect(alloc).not.toHaveBeenCalled();
});

test('same slug only in prds-archived/ → 409', async () => {
  await seed('epic-a', 'prds-archived', '2110-phone-drop-summary-state.md');
  const r = await createPrd(body(), remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(alloc).not.toHaveBeenCalled();
});

test('same slug in a different Epic is allowed', async () => {
  await seed('epic-b', 'prds-archived', '2110-phone-drop-summary-state.md');
  const r = await createPrd(body(), remote);
  expect(r.status).not.toBe(409);
  expect(alloc).toHaveBeenCalled();
});

test('a distinct slug is allowed', async () => {
  await seed('epic-a', 'prds', '2110-phone-drop-summary-state.md');
  const r = await createPrd(body({ slug: 'something-else' }), remote);
  expect(r.status).not.toBe(409);
  expect(alloc).toHaveBeenCalled();
});

test('same title in prds/ → ok alreadyExisted, nothing written', async () => {
  await seed('epic-a', 'prds', '2110-phone-drop-summary-state.md', 'Phone drop');
  const writePrd = vi.fn(async () => ({ ok: true }));
  const r = await createPrd(body(), { ...remote, writePrd });
  expect(r.ok).toBe(true);
  expect(r.alreadyExisted).toBe(true);
  expect(r.filename).toBe('2110-phone-drop-summary-state.md');
  expect(r.nn).toBe(2110);
  expect(alloc).not.toHaveBeenCalled();
  expect(writePrd).not.toHaveBeenCalled();
});

test('same title in prds-archived/ → ok alreadyExisted', async () => {
  await seed('epic-a', 'prds-archived', '2110-phone-drop-summary-state.md', 'Phone drop');
  const r = await createPrd(body(), remote);
  expect(r.ok).toBe(true);
  expect(r.alreadyExisted).toBe(true);
  expect(alloc).not.toHaveBeenCalled();
});

test('different title still 409', async () => {
  await seed('epic-a', 'prds', '2110-phone-drop-summary-state.md', 'Other title');
  const r = await createPrd(body(), remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(r.error).toContain('already exists');
});

test('concurrent create for same slug → second gets in-progress 409', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const blocked = { ...remote, allocateParallelGroup: vi.fn(async () => { await gate; return 7; }) };
  const first = createPrd(body(), blocked);
  await new Promise((r) => setTimeout(r, 50));
  const second = await createPrd(body(), blocked);
  expect(second.ok).toBe(false);
  expect(second.status).toBe(409);
  expect(second.error).toContain('still in progress');
  release();
  await first;
  const third = await createPrd(body({ slug: 'phone-drop-summary-state' }), remote);
  expect(third.error ?? '').not.toContain('still in progress');
});
