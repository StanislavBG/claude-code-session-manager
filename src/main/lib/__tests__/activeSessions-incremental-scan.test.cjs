'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/activeSessions-incremental-scan.test.cjs
//
// A changed projectsDir mtime must rescan only ADDED project dirs; unchanged
// dirs reuse their cached rawCwd and never get a tail read again.

import { vi } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { allProjectCwds, bustProjectCwdCache, __waitForPendingRefresh } = require('../activeSessions.cjs');

function writeT(projectsDir, slug, cwd, ageMs = 60_000, name = 't.jsonl') {
  const d = path.join(projectsDir, slug);
  fs.mkdirSync(d, { recursive: true });
  const fp = path.join(d, name);
  fs.writeFileSync(fp, JSON.stringify({ cwd }) + '\n');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(fp, t, t);
  return fp;
}

function setup(n) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'as-incremental-'));
  const projectsDir = path.join(base, 'projects');
  for (let i = 0; i < n; i++) {
    const cwd = path.join(base, `p${i}`);
    fs.mkdirSync(cwd);
    writeT(projectsDir, `s${i}`, cwd);
  }
  bustProjectCwdCache();
  return { base, projectsDir };
}

function bumpDirMtime(dir) {
  const t = new Date(Date.now() + 5000 + Math.random() * 1000);
  fs.utimesSync(dir, t, t);
}

test('adding 1 dir to 50 cached dirs tail-reads exactly 1 dir; unchanged dirs are never re-read', async () => {
  const { base, projectsDir } = setup(50);
  try {
    assert.equal(allProjectCwds({ projectsDir }).length, 50);
    const openSpy = vi.spyOn(fs, 'openSync');
    const cwdNew = path.join(base, 'pnew');
    fs.mkdirSync(cwdNew);
    writeT(projectsDir, 'snew', cwdNew);
    bumpDirMtime(projectsDir);
    const after = allProjectCwds({ projectsDir });
    assert.equal(after.length, 51);
    assert.ok(after.includes(cwdNew));
    assert.equal(openSpy.mock.calls.length, 1, 'exactly one tail read');

    // TTL refresh over unchanged dirs: zero tail reads.
    openSpy.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 130_000);
    allProjectCwds({ projectsDir });
    await __waitForPendingRefresh(projectsDir);
    assert.equal(openSpy.mock.calls.length, 0, 'async refresh must not tail-read unchanged dirs');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a dir whose newest transcript grew is re-read by the refresh', async () => {
  const { base, projectsDir } = setup(3);
  try {
    allProjectCwds({ projectsDir });
    const moved = path.join(base, 'moved');
    fs.mkdirSync(moved);
    fs.appendFileSync(path.join(projectsDir, 's1', 't.jsonl'), JSON.stringify({ cwd: moved }) + '\n');
    const openSpy = vi.spyOn(fs.promises, 'open');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 130_000);
    allProjectCwds({ projectsDir });
    await __waitForPendingRefresh(projectsDir);
    assert.equal(openSpy.mock.calls.length, 1, 'only the grown dir is re-read');
    assert.ok(allProjectCwds({ projectsDir }).includes(moved));
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('removing a dir drops its record', () => {
  const { base, projectsDir } = setup(4);
  try {
    const before = allProjectCwds({ projectsDir });
    assert.equal(before.length, 4);
    fs.rmSync(path.join(projectsDir, 's2'), { recursive: true });
    bumpDirMtime(projectsDir);
    const openSpy = vi.spyOn(fs, 'openSync');
    const after = allProjectCwds({ projectsDir });
    assert.equal(after.length, 3);
    assert.ok(!after.includes(path.join(base, 'p2')));
    assert.equal(openSpy.mock.calls.length, 0);
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
