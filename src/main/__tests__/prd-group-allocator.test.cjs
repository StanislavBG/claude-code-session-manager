/**
 * prd-group-allocator.test.cjs — regression test for gh-issue-4 / PRD
 * (allocateParallelGroup): two projects authoring PRDs concurrently under
 * the shared prds/ directory both computed the same max-NN and allocated
 * the same new parallel group (05-11 vs 06-09 on 2026-07-14, then 545 vs
 * 545 again on 2026-07-15 between session-manager and sigma). NN is both
 * the filename counter and the parallel-group key the scheduler parses,
 * so a collision silently merges two unrelated projects' PRDs into one
 * group.
 *
 * Run: timeout 120 node --test src/main/__tests__/prd-group-allocator.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  allocateParallelGroup,
  maxParallelGroupInUse,
  parsePrdRaw,
  _resetCache,
} = require('../scheduler/prdParser.cjs');

function mkTmpPrdsDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-alloc-'));
}

test('allocateParallelGroup returns max+1 on an empty directory', async () => {
  const dir = await mkTmpPrdsDir();
  const nn = await allocateParallelGroup(dir);
  assert.strictEqual(nn, 1);
});

test('allocateParallelGroup scans the FULL directory, not a narrowed glob — reproduces the 577-PRD/max-544 live directory shape', async () => {
  const dir = await mkTmpPrdsDir();
  // Live directory (2026-07-18) holds an unpadded legacy name and a max of 544.
  await fsp.writeFile(path.join(dir, '54-scheduler-memory-guard-cap3.md'), '# x\n');
  await fsp.writeFile(path.join(dir, '110-some-slug.md'), '# x\n'); // would be missed by '^10[0-9]'
  await fsp.writeFile(path.join(dir, '544-latest-prd.md'), '# x\n');
  await fsp.writeFile(path.join(dir, '9-old-single-digit.md'), '# x\n');

  const max = await maxParallelGroupInUse(dir);
  assert.strictEqual(max, 544, 'must see 544 as the max even though 110 sorts before it lexically and 54/9 are unpadded');

  const nn = await allocateParallelGroup(dir);
  assert.strictEqual(nn, 545);
});

test('two concurrent allocateParallelGroup callers never receive the same new NN (the core race from the incident)', async () => {
  const dir = await mkTmpPrdsDir();
  await fsp.writeFile(path.join(dir, '544-latest-prd.md'), '# x\n');

  const CONCURRENCY = 12;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => allocateParallelGroup(dir)),
  );

  const distinct = new Set(results);
  assert.strictEqual(distinct.size, CONCURRENCY, `expected ${CONCURRENCY} distinct NNs, got collisions: ${results.join(',')}`);
  for (const nn of results) {
    assert.ok(nn > 544, `allocated NN ${nn} must not collide with existing on-disk NN 544`);
  }
});

test('reservation markers are counted toward max-NN so a crash mid-allocation cannot be re-issued by a later caller', async () => {
  const dir = await mkTmpPrdsDir();
  await fsp.writeFile(path.join(dir, '544-latest-prd.md'), '# x\n');

  const first = await allocateParallelGroup(dir); // 545, leaves .reserved-545 on disk
  assert.strictEqual(first, 545);

  // Simulate the caller never authoring 545-slug.md (crash between reserve
  // and author). A later allocation must still move past 545, not reissue it.
  const second = await allocateParallelGroup(dir);
  assert.strictEqual(second, 546);
});

test('deliberate parallel siblings sharing one existing NN are unaffected by the allocator (main regression risk)', async () => {
  const dir = await mkTmpPrdsDir();
  // Three independent PRDs deliberately opting into the SAME group, exactly
  // as /develop's SKILL.md contract allows — authored directly by filename,
  // never through allocateParallelGroup.
  await fsp.writeFile(path.join(dir, '545-scheduler-tick-stall-after-job-failure.md'), '---\ncwd: ~/Projects/session-manager\n---\nBody A\n');
  await fsp.writeFile(path.join(dir, '545-filetree-show-hidden-default-and-persist.md'), '---\ncwd: ~/Projects/session-manager\n---\nBody B\n');
  await fsp.writeFile(path.join(dir, '545-editor-tab-close-shortcut-and-close-right.md'), '---\ncwd: ~/Projects/session-manager\n---\nBody C\n');

  const files = await fsp.readdir(dir);
  const parsed = await Promise.all(
    files.filter((f) => f.endsWith('.md')).map((f) => parsePrdRaw(path.join(dir, f))),
  );
  assert.strictEqual(parsed.length, 3);
  for (const p of parsed) {
    assert.strictEqual(p.parallelGroup, 545, 'siblings must keep sharing group 545 — the allocator must not renumber existing files');
  }

  // A brand-new PRD (not a deliberate sibling) allocated afterward must NOT
  // land in 545 — it gets the next free group instead.
  const nn = await allocateParallelGroup(dir);
  assert.strictEqual(nn, 546);
});

test('module-level PRD dir-mtime cache in prdParser is unaffected by reservation markers (hidden files stay invisible to listPrdFiles)', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();
  await fsp.writeFile(path.join(dir, '1-a.md'), '# x\n');
  const { listPrdFiles } = require('../scheduler/prdParser.cjs');
  const before = await listPrdFiles(dir);
  assert.strictEqual(before.length, 1);

  await allocateParallelGroup(dir); // writes a .reserved-2 marker
  _resetCache();
  const after = await listPrdFiles(dir);
  assert.strictEqual(after.length, 1, 'reservation markers must not appear as PRD files');
});
