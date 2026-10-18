/**
 * prdParserReservedPrune.test.cjs — pruneStaleReservations bounds the
 * `.reserved-NN` marker pile without ever letting NN allocation regress.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/prdParserReservedPrune.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { allocateParallelGroup, pruneStaleReservations, _resetCache } = require('../scheduler/prdParser.cjs');

const OLD = new Date(Date.now() - 2 * 3600 * 1000);

async function seed(count) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-prune-'));
  for (let i = 1; i <= count; i += 1) {
    const f = path.join(dir, `.reserved-${i}`);
    await fsp.writeFile(f, '');
    await fsp.utimes(f, OLD, OLD);
  }
  return dir;
}

test('300 old markers -> newest 100 kept', async () => {
  const dir = await seed(300);
  const res = await pruneStaleReservations(dir);
  expect(res).toEqual({ removed: 200, kept: 100 });
  const left = (await fsp.readdir(dir)).filter((n) => n.startsWith('.reserved-'));
  expect(left).toHaveLength(100);
  expect(left).toContain('.reserved-300');
  expect(left).not.toContain('.reserved-200');
});

test('a fresh (<1h) low marker is kept', async () => {
  const dir = await seed(300);
  const fresh = path.join(dir, '.reserved-5');
  await fsp.utimes(fresh, new Date(), new Date());
  const res = await pruneStaleReservations(dir);
  expect(res.removed).toBe(199);
  await expect(fsp.access(fresh)).resolves.toBeUndefined();
});

test('non-marker files are untouched', async () => {
  const dir = await seed(300);
  for (const n of ['1-a.md', '.max-allocated-group', '.reserved-x', 'notes.txt']) {
    await fsp.writeFile(path.join(dir, n), 'x');
    await fsp.utimes(path.join(dir, n), OLD, OLD);
  }
  await pruneStaleReservations(dir);
  const left = await fsp.readdir(dir);
  for (const n of ['1-a.md', '.max-allocated-group', '.reserved-x', 'notes.txt']) expect(left).toContain(n);
});

test('allocation after prune is max+1', async () => {
  const dir = await seed(300);
  _resetCache();
  await fsp.writeFile(path.join(dir, '.max-allocated-group'), '300');
  await pruneStaleReservations(dir);
  expect(await allocateParallelGroup(dir)).toBe(301);
  // even with every marker gone, the high-water sidecar keeps it monotonic
  for (const n of await fsp.readdir(dir)) if (n.startsWith('.reserved-')) await fsp.unlink(path.join(dir, n));
  expect(await allocateParallelGroup(dir)).toBe(302);
});
