/**
 * prdCriteria.test.cjs — normalizeCriteria (strings → manual ac-<n>, each
 * check kind, refusals naming the criterion index) and createPrd writing the
 * normalized list to frontmatter `criteria:` + rendering ids in the body.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdCriteria.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { normalizeCriteria, validateCriteria } = require('../prdCriteria.cjs');
const { createPrd } = require('../prdCreate.cjs');
const { parsePrdFile, serializePrdFile } = require('../prdFrontmatter.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');

const refusal = (input) => {
  const r = validateCriteria(input);
  expect(r.ok).toBe(false);
  return r;
};

test('plain strings become manual criteria with ac-<n> ids', () => {
  expect(normalizeCriteria(['First thing', '  Second thing  '])).toEqual([
    { id: 'ac-1', statement: 'First thing', check: { kind: 'manual' } },
    { id: 'ac-2', statement: 'Second thing', check: { kind: 'manual' } },
  ]);
});

test('mixed strings and objects; object without id gets its positional ac-<n>', () => {
  const out = normalizeCriteria(['a', { statement: 'b' }, { id: 'typecheck-green', statement: 'c', check: { kind: 'manual', spec: 'look at it' } }]);
  expect(out.map((c) => c.id)).toEqual(['ac-1', 'ac-2', 'typecheck-green']);
  expect(out[1].check).toEqual({ kind: 'manual' });
  expect(out[2].check).toEqual({ kind: 'manual', spec: 'look at it' });
});

test('command check: valid gate command passes; bad syntax refused with index', () => {
  const [c] = normalizeCriteria([{ id: 'tests', statement: 'Tests pass', check: { kind: 'command', spec: 'timeout 120 npx vitest run src/x' } }]);
  expect(c.check).toEqual({ kind: 'command', spec: 'timeout 120 npx vitest run src/x' });
  const r = refusal(['ok', { statement: 'piped', check: { kind: 'command', spec: 'timeout 60 npm test | tail -5' } }]);
  expect(r.index).toBe(2);
  expect(r.error).toMatch(/^criteria entry 2: command check spec is not a valid gate command/);
  expect(refusal([{ statement: 'x', check: { kind: 'command', spec: 'none' } }]).error).toMatch(/entry 1: .*not "none"/);
  expect(refusal([{ statement: 'x', check: { kind: 'command' } }]).error).toMatch(/entry 1: command check needs a spec/);
});

test('file check: repo-relative path (string or object, optional contains)', () => {
  const out = normalizeCriteria([
    { statement: 'exists', check: { kind: 'file', spec: 'src/main/lib/prd/prdCriteria.cjs' } },
    { statement: 'has export', check: { kind: 'file', spec: { path: 'scripts/lib-layout.json', contains: '"prdCriteria"' } } },
  ]);
  expect(out[0].check).toEqual({ kind: 'file', spec: { path: 'src/main/lib/prd/prdCriteria.cjs' } });
  expect(out[1].check).toEqual({ kind: 'file', spec: { path: 'scripts/lib-layout.json', contains: '"prdCriteria"' } });
  expect(refusal([{ statement: 'x', check: { kind: 'file', spec: '/etc/passwd' } }]).error).toMatch(/entry 1: file check path/);
  expect(refusal([{ statement: 'x', check: { kind: 'file', spec: '../outside.txt' } }]).error).toMatch(/entry 1: file check path/);
  expect(refusal([{ statement: 'x', check: { kind: 'file', spec: { path: 'a.txt', bogus: 1 } } }]).error).toMatch(/unknown key/);
});

test('http check: loopback URLs with expected status (default 200)', () => {
  const out = normalizeCriteria([
    { statement: 'health', check: { kind: 'http', spec: 'http://127.0.0.1:4317/health' } },
    { statement: 'missing', check: { kind: 'http', spec: { url: 'http://localhost:8080/x', status: 404 } } },
    { statement: 'v6', check: { kind: 'http', spec: { url: 'https://[::1]:9/' } } },
  ]);
  expect(out[0].check).toEqual({ kind: 'http', spec: { url: 'http://127.0.0.1:4317/health', status: 200 } });
  expect(out[1].check.spec).toEqual({ url: 'http://localhost:8080/x', status: 404 });
  expect(out[2].check.spec.status).toBe(200);
});

test('http check: non-loopback, bad scheme and bad status are refused with index', () => {
  const r = refusal(['a', 'b', { statement: 'ext', check: { kind: 'http', spec: 'https://example.com/health' } }]);
  expect(r.index).toBe(3);
  expect(r.error).toMatch(/^criteria entry 3: http check url must be loopback only/);
  expect(refusal([{ statement: 'x', check: { kind: 'http', spec: 'http://127.0.0.1.evil.com/' } }]).error).toMatch(/loopback only/);
  expect(refusal([{ statement: 'x', check: { kind: 'http', spec: 'http://10.0.0.1/' } }]).error).toMatch(/loopback only/);
  expect(refusal([{ statement: 'x', check: { kind: 'http', spec: 'file:///etc/passwd' } }]).error).toMatch(/http or https/);
  expect(refusal([{ statement: 'x', check: { kind: 'http', spec: { url: 'http://localhost/', status: 700 } } }]).error).toMatch(/status/);
});

test('http check: optional one-line contains is kept; too long, multi-line, empty or unknown keys are refused', () => {
  const [c] = normalizeCriteria([{ statement: 'runbook', check: { kind: 'http', spec: { url: 'http://127.0.0.1:4317/x', contains: '"runbook":' } } }]);
  expect(c.check.spec).toEqual({ url: 'http://127.0.0.1:4317/x', status: 200, contains: '"runbook":' });
  const [d] = normalizeCriteria([{ statement: 'no contains', check: { kind: 'http', spec: { url: 'http://127.0.0.1:4317/x' } } }]);
  expect('contains' in d.check.spec).toBe(false);
  const spec = (contains) => [{ statement: 'x', check: { kind: 'http', spec: { url: 'http://localhost/', contains } } }];
  expect(refusal(spec('a'.repeat(501))).error).toMatch(/entry 1: http check contains must be at most 500 chars/);
  expect(normalizeCriteria(spec('a'.repeat(500)))[0].check.spec.contains).toHaveLength(500);
  expect(refusal(spec('line one\nline two')).error).toMatch(/http check contains must not contain a newline/);
  expect(refusal(spec('')).error).toMatch(/http check contains must be a non-empty string/);
  expect(refusal([{ statement: 'x', check: { kind: 'http', spec: { url: 'http://localhost/', method: 'POST' } } }]).error).toMatch(/unknown key\(s\): method/);
});

test('duplicate ids are refused, including an explicit id colliding with a generated one', () => {
  const r = refusal([{ id: 'same', statement: 'a' }, { id: 'same', statement: 'b' }]);
  expect(r.index).toBe(2);
  expect(r.error).toMatch(/entry 2: duplicate id "same" \(already used by entry 1\)/);
  expect(refusal(['a', { id: 'ac-1', statement: 'b' }]).error).toMatch(/entry 2: duplicate id "ac-1"/);
});

test('anything else is refused with the criterion index', () => {
  expect(refusal([]).ok).toBe(false);
  expect(refusal('nope').ok).toBe(false);
  expect(refusal(['a', 42]).error).toMatch(/^criteria entry 2: must be a string or an object/);
  expect(refusal(['a', '']).error).toMatch(/^criteria entry 2: statement/);
  expect(refusal(['line\nbreak']).error).toMatch(/entry 1: statement must not contain a newline/);
  expect(refusal([{ id: 'Not Kebab', statement: 'x' }]).error).toMatch(/entry 1: id must be a kebab-case id/);
  expect(refusal([{ statement: 'x', check: { kind: 'shell', spec: 'rm -rf /' } }]).error).toMatch(/entry 1: check kind must be one of/);
  expect(refusal([{ statement: 'x', extra: true }]).error).toMatch(/entry 1: unknown key/);
  expect(refusal([{ check: { kind: 'manual' } }]).error).toMatch(/entry 1: statement/);
});

test('ipc schema accepts string and object entries, rejects unknown keys', () => {
  const base = { title: 't', goal: 'g', implementationNotes: 'n' };
  expect(schemas.schedulerCreatePrd.safeParse({ ...base, acceptanceCriteria: ['a', { id: 'x', statement: 'b', check: { kind: 'http', spec: { url: 'http://localhost/' } } }] }).success).toBe(true);
  expect(schemas.schedulerCreatePrd.safeParse({ ...base, acceptanceCriteria: [{ statement: 'b', nope: 1 }] }).success).toBe(false);
});

let cwd;
let outDir;
let remote;
beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-criteria-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  let nn = 700;
  remote = {
    async allocateParallelGroup() { return nn++; },
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

test('createPrd writes normalized criteria to frontmatter and renders ids in the body', async () => {
  const acceptanceCriteria = [
    'Plain line',
    { id: 'gate-green', statement: 'Tests pass', check: { kind: 'command', spec: 'timeout 60 npm test' } },
    { statement: 'Layout lists it', check: { kind: 'file', spec: { path: 'scripts/lib-layout.json', contains: 'prdCriteria' } } },
  ];
  const r = await createPrd(entry('structured', { acceptanceCriteria }), remote);
  expect(r.ok).toBe(true);
  const text = fs.readFileSync(path.join(outDir, r.filename), 'utf8');
  const line = text.match(/^criteria: (.*)$/m);
  expect(line).not.toBeNull();
  expect(JSON.parse(line[1])).toEqual(normalizeCriteria(acceptanceCriteria));
  expect(text).toContain('- [ ] ac-1: Plain line\n- [ ] gate-green: Tests pass\n- [ ] ac-3: Layout lists it\n');
  // Recognized frontmatter key: parsed into an array, re-emitted verbatim, edits re-serialize.
  const parsed = parsePrdFile(text);
  expect(parsed.frontmatter.criteria).toEqual(normalizeCriteria(acceptanceCriteria));
  expect(parsed.frontmatter.extras).toBeUndefined();
  expect(serializePrdFile(parsed.frontmatter, parsed.body).match(/^criteria: .*$/m)[0]).toBe(line[0]);
  parsed.frontmatter.criteria = [{ id: 'x', statement: 'y', check: { kind: 'manual' } }];
  expect(serializePrdFile(parsed.frontmatter, parsed.body)).toMatch(/^criteria: \[\{"id":"x","statement":"y","check":\{"kind":"manual"\}\}\]$/m);
});

test('createPrd refuses a bad structured criterion before allocating, naming the index', async () => {
  const r = await createPrd(entry('bad', { acceptanceCriteria: ['a', { statement: 'x', check: { kind: 'http', spec: 'http://example.com/' } }] }), remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(400);
  expect(r.error).toMatch(/^acceptance criteria entry 2: http check url must be loopback only/);
  expect(fs.readdirSync(outDir)).toEqual([]);
});
