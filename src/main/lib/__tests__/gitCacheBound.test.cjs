/**
 * gitCacheBound.test.cjs — git status caches are LRU-bounded and drop expired entries.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gitCacheBound.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addAllowedRoot } = require('../../config.cjs');
const git = require('../../git.cjs');

const { statusCache, fileStatusCache, CACHE_MAX_CWDS } = git._caches;
let root;
beforeEach(() => {
  git.clearCache();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-cache-bound-')));
  addAllowedRoot(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function mkdirs(n) {
  return Array.from({ length: n }, (_, i) => {
    const d = path.join(root, `d${i}`);
    fs.mkdirSync(d);
    return fs.realpathSync(d);
  });
}

test('50 distinct cwds never exceed the cap', async () => {
  for (const d of mkdirs(50)) {
    await git.getStatus(d);
    await git.getFileStatus(d);
  }
  expect(statusCache.size).toBeLessThanOrEqual(CACHE_MAX_CWDS);
  expect(fileStatusCache.size).toBeLessThanOrEqual(CACHE_MAX_CWDS);
  expect(statusCache.size).toBe(CACHE_MAX_CWDS);
});

test('an expired entry is deleted when encountered', async () => {
  const [d] = mkdirs(1);
  const t0 = 1_000_000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
  await git.getStatus(d);
  await git.getFileStatus(d);
  expect(statusCache.get(d).expiresAt).toBe(t0 + 5_000);

  // Live entry: served from cache, untouched.
  now.mockReturnValue(t0 + 4_999);
  await git.getStatus(d);
  expect(statusCache.get(d).expiresAt).toBe(t0 + 5_000);

  // Expired: the stale entry is deleted and replaced by a fresh one.
  now.mockReturnValue(t0 + 60_000);
  const del = vi.spyOn(statusCache, 'delete');
  await git.getStatus(d);
  expect(del).toHaveBeenCalledWith(d);
  expect(statusCache.get(d).expiresAt).toBe(t0 + 65_000);

  const delFile = vi.spyOn(fileStatusCache, 'delete');
  await git.getFileStatus(d);
  expect(delFile).toHaveBeenCalledWith(d);
  expect(fileStatusCache.get(d).expiresAt).toBe(t0 + 65_000);
});
