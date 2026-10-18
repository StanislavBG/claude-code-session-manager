'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeSidecar, readSidecar, sidecarPath } = require('../archivedTranscript.cjs');

let cwd;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-transcript-')); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

const line = '{"type":"assistant","message":{"content":"héllo wörld"}}\n';

test('round-trip equality and sha matches', () => {
  const text = line.repeat(50);
  const r = writeSidecar(cwd, 'e1', text);
  expect(readSidecar(cwd, 'e1')).toBe(text);
  expect(r.sha256).toBe(crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
  expect(r.bytes).toBe(Buffer.byteLength(text, 'utf8'));
  expect(r.path).toBe(sidecarPath(cwd, 'e1'));
  expect(r.path).toContain(path.join('prompt-sessions', 'transcripts-archive', 'e1.jsonl.gz'));
  expect(r.gzBytes).toBe(fs.statSync(r.path).size);
});

test('idempotent: same text is not rewritten', () => {
  const a = writeSidecar(cwd, 'e1', line);
  const old = new Date(Date.now() - 100000);
  fs.utimesSync(a.path, old, old);
  const b = writeSidecar(cwd, 'e1', line);
  expect(b).toEqual(a);
  expect(Math.abs(fs.statSync(a.path).mtimeMs - old.getTime())).toBeLessThan(5);
  const c = writeSidecar(cwd, 'e1', line + line);
  expect(c.sha256).not.toBe(a.sha256);
  expect(readSidecar(cwd, 'e1')).toBe(line + line);
});

test('traversal / separator epicIds are rejected', () => {
  for (const id of ['../x', 'a/b', 'a\\b', '..', 'a..b', '']) {
    expect(() => writeSidecar(cwd, id, 'x')).toThrow();
    expect(() => sidecarPath(cwd, id)).toThrow();
  }
});

test('missing sidecar reads as null', () => {
  expect(readSidecar(cwd, 'nope')).toBeNull();
});

test('gzBytes < bytes for a repetitive 1 MB input', () => {
  const text = 'a'.repeat(1024 * 1024);
  const r = writeSidecar(cwd, 'big', text);
  expect(r.gzBytes).toBeLessThan(r.bytes);
  expect(readSidecar(cwd, 'big')).toBe(text);
});
