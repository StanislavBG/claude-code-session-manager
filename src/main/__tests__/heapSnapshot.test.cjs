/**
 * heapSnapshot.test.cjs — unit tests for heapSnapshot.cjs's default-off
 * gating, IPC/menu wiring, and the capture timeout bound.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/heapSnapshot.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const heapSnapshot = require('../heapSnapshot.cjs');

const ORIGINAL_FLAG = process.env.SM_HEAP_SNAPSHOT;

beforeEach(() => {
  delete process.env.SM_HEAP_SNAPSHOT;
});

afterEach(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.SM_HEAP_SNAPSHOT;
  else process.env.SM_HEAP_SNAPSHOT = ORIGINAL_FLAG;
});

test('isEnabled is false by default (no env flag)', () => {
  expect(heapSnapshot.isEnabled()).toBe(false);
});

test('isEnabled is true only when SM_HEAP_SNAPSHOT=1', () => {
  process.env.SM_HEAP_SNAPSHOT = '1';
  expect(heapSnapshot.isEnabled()).toBe(true);
  process.env.SM_HEAP_SNAPSHOT = 'true';
  expect(heapSnapshot.isEnabled()).toBe(false);
});

test('registerIpc registers nothing when disabled — default-off IPC surface', () => {
  const calls = [];
  const fakeIpcMain = { handle: (channel, listener) => calls.push({ channel, listener }) };
  const registered = heapSnapshot.registerIpc({ ipcMain: fakeIpcMain, getWindow: () => null });
  expect(registered).toBe(false);
  expect(calls).toHaveLength(0);
});

test('registerIpc registers the channel when enabled', () => {
  process.env.SM_HEAP_SNAPSHOT = '1';
  const calls = [];
  const fakeIpcMain = { handle: (channel, listener) => calls.push({ channel, listener }) };
  const registered = heapSnapshot.registerIpc({ ipcMain: fakeIpcMain, getWindow: () => null });
  expect(registered).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].channel).toBe(heapSnapshot.CHANNEL);
  expect(calls[0].channel).toBe('diagnostics:heap-snapshot');
});

test('buildMenuItem returns null when disabled — no menu entry added', () => {
  expect(heapSnapshot.buildMenuItem(() => null)).toBeNull();
});

test('buildMenuItem returns a clickable item when enabled', () => {
  process.env.SM_HEAP_SNAPSHOT = '1';
  const item = heapSnapshot.buildMenuItem(() => null);
  expect(item).not.toBeNull();
  expect(typeof item.click).toBe('function');
  expect(item.label).toMatch(/heap snapshot/i);
});

test('captureSnapshot rejects when disabled, without touching the window', async () => {
  const win = { webContents: { takeHeapSnapshot: () => { throw new Error('should not be called'); } } };
  await expect(heapSnapshot.captureSnapshot(win)).rejects.toThrow(/disabled/i);
});

test('captureSnapshot rejects when no window is available', async () => {
  process.env.SM_HEAP_SNAPSHOT = '1';
  await expect(heapSnapshot.captureSnapshot(null)).rejects.toThrow(/no renderer window/i);
});

test('captureSnapshot writes the file and reports size/duration on success', async () => {
  process.env.SM_HEAP_SNAPSHOT = '1';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-heap-test-'));
  try {
    const win = {
      webContents: {
        takeHeapSnapshot: async (filePath) => {
          await fsp.writeFile(filePath, Buffer.alloc(1024, 1));
        },
      },
    };
    const result = await heapSnapshot.captureSnapshot(win, { dir, now: new Date('2026-08-07T12:00:00.000Z') });
    expect(result.filePath).toBe(path.join(dir, 'heap-2026-08-07T12-00-00-000Z.heapsnapshot'));
    expect(result.bytes).toBe(1024);
    expect(typeof result.ms).toBe('number');
    const stat = await fsp.stat(result.filePath);
    expect(stat.size).toBe(1024);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('captureSnapshot times out instead of hanging forever on a stuck write', async () => {
  process.env.SM_HEAP_SNAPSHOT = '1';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-heap-test-'));
  try {
    const win = {
      webContents: {
        // Never resolves — simulates a stuck/blocked renderer.
        takeHeapSnapshot: () => new Promise(() => {}),
      },
    };
    await expect(
      heapSnapshot.captureSnapshot(win, { dir, timeoutMs: 20 })
    ).rejects.toThrow(/timed out/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('snapshotDir points under ~/.claude/session-manager', () => {
  expect(heapSnapshot.snapshotDir()).toBe(path.join(os.homedir(), '.claude', 'session-manager'));
});
