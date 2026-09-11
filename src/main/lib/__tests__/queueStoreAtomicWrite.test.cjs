/**
 * queueStoreAtomicWrite.test.cjs — regression test for the tmp-path collision
 * that tore `scheduler-machine.json` four times (`.corrupt-*` Sep 7/10/11,
 * plus a `.bak-*`). The old `writeJsonAtomic`/`writeJsonAtomicSync` used
 * `${file}.tmp-${process.pid}` — keyed on PID ONLY, so two overlapping writes
 * inside the SAME process shared one tmp path. A long write mid-flight gets
 * clobbered by a short write's O_TRUNC open on the same tmp file, and the
 * short write's remaining buffered bytes land past the short write's own
 * EOF; `rename()` is atomic, but the shared tmp file underneath it never was
 * — the publish carries the interleaved bytes.
 *
 * This drives two REAL concurrent async writes (one large enough that
 * Node's fs writeFile chunks it — see WRITE_CHUNK_BYTES below — so the two
 * calls' internal awaits actually interleave on the event loop) against the
 * same target path, and asserts the result is one clean payload with no
 * trailing bytes. Confirmed by hand against the pre-fix pid-only tmp name
 * (reverting just the tmp-path line): this test fails there — the read
 * either doesn't parse or parses to neither payload — and passes against the
 * unique-per-call tmp name shipped in this commit.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/queueStoreAtomicWrite.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic } = require('../queueStore.cjs');

// Node's fs.promises writeFile-style chunking writes large buffers in ~512KB
// pieces, awaiting each one — large enough here to guarantee the short
// write's open+truncate+write+rename lands in the middle of the long write's
// remaining chunks when raced with Promise.all.
const LONG_PAYLOAD = { kind: 'long', blob: 'A'.repeat(4 * 1024 * 1024) };
const SHORT_PAYLOAD = { kind: 'short' };

const tmpDirs = [];

afterEach(async () => {
  while (tmpDirs.length) {
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

test('two concurrent writeJsonAtomic calls against the same path never interleave', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'queueStore-atomic-'));
  tmpDirs.push(dir);
  const target = path.join(dir, 'race-target.json');

  // Repeat a handful of times — the race is timing-dependent, and this
  // guards against a lucky single run masking a reintroduced bug.
  for (let attempt = 0; attempt < 5; attempt++) {
    await Promise.all([
      writeJsonAtomic(target, LONG_PAYLOAD),
      writeJsonAtomic(target, SHORT_PAYLOAD),
    ]);

    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw); // throws if the file is torn — that alone is a failure
    const matchesLong = JSON.stringify(parsed) === JSON.stringify(LONG_PAYLOAD);
    const matchesShort = JSON.stringify(parsed) === JSON.stringify(SHORT_PAYLOAD);
    expect(matchesLong || matchesShort).toBe(true);

    // No trailing bytes beyond the serialized payload (the exact shape of
    // the real corruption: a complete object followed by an orphaned tail).
    const expected = JSON.stringify(parsed, null, 2);
    expect(raw).toBe(expected);
  }
});

test('a failed write never leaves a stray .tmp-* file behind', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'queueStore-atomic-fail-'));
  tmpDirs.push(dir);
  const target = path.join(dir, 'target.json');
  // Target is a directory, not a file — mkdir + open + write all succeed,
  // but the final rename() onto an existing directory fails with EISDIR,
  // exercising the unlink-the-tmp-on-error path specifically (not just a
  // trivial pre-write failure).
  fs.mkdirSync(target);

  await expect(writeJsonAtomic(target, { a: 1 })).rejects.toThrow();

  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  expect(leftovers).toEqual([]);
});
