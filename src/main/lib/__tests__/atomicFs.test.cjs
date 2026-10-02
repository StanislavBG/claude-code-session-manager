'use strict';

// vitest globals (describe/it/expect/beforeEach/afterEach) — same convention
// as the other .cjs tests (see sessionSlots.test.cjs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const atomicFs = require('../atomicFs.cjs');

describe('atomicFs', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicFs-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeTextAtomic writes the file and leaves no tmp sibling', async () => {
    const file = path.join(dir, 'nested', 'note.txt');
    await atomicFs.writeTextAtomic(file, 'hello world');
    expect(fs.readFileSync(file, 'utf8')).toBe('hello world');
    const siblings = fs.readdirSync(path.join(dir, 'nested'));
    expect(siblings).toEqual(['note.txt']);
  });

  it('writeTextAtomicSync writes the file and leaves no tmp sibling', () => {
    const file = path.join(dir, 'nested-sync', 'note.txt');
    atomicFs.writeTextAtomicSync(file, 'hello sync');
    expect(fs.readFileSync(file, 'utf8')).toBe('hello sync');
    const siblings = fs.readdirSync(path.join(dir, 'nested-sync'));
    expect(siblings).toEqual(['note.txt']);
  });

  it('writeJsonAtomic pretty-prints with a trailing newline by default', async () => {
    const file = path.join(dir, 'data.json');
    await atomicFs.writeJsonAtomic(file, { a: 1 });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n`);
  });

  it('writeJsonAtomic honors newline:false and a custom space', async () => {
    const file = path.join(dir, 'compact.json');
    await atomicFs.writeJsonAtomic(file, { a: 1 }, { newline: false, space: 0 });
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 1 }));
  });

  it('writeJsonAtomicSync round-trips through JSON.parse', () => {
    const file = path.join(dir, 'data-sync.json');
    atomicFs.writeJsonAtomicSync(file, { cap: 3 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ cap: 3 });
  });

  it('applies opts.mode to the final file (credentials-style 0o600)', async () => {
    const file = path.join(dir, 'secret.json');
    await atomicFs.writeJsonAtomic(file, { token: 'x' }, { mode: 0o600 });
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readJsonOr returns parsed JSON when the file exists', async () => {
    const file = path.join(dir, 'present.json');
    await atomicFs.writeJsonAtomic(file, { ok: true });
    await expect(atomicFs.readJsonOr(file, 'fallback')).resolves.toEqual({ ok: true });
  });

  it('readJsonOr returns the fallback when the file is missing', async () => {
    const file = path.join(dir, 'missing.json');
    await expect(atomicFs.readJsonOr(file, 'fallback')).resolves.toBe('fallback');
  });

  it('readJsonOrSync returns the fallback on invalid JSON', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{not json', 'utf8');
    expect(atomicFs.readJsonOrSync(file, { safe: true })).toEqual({ safe: true });
  });

  it('cleans up the tmp file when the rename target directory is invalid', async () => {
    // Pass a file path whose directory cannot be created (parent is a file).
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const file = path.join(blocker, 'nope.json');
    await expect(atomicFs.writeJsonAtomic(file, { a: 1 })).rejects.toThrow();
  });
});
