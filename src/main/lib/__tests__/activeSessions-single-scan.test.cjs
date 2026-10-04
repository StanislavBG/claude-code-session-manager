'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/activeSessions-single-scan.test.cjs
//
// PRD 1518: activeSessions.cjs must perform exactly one directory scan per TTL
// window per projects dir — allProjectCwds() and activeProjectCwds() (any
// maxAgeMin/maxCwds) derive from that one scan rather than each paying their
// own full readdirSync + statSync pass.

import { vi } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  activeProjectCwds, allProjectCwds, bustProjectCwdCache, __waitForPendingRefresh,
} = require('../activeSessions.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'active-sessions-single-scan-'));
}

function writeTranscript(projectsDir, slug, fileName, cwd, mtimeMsAgo) {
  const projDir = path.join(projectsDir, slug);
  fs.mkdirSync(projDir, { recursive: true });
  const fp = path.join(projDir, fileName);
  fs.writeFileSync(fp, JSON.stringify({ cwd }) + '\n');
  const mtime = new Date(Date.now() - mtimeMsAgo);
  fs.utimesSync(fp, mtime, mtime);
  return fp;
}

test('allProjectCwds then activeProjectCwds within the TTL perform exactly one directory scan, with matching semantics', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdFresh = path.join(base, 'proj-fresh');
    const cwdStale = path.join(base, 'proj-stale');
    fs.mkdirSync(cwdFresh);
    fs.mkdirSync(cwdStale);
    writeTranscript(projectsDir, 'slug-fresh', 'fresh.jsonl', cwdFresh, 5 * 60 * 1000);
    writeTranscript(projectsDir, 'slug-stale', 'stale.jsonl', cwdStale, 120 * 60 * 1000);

    bustProjectCwdCache();
    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    const all = allProjectCwds({ projectsDir });
    const scansAfterAll = readdirSpy.mock.calls.length;
    assert.ok(scansAfterAll > 0, 'allProjectCwds must scan at least once');
    assert.ok(all.includes(cwdFresh) && all.includes(cwdStale), 'allProjectCwds sees both regardless of age');

    const active = activeProjectCwds(90, { projectsDir });
    assert.equal(
      readdirSpy.mock.calls.length, scansAfterAll,
      'activeProjectCwds must reuse the scan allProjectCwds already performed — zero additional readdirSync calls',
    );
    assert.ok(active.includes(cwdFresh), 'activeProjectCwds(90) includes the fresh cwd');
    assert.ok(!active.includes(cwdStale), 'activeProjectCwds(90) excludes the stale cwd via its age filter');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a rescan error keeps the old record and never throws into the synchronous caller', async () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);
    writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 5 * 60 * 1000);

    bustProjectCwdCache();
    const warm = allProjectCwds({ projectsDir });

    const future = Date.now() + 130_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readdirPromiseSpy = vi.spyOn(fsp, 'readdir').mockImplementation(() => Promise.reject(new Error('boom')));
    try {
      const stale = allProjectCwds({ projectsDir });
      assert.deepEqual(stale, warm, 'a failing rescan must not disturb the synchronous, stale-serving caller');

      await __waitForPendingRefresh(projectsDir);

      const afterFailedRescan = allProjectCwds({ projectsDir });
      assert.deepEqual(afterFailedRescan, warm, 'the old record must survive a rescan error');
      assert.ok(errSpy.mock.calls.length >= 1, 'a rescan error must be logged once');
    } finally {
      vi.restoreAllMocks();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('maxCwds cap is applied per-view, identically to the old per-call semantics', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    for (let i = 0; i < 5; i++) {
      const cwd = path.join(base, `proj-${i}`);
      fs.mkdirSync(cwd);
      writeTranscript(projectsDir, `slug-${i}`, `f${i}.jsonl`, cwd, (i + 1) * 60 * 1000);
    }

    bustProjectCwdCache();
    const capped = activeProjectCwds(90, { projectsDir, maxCwds: 3 });
    assert.equal(capped.length, 3, 'maxCwds must cap the derived result size');

    const uncapped = allProjectCwds({ projectsDir });
    assert.equal(uncapped.length, 5, 'a view with a higher cap must still see every project from the same scan');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('after TTL expiry, the next call returns the stale record synchronously (no readdirSync) and kicks off an async rescan', async () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);
    writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 5 * 60 * 1000);

    bustProjectCwdCache();
    const warm = allProjectCwds({ projectsDir }); // warm the cache (first scan is sync)

    try {
      const future = Date.now() + 130_000; // > the 120s TTL
      vi.spyOn(Date, 'now').mockReturnValue(future);

      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      const stale = allProjectCwds({ projectsDir });
      assert.deepEqual(stale, warm, 'expired cache must return the stale record, not block/rescan');
      assert.equal(readdirSpy.mock.calls.length, 0, 'the expired-cache call must not perform a synchronous scan');
    } finally {
      vi.restoreAllMocks();
    }

    await __waitForPendingRefresh(projectsDir);
    const after = allProjectCwds({ projectsDir });
    assert.deepEqual(after, warm, 'data is unchanged, so the refreshed record must match');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('expired cache: 5 concurrent callers trigger exactly one async rescan', async () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);
    writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 5 * 60 * 1000);

    bustProjectCwdCache();
    allProjectCwds({ projectsDir }); // warm the cache synchronously

    const readdirPromiseSpy = vi.spyOn(fsp, 'readdir');
    try {
      const future = Date.now() + 130_000;
      vi.spyOn(Date, 'now').mockReturnValue(future);

      for (let i = 0; i < 5; i++) allProjectCwds({ projectsDir });

      await __waitForPendingRefresh(projectsDir);
      // One rescan == one fsp.readdir(projectsDir) call (the top-level dir listing).
      const topLevelCalls = readdirPromiseSpy.mock.calls.filter((args) => args[0] === projectsDir);
      assert.equal(topLevelCalls.length, 1, `expected exactly 1 async top-level rescan, got ${topLevelCalls.length}`);
    } finally {
      vi.restoreAllMocks();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a new project dir added within the TTL window (bumping the dir mtime) is seen synchronously on the very next call', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);
    writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 5 * 60 * 1000);

    bustProjectCwdCache();
    const before = allProjectCwds({ projectsDir });
    assert.equal(before.length, 1);

    // Still within the TTL window — only projectsDir's own mtime changes.
    const cwdB = path.join(base, 'proj-b');
    fs.mkdirSync(cwdB);
    writeTranscript(projectsDir, 'slug-b', 'b.jsonl', cwdB, 1000);

    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const after = allProjectCwds({ projectsDir });
    assert.ok(readdirSpy.mock.calls.length > 0, 'an mtime change must trigger a synchronous rescan');
    assert.ok(
      after.includes(cwdA) && after.includes(cwdB),
      'the new project must be visible on the very next call, not deferred to an async refresh',
    );

    const active = activeProjectCwds(90, { projectsDir });
    assert.ok(active.includes(cwdB), 'activeProjectCwds must also see the new project synchronously');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('next call after the async rescan resolves sees an updated cwd (same dirMtime, TTL expiry only)', async () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    const cwdA2 = path.join(base, 'proj-a-moved');
    fs.mkdirSync(cwdA);
    const fp = writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 5 * 60 * 1000);

    bustProjectCwdCache();
    const before = allProjectCwds({ projectsDir });
    assert.deepEqual(before, [cwdA]);

    const future = Date.now() + 130_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      // Rewrite the existing transcript's cwd in place — this changes the
      // file's own mtime but NOT projectsDir's mtime (no entries added or
      // removed), so this is a pure TTL-expiry case, not an mtime change.
      fs.mkdirSync(cwdA2);
      fs.writeFileSync(fp, JSON.stringify({ cwd: cwdA2 }) + '\n');

      const stale = allProjectCwds({ projectsDir }); // expired: stale + triggers rescan
      assert.deepEqual(stale, before, 'still the stale record, updated cwd not yet visible');

      await __waitForPendingRefresh(projectsDir);

      const fresh = allProjectCwds({ projectsDir });
      assert.deepEqual(fresh, [cwdA2], 'rescan must pick up the updated cwd');
    } finally {
      vi.restoreAllMocks();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
