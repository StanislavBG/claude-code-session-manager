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
const { allProjectCwds, bustProjectCwdCache, __resetProjectCwdCacheForTests, __waitForPendingRefresh } = require('../activeSessions.cjs');

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
  __resetProjectCwdCacheForTests();
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

test('default bust keeps the per-dir cache: 0 tail reads; added dir costs exactly 1', () => {
  const { base, projectsDir } = setup(50);
  try {
    assert.equal(allProjectCwds({ projectsDir }).length, 50);
    const openSpy = vi.spyOn(fs, 'openSync');
    bustProjectCwdCache();
    assert.equal(allProjectCwds({ projectsDir }).length, 50);
    assert.equal(openSpy.mock.calls.length, 0, 'bust must not force tail reads');

    const cwdNew = path.join(base, 'pnew');
    fs.mkdirSync(cwdNew);
    writeT(projectsDir, 'snew', cwdNew);
    bustProjectCwdCache();
    const after = allProjectCwds({ projectsDir });
    assert.equal(after.length, 51);
    assert.ok(after.includes(cwdNew));
    assert.equal(openSpy.mock.calls.length, 1, 'exactly one tail read');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deep bust re-reads only the dir whose newest transcript grew', () => {
  const { base, projectsDir } = setup(50);
  try {
    allProjectCwds({ projectsDir });
    const moved = path.join(base, 'moved');
    fs.mkdirSync(moved);
    fs.appendFileSync(path.join(projectsDir, 's7', 't.jsonl'), JSON.stringify({ cwd: moved }) + '\n');
    const openSpy = vi.spyOn(fs, 'openSync');
    bustProjectCwdCache();
    assert.ok(!allProjectCwds({ projectsDir }).includes(moved), 'shallow bust does not notice growth');
    assert.equal(openSpy.mock.calls.length, 0);
    bustProjectCwdCache({ deep: true });
    assert.ok(allProjectCwds({ projectsDir }).includes(moved));
    assert.equal(openSpy.mock.calls.length, 1, 'only the grown dir is tail-read');
    openSpy.mockClear();
    bustProjectCwdCache();
    allProjectCwds({ projectsDir });
    assert.equal(openSpy.mock.calls.length, 0, 'forceDeep is cleared after the pass');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('classify memo survives a default bust', () => {
  const { base, projectsDir } = setup(3);
  try {
    allProjectCwds({ projectsDir });
    const statSpy = vi.spyOn(fs, 'statSync');
    const gitCalls = () => statSpy.mock.calls.filter((c) => String(c[0]).endsWith('.git')).length;
    allProjectCwds({ projectsDir });
    bustProjectCwdCache();
    const before = gitCalls();
    allProjectCwds({ projectsDir });
    assert.equal(gitCalls(), before, 'no re-classification of known cwds');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function addCwdless(projectsDir, slug, withFile = true) {
  const d = path.join(projectsDir, slug);
  fs.mkdirSync(d, { recursive: true });
  if (!withFile) return null;
  const fp = path.join(d, 't.jsonl');
  fs.writeFileSync(fp, JSON.stringify({ type: 'summary' }) + '\n');
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(fp, t, t);
  return fp;
}

test('cwd-less and jsonl-less dirs are cached: shallow and deep bust do 0 tail reads', () => {
  const { base, projectsDir } = setup(5);
  try {
    for (let i = 0; i < 10; i++) addCwdless(projectsDir, `c${i}`);
    for (let i = 0; i < 3; i++) addCwdless(projectsDir, `e${i}`, false);
    assert.equal(allProjectCwds({ projectsDir }).length, 5);
    const openSpy = vi.spyOn(fs, 'openSync');
    bustProjectCwdCache();
    assert.equal(allProjectCwds({ projectsDir }).length, 5);
    assert.equal(openSpy.mock.calls.length, 0, 'shallow bust: no tail reads');
    bustProjectCwdCache({ deep: true });
    assert.equal(allProjectCwds({ projectsDir }).length, 5);
    assert.equal(openSpy.mock.calls.length, 0, 'deep bust: no tail reads');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a cwd-less dir whose transcript gains a cwd row is re-read exactly once', () => {
  const { base, projectsDir } = setup(5);
  try {
    const fps = [];
    for (let i = 0; i < 10; i++) fps.push(addCwdless(projectsDir, `c${i}`));
    allProjectCwds({ projectsDir });
    const found = path.join(base, 'found');
    fs.mkdirSync(found);
    fs.appendFileSync(fps[4], JSON.stringify({ cwd: found }) + '\n');
    const openSpy = vi.spyOn(fs, 'openSync');
    bustProjectCwdCache({ deep: true });
    assert.ok(allProjectCwds({ projectsDir }).includes(found));
    assert.equal(openSpy.mock.calls.length, 1, 'only the changed dir is read');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
