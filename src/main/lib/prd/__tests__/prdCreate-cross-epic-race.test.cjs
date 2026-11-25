/**
 * prdCreate-cross-epic-race.test.cjs — createPrdBatch re-runs the cross-Epic
 * duplicate check on a FRESH listing inside a per-project create lock, right
 * before NN allocation (2026-11-24 Bilko: Epic B's batch validated against a
 * listing read before Epic A's batch wrote 2001, then wrote the duplicate 2005).
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdCreate-cross-epic-race.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd, createPrdBatch } = require('../prdCreate.cjs');

const EPIC_A = 'portfolio-and-kiln-owner-decisions-in-session-ma-f25f3d71';
const EPIC_B = 'portfolio-use-session-manager-s-outside-contract-a23ae9c4';
const SLUG = 'sync-drop-record-push';

let cwd;
let outDir;
let nextNn;
let rows;
let listCalls;
let allocations;
let remote;

const makeRemote = (o = {}) => ({
  async allocateParallelGroup(c) { allocations.push(c); return nextNn++; },
  async readPrd() { return { ok: false }; },
  async writePrd(slug, body, c) {
    if (o.beforeWrite) await o.beforeWrite(slug, c);
    const dir = o.outDirFor ? o.outDirFor(c) : outDir;
    const p = path.join(dir, `${slug}.md`);
    await fsp.writeFile(p, body);
    const epicId = (/^sourcePromptId: (.+)$/m.exec(body) || [])[1] ?? null;
    (o.rowsFor ? o.rowsFor(c) : rows).push({ slug, epicId, status: null });
    return { ok: true, path: p, epicId };
  },
  async listPrds(q) {
    listCalls.push(q);
    const list = o.rowsFor ? o.rowsFor(q.cwd) : rows;
    const snap = list.slice();
    if (q.fresh === true && o.freshOnly) snap.push(...o.freshOnly);
    return { prds: snap, total: snap.length, limit: snap.length, offset: 0, hasMore: false };
  },
});

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cross-epic-race-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 2001;
  rows = [];
  listCalls = [];
  allocations = [];
  remote = makeRemote();
});

const entry = (slug, o = {}) => ({
  title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const written = (dir = outDir) => fs.readdirSync(dir).sort();

test('a row Epic A writes after the batch validated is caught by the fresh commit-time re-check', async () => {
  // Epic A's row lands after every validation-time (non-fresh) listing snapshot:
  // only the commit-time fresh read can see it.
  remote = makeRemote({ freshOnly: [{ slug: `2001-${SLUG}`, epicId: EPIC_A, status: null }] });
  const r = await createPrdBatch([entry(SLUG)], remote, { cwd, sourcePromptId: EPIC_B });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].error).toContain(`2001-${SLUG}`);
  expect(r.errors[0].error).toContain(EPIC_A);
  expect(written()).toEqual([]);
  expect(allocations).toEqual([]);
  const fresh = listCalls.filter((q) => q.fresh === true);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ cwd, fields: 'full', limit: Number.MAX_SAFE_INTEGER, fresh: true });
});

test('two concurrent batches from two Epics with one bare slug: exactly one wins', async () => {
  const [a, b] = await Promise.all([
    createPrdBatch([entry(SLUG)], remote, { cwd, sourcePromptId: EPIC_A }),
    createPrdBatch([entry(SLUG)], remote, { cwd, sourcePromptId: EPIC_B }),
  ]);
  const results = [a, b];
  const ok = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  expect(ok).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0].status).toBe(409);
  const winner = `${ok[0].prds[0].nn}-${SLUG}`;
  expect(refused[0].errors[0].error).toContain(winner);
  expect(written()).toEqual([`${winner}.md`]);
  expect(allocations).toHaveLength(1);
});

test('the lock is per project: a second project\'s batch finishes while the first project\'s is held', async () => {
  const cwdY = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cross-epic-race-y-'));
  const outY = path.join(cwdY, 'out');
  await fsp.mkdir(outY, { recursive: true });
  config.addAllowedRoot(cwdY);
  const rowsY = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let xWriting;
  const xStarted = new Promise((resolve) => { xWriting = resolve; });
  remote = makeRemote({
    outDirFor: (c) => (c === cwdY ? outY : outDir),
    rowsFor: (c) => (c === cwdY ? rowsY : rows),
    async beforeWrite(_slug, c) {
      if (c === cwd) { xWriting(); await gate; }
    },
  });
  const order = [];
  const x = createPrdBatch([entry('x-work')], remote, { cwd, sourcePromptId: EPIC_A }).then((r) => { order.push('x'); return r; });
  await xStarted;
  const y = await createPrdBatch([entry('y-work')], remote, { cwd: cwdY, sourcePromptId: EPIC_B });
  order.push('y');
  expect(y.ok).toBe(true);
  expect(written(outY)).toEqual([`${y.prds[0].nn}-y-work.md`]);
  release();
  const xr = await x;
  expect(xr.ok).toBe(true);
  expect(order).toEqual(['y', 'x']);
});

test('a same-Epic row written since validation is refused 409 naming its NN slug', async () => {
  remote = makeRemote({ freshOnly: [{ slug: `2001-${SLUG}`, epicId: EPIC_B, status: null }] });
  const r = await createPrdBatch([entry(SLUG)], remote, { cwd, sourcePromptId: EPIC_B });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(r.errors[0].error).toBe(`slug "${SLUG}" already exists in this Epic as "2001-${SLUG}"`);
  expect(written()).toEqual([]);
  expect(allocations).toEqual([]);
});

// ---- single createPrd under the same per-project create lock ----

test('two concurrent createPrd calls from two Epics with one bare slug: exactly one wins, the other 409 names it', async () => {
  const [a, b] = await Promise.all([
    createPrd({ ...entry(SLUG), cwd, sourcePromptId: EPIC_A }, remote),
    createPrd({ ...entry(SLUG), cwd, sourcePromptId: EPIC_B }, remote),
  ]);
  const results = [a, b];
  const ok = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  expect(ok).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0].status).toBe(409);
  const winner = `${ok[0].nn}-${SLUG}`;
  expect(refused[0].error).toContain(winner);
  expect(written()).toEqual([`${winner}.md`]);
  expect(allocations).toHaveLength(1);
  // Each create's guard listing is the fresh in-lock read.
  expect(listCalls.filter((q) => q.fresh === true)).toHaveLength(2);
});

test('a createPrd racing a createPrdBatch with one bare slug from another Epic leaves exactly one file', async () => {
  const [a, b] = await Promise.all([
    createPrd({ ...entry(SLUG), cwd, sourcePromptId: EPIC_A }, remote),
    createPrdBatch([entry(SLUG)], remote, { cwd, sourcePromptId: EPIC_B }),
  ]);
  expect([a, b].filter((r) => r.ok)).toHaveLength(1);
  expect(written()).toHaveLength(1);
});

test('createPrd refuses a same-Epic row seen only on the fresh listing with the same-Epic 409 wording', async () => {
  remote = makeRemote({ freshOnly: [{ slug: `2001-${SLUG}`, epicId: EPIC_B, status: null }] });
  const r = await createPrd({ ...entry(SLUG), cwd, sourcePromptId: EPIC_B }, remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(r.error).toContain(`A PRD with slug "${SLUG}" already exists in this Epic as "2001-${SLUG}.md"`);
  expect(allocations).toEqual([]);
  expect(written()).toEqual([]);
});

test('the create lock is released after a writePrd throw and after an early return', async () => {
  let failNext = true;
  remote = makeRemote({
    async beforeWrite() { if (failNext) { failNext = false; throw new Error('disk gone'); } },
  });
  await expect(createPrd({ ...entry('first-work'), cwd, sourcePromptId: EPIC_A }, remote)).rejects.toThrow('disk gone');
  // early return inside the lock (cross-Epic 409)
  rows.push({ slug: `1999-dup-work`, epicId: EPIC_A, status: null });
  const refused = await createPrd({ ...entry('dup-work'), cwd, sourcePromptId: EPIC_B }, remote);
  expect(refused.status).toBe(409);
  const done = await Promise.race([
    createPrd({ ...entry('second-work'), cwd, sourcePromptId: EPIC_A }, remote),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);
  expect(done).not.toBe('timeout');
  expect(done.ok).toBe(true);
});

// ---- internalMint: the in-lock same-Epic re-check does not depend on optional fields ----

test('an internalMint createPrd with no files/dependsOn/fixes still refuses a fresh-only same-Epic row', async () => {
  remote = makeRemote({ freshOnly: [{ slug: `2001-${SLUG}`, epicId: EPIC_B, status: null }] });
  const r = await createPrd({ ...entry(SLUG), cwd, sourcePromptId: EPIC_B }, remote, { internalMint: true });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(r.error).toContain(`A PRD with slug "${SLUG}" already exists in this Epic as "2001-${SLUG}.md"`);
  expect(allocations).toEqual([]);
  expect(written()).toEqual([]);
  expect(listCalls.filter((q) => q.fresh === true)).toHaveLength(1);
});

test('an internalMint createPrd whose bare slug matches another Epic\'s row still succeeds', async () => {
  rows.push({ slug: `1999-${SLUG}`, epicId: EPIC_A, status: null });
  const r = await createPrd({ ...entry(SLUG), cwd, sourcePromptId: EPIC_B }, remote, { internalMint: true });
  expect(r.ok).toBe(true);
  expect(written()).toEqual([`${r.nn}-${SLUG}.md`]);
});
