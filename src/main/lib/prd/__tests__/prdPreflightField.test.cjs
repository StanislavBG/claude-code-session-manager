/**
 * prdPreflightField.test.cjs — createPrd's optional `preflight` input (one-line
 * precondition command): validated by preflightCheck.normalizePreflight,
 * written as a `preflight: "<cmd>"` frontmatter line that prdFrontmatter.cjs
 * parses back, and re-rendered by serializePrdFile (the update path).
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdPreflightField.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd, normalizePreflightField } = require('../prdCreate.cjs');
const { parsePrdFile, serializePrdFile, RECOGNIZED_KEYS } = require('../prdFrontmatter.cjs');

let cwd;
let outDir;
let nextNn;
let allocations;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-preflight-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 700;
  allocations = 0;
  remote = {
    async allocateParallelGroup() { allocations++; return nextNn++; },
    async readPrd() { return { ok: false }; },
    async writePrd(slug, body) {
      const p = path.join(outDir, `${slug}.md`);
      await fsp.writeFile(p, body);
      return { ok: true, path: p };
    },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
  };
});

const entry = (slug, o = {}) => ({
  title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g', cwd,
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const read = (f) => fs.readFileSync(path.join(outDir, f), 'utf8');

test('preflight is a recognized key; bare and JSON-quoted forms both parse', () => {
  expect(RECOGNIZED_KEYS.has('preflight')).toBe(true);
  expect(parsePrdFile('---\ntitle: x\npreflight: test -f a.txt\n---\nb\n').frontmatter.preflight).toBe('test -f a.txt');
  expect(parsePrdFile('---\ntitle: x\npreflight: "node -e \\"x#1\\""\n---\nb\n').frontmatter.preflight).toBe('node -e "x#1"');
  const none = parsePrdFile('---\ntitle: x\n---\nb\n').frontmatter;
  expect(none.preflight ?? null).toBeNull();
  expect('preflight' in none).toBe(false);
});

test('preflight round-trips create → parse, and the update re-render keeps / replaces it', async () => {
  const preflight = 'node -e "process.exit(require(\'fs\').existsSync(\'a #b\') ? 0 : 1)"';
  const r = await createPrd(entry('needs-precondition', { preflight: `  ${preflight}  ` }), remote);
  expect(r.ok).toBe(true);
  const text = read(r.filename);
  expect(text.match(/^preflight: .*$/gm)).toHaveLength(1);
  const parsed = parsePrdFile(text);
  expect(parsed.frontmatter.preflight).toBe(preflight);
  expect(parsed.frontmatter.extras).toBeUndefined();
  // Unchanged → byte-identical line; edited (the updatePrd path) → re-rendered.
  const again = serializePrdFile(parsed.frontmatter, parsed.body);
  expect(again.match(/^preflight: .*$/m)[0]).toBe(text.match(/^preflight: .*$/m)[0]);
  expect(parsePrdFile(again).frontmatter.preflight).toBe(preflight);
  const edited = serializePrdFile({ ...parsed.frontmatter, preflight: "echo 'it''s' \"ok\"" }, parsed.body);
  expect(parsePrdFile(edited).frontmatter.preflight).toBe("echo 'it''s' \"ok\"");
  const cleared = serializePrdFile({ ...parsed.frontmatter, preflight: undefined }, parsed.body);
  expect(cleared).not.toMatch(/^preflight:/m);
});

test('absent or blank preflight writes no key', async () => {
  const a = await createPrd(entry('plain-prd'), remote);
  expect(a.ok).toBe(true);
  expect(read(a.filename)).not.toMatch(/^preflight:/m);
  expect(parsePrdFile(read(a.filename)).frontmatter.preflight ?? null).toBeNull();
  const b = await createPrd(entry('blank-preflight', { preflight: '   ' }), remote);
  expect(b.ok).toBe(true);
  expect(read(b.filename)).not.toMatch(/^preflight:/m);
});

test('a multi-line preflight is refused as a 400 before NN allocation', async () => {
  const r = await createPrd(entry('multi-line', { preflight: 'test -f a\ntest -f b' }), remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(400);
  expect(r.error).toMatch(/one line/);
  expect(allocations).toBe(0);
  expect(fs.readdirSync(outDir)).toEqual([]);
});

test('non-string and "none" preflight are refused; normalizePreflightField wraps the throw', async () => {
  const n = await createPrd(entry('num-preflight', { preflight: 42 }), remote);
  expect(n.ok).toBe(false);
  expect(n.status).toBe(400);
  expect((await createPrd(entry('none-preflight', { preflight: 'none' }), remote)).ok).toBe(false);
  expect(normalizePreflightField('test -f x')).toEqual({ ok: true, value: 'test -f x' });
  expect(normalizePreflightField(undefined)).toEqual({ ok: true, value: null });
  const bad = normalizePreflightField('a\nb');
  expect(bad.ok).toBe(false);
  expect(typeof bad.error).toBe('string');
  expect(allocations).toBe(0);
});
