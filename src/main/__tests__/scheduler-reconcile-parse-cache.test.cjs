/**
 * Reconcile parse cache + single-flight. Run:
 *   timeout 120 npx vitest run src/main/__tests__/scheduler-reconcile-parse-cache.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let prdsDir;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-cache-home-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
  prdsDir = scheduler.PRDS_DIR;
  fs.mkdirSync(prdsDir, { recursive: true });
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const freshState = () => ({ config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null });

test('unchanged PRDs are not re-read; touched one is; concurrent calls run sequentially', async () => {
  const N = 25;
  const files = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(prdsDir, `${String(i + 1).padStart(2, '0')}-cache-prd-${i}.md`);
    fs.writeFileSync(f, `---\ntitle: P${i}\ncwd: ${tmpHome}\n---\nbody ${i}\n`);
    files.push(f);
  }
  const mdReads = (spy) => spy.mock.calls.filter((c) => String(c[0]).startsWith(prdsDir) && String(c[0]).endsWith('.md')).length;

  await scheduler.reconcile(freshState()); // warm
  const spy = vi.spyOn(fsp, 'readFile');
  try {
    await scheduler.reconcile(freshState());
    expect(mdReads(spy)).toBe(0);

    spy.mockClear();
    fs.appendFileSync(files[3], 'more\n'); // size changes
    await scheduler.reconcile(freshState());
    expect(mdReads(spy)).toBe(1);

    // concurrency: two requests => at most two passes, never overlapping
    let active = 0;
    let maxActive = 0;
    let passes = 0;
    const realStat = fsp.stat;
    const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (p, ...a) => {
      if (p === files[0]) { passes++; active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; }
      return realStat(p, ...a);
    });
    try {
      await Promise.all([scheduler.reconcile(freshState()), scheduler.reconcile(freshState()), scheduler.reconcile(freshState())]);
    } finally { statSpy.mockRestore(); }
    expect(passes).toBeLessThanOrEqual(2);
    expect(passes).toBeGreaterThanOrEqual(1);
    expect(maxActive).toBe(1);
  } finally {
    spy.mockRestore();
  }
}, 60000);

test('cache drops deleted files', async () => {
  const f = path.join(prdsDir, '99-cache-gone.md');
  fs.writeFileSync(f, `---\ntitle: Gone\ncwd: ${tmpHome}\n---\nx\n`);
  await scheduler.reconcile(freshState());
  fs.rmSync(f);
  await scheduler.reconcile(freshState());
  const spy = vi.spyOn(fsp, 'readFile');
  try {
    fs.writeFileSync(f, `---\ntitle: Gone\ncwd: ${tmpHome}\n---\nx\n`);
    await scheduler.reconcile(freshState());
    expect(spy.mock.calls.filter((c) => String(c[0]) === f).length).toBe(1);
  } finally { spy.mockRestore(); }
});
