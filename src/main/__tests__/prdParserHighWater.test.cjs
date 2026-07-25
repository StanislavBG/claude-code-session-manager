/**
 * prdParserHighWater.test.cjs — regression test for allocateParallelGroup's
 * high-water mark: once queueOps.cjs's autoArchiveCompleted starts moving
 * old NN-*.md files out of prds/ into prds-archived/, a bare directory scan
 * (maxParallelGroupInUse) can regress once the highest-NN files age out —
 * letting a later allocation reissue an already-used NN and collide with an
 * archived group. The high-water-mark sidecar (.max-allocated-group) must
 * keep the allocator monotonic even after every file is archived away.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/prdParserHighWater.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { allocateParallelGroup, maxParallelGroupInUse, _resetCache } = require('../scheduler/prdParser.cjs');

function mkTmpPrdsDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-highwater-'));
}

test('allocator stays monotonic after every NN-*.md file (and its reservation marker) is archived away', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();

  // Directly-authored legacy files (never allocated via allocateParallelGroup
  // — e.g. /develop's deliberate-sibling path — so no .reserved-NN marker
  // exists for them). This is the real gap: reservation markers alone would
  // already protect any NN the allocator itself minted, so the regression
  // this PRD guards against is specifically legacy/directly-authored NNs.
  await fsp.writeFile(path.join(dir, '10-a.md'), '# a\n');
  await fsp.writeFile(path.join(dir, '544-b.md'), '# b\n');

  // A scan (via allocateParallelGroup) observes 544 and persists it as the
  // high-water mark before returning the next free NN.
  const first = await allocateParallelGroup(dir);
  expect(first).toBe(545);

  // Simulate autoArchiveCompleted moving every .md out of the live dir, and
  // also strip the reservation marker the allocation above created — so
  // nothing on disk still evidences 544/545 except the high-water sidecar.
  await fsp.unlink(path.join(dir, '10-a.md'));
  await fsp.unlink(path.join(dir, '544-b.md'));
  await fsp.unlink(path.join(dir, '.reserved-545'));

  const bareScanMax = await maxParallelGroupInUse(dir);
  expect(bareScanMax).toBe(0);

  _resetCache();
  const second = await allocateParallelGroup(dir);
  expect(second).toBeGreaterThan(545);
  expect(second).toBe(546);
});

test('high-water mark also protects against a fresh scan that is lower than a prior allocation, without any archiving involved', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();

  await fsp.writeFile(path.join(dir, '5-only.md'), '# x\n');
  const nn = await allocateParallelGroup(dir);
  expect(nn).toBe(6);

  // A slow/partial directory listing (or a caller passing a differently
  // scoped dir) must not be able to walk the allocator backwards.
  const rescanMax = await maxParallelGroupInUse(dir);
  expect(rescanMax).toBe(6); // the .reserved-6 marker from the allocation above still counts

  const next = await allocateParallelGroup(dir);
  expect(next).toBe(7);
});
