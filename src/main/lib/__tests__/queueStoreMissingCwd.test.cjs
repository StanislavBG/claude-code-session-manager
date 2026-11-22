/**
 * queueStoreMissingCwd.test.cjs — writeSplit must never re-create a project
 * root that no longer exists. Live 2026-11-22: a reconcile pass wrote
 * {"jobs": []} into /tmp/sm-sbx-probe-LrKw/work and two ~/.sm-sbx-chk-*\/work
 * dirs deleted ~30 minutes earlier, because a sourceCwd that survives only as
 * a ~/.claude/projects transcript dir was still written and mkdir -p
 * materialized the whole tree.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/queueStoreMissingCwd.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-missingcwd-home-'));
process.env.HOME = tmpHome;

const queueStore = require('../scheduler/queueStore.cjs');

// Deleted-project fixtures live OUTSIDE os.tmpdir() (the ~/.sm-sbx-chk-*/work
// shape) so the skip is proven by queueStore itself, not by isEphemeralCwd.
// `test-results/` is gitignored.
const NON_TMP_ROOT = path.join(process.cwd(), 'test-results', 'queue-missing-cwd-fixtures');
async function mkNonTmpDir(prefix) {
  fs.mkdirSync(NON_TMP_ROOT, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(NON_TMP_ROOT, prefix));
  // A plain main-tree checkout, so the deleted cwd under it is not refused as
  // a linked-worktree path when this suite runs inside a job worktree.
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

const tmpDirs = [tmpHome];
afterEach(async () => {
  vi.restoreAllMocks();
  while (tmpDirs.length > 1) {
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

test('writing the queue for a deleted cwd creates nothing on disk and warns once', async () => {
  const parent = await mkNonTmpDir('.sm-sbx-chk-');
  tmpDirs.push(parent);
  const gone = path.join(parent, 'work');
  expect(fs.existsSync(gone)).toBe(false);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(queueStore.writeSplit({ config: {}, sourceCwds: [gone], jobs: [] })).resolves.toBeUndefined();

  expect(fs.existsSync(gone)).toBe(false);
  expect(fs.readdirSync(parent)).toEqual(['.git']);
  const hits = warn.mock.calls.filter((c) => c.some((a) => String(a).includes(gone)));
  expect(hits).toHaveLength(1);
});

test('writing the queue for an existing non-ephemeral cwd still writes queue.json', async () => {
  const good = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-missingcwd-good-'));
  tmpDirs.push(good);
  const parent = await mkNonTmpDir('.sm-sbx-chk-');
  tmpDirs.push(parent);
  const gone = path.join(parent, 'work');

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await queueStore.writeSplit({
    config: {},
    sourceCwds: [gone, good],
    jobs: [{ slug: 'keeper', cwd: good }],
  });

  const written = JSON.parse(fs.readFileSync(queueStore.projectQueuePath(good), 'utf8'));
  expect(written.jobs.map((j) => j.slug)).toEqual(['keeper']);
  expect(fs.existsSync(gone)).toBe(false);
});
