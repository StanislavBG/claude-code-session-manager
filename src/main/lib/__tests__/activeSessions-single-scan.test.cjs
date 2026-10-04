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
const os = require('node:os');
const path = require('node:path');
const { activeProjectCwds, allProjectCwds, bustProjectCwdCache } = require('../activeSessions.cjs');

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

test('after TTL expiry, the next call rescans', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);
    writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 5 * 60 * 1000);

    bustProjectCwdCache();
    allProjectCwds({ projectsDir }); // warm the cache

    try {
      const future = Date.now() + 130_000; // > the 120s TTL
      vi.spyOn(Date, 'now').mockReturnValue(future);

      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      allProjectCwds({ projectsDir });
      assert.ok(readdirSpy.mock.calls.length > 0, 'TTL expiry must force a rescan on the next call');
    } finally {
      vi.restoreAllMocks();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
