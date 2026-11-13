/**
 * activeIndexMerge.appPreviewStop.test.cjs — mergeActiveIndex stops an Epic's
 * app preview (fire-and-forget, after a successful write) for every id in the
 * payload's removedIds, via the injectable deps.stopPreview.
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/activeIndexMerge.appPreviewStop.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mergeActiveIndex } = require('../activeIndexMerge.cjs');
const { activeIndexPath } = require('../epicMint.cjs');

const tmpDirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  // Under homedir so config.cjs's read boundary (validatePath) passes.
  const cwd = await fsp.mkdtemp(path.join(os.homedir(), '.sm-test-preview-stop-'));
  tmpDirs.push(cwd);
  return cwd;
}

function session(id) {
  return {
    id,
    cwd: '/proj',
    goalText: `goal for ${id}`,
    claudeSessionId: `claude-${id}`,
    status: 'active',
    createdAt: '2026-11-12T10:00:00.000Z',
    completedAt: null,
  };
}

/** Let the fire-and-forget microtasks/rejections settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

test('stopPreview is called once per removed id after a successful write', async () => {
  const cwd = await mkCwd();
  const a = session('psess-a');
  const b = session('psess-b');
  const c = session('psess-c');
  await mergeActiveIndex(cwd, { sessions: { [a.id]: a, [b.id]: b, [c.id]: c } }, { stopPreview: vi.fn() });

  const stopPreview = vi.fn(async () => ({ ok: true }));
  const result = await mergeActiveIndex(cwd, { sessions: { [c.id]: c }, removedIds: [a.id, b.id] }, { stopPreview });
  await flush();

  expect(Object.keys(result.sessions)).toEqual([c.id]);
  expect(stopPreview).toHaveBeenCalledTimes(2);
  expect(stopPreview).toHaveBeenCalledWith(a.id);
  expect(stopPreview).toHaveBeenCalledWith(b.id);
});

test('stopPreview is not called when removedIds is empty or absent', async () => {
  const cwd = await mkCwd();
  const a = session('psess-a');
  const stopPreview = vi.fn();
  await mergeActiveIndex(cwd, { sessions: { [a.id]: a }, removedIds: [] }, { stopPreview });
  await mergeActiveIndex(cwd, { sessions: { [a.id]: a } }, { stopPreview });
  await flush();
  expect(stopPreview).not.toHaveBeenCalled();
});

test('stopPreview is not called when the write fails', async () => {
  const cwd = await mkCwd();
  // A directory where active-index.json belongs makes the atomic rename fail.
  fs.mkdirSync(activeIndexPath(cwd), { recursive: true });
  fs.writeFileSync(path.join(activeIndexPath(cwd), 'blocker'), 'x');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stopPreview = vi.fn();
  await expect(
    mergeActiveIndex(cwd, { sessions: {}, removedIds: ['psess-a'] }, { stopPreview }),
  ).rejects.toThrow();
  await flush();
  expect(stopPreview).not.toHaveBeenCalled();
});

test('a throwing or rejecting stopPreview never changes the merge result', async () => {
  const cwd = await mkCwd();
  const a = session('psess-a');
  const b = session('psess-b');
  const c = session('psess-c');
  await mergeActiveIndex(cwd, { sessions: { [a.id]: a, [b.id]: b, [c.id]: c } }, { stopPreview: vi.fn() });

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stopPreview = vi.fn((id) => {
    if (id === a.id) throw new Error('sync boom');
    return Promise.reject(new Error('async boom'));
  });
  const result = await mergeActiveIndex(cwd, { sessions: { [c.id]: c }, removedIds: [a.id, b.id] }, { stopPreview });
  await flush();

  expect(result).toEqual({ sessions: { [c.id]: c }, events: { [c.id]: [] } });
  expect(stopPreview).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.some((args) => String(args[0]).includes('app preview stop failed'))).toBe(true);
});
