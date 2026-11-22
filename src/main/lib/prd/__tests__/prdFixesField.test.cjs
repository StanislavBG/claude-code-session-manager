/**
 * prdFixesField.test.cjs — createPrd's optional `fixes` input ([{ prd, missKind,
 * reason }]): accepted entries are resolved to full NN slugs (same rule as
 * dependsOn) and written as a `fixes` frontmatter key that prdFrontmatter.cjs
 * parses back to the same array; every bad entry is refused naming its index.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdFixesField.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd, createPrdBatch } = require('../prdCreate.cjs');
const { parsePrdFile, serializePrdFile, splitFrontmatter } = require('../prdFrontmatter.cjs');

let cwd;
let outDir;
let nextNn;
let rows;
let remote;
let allocations;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-fixes-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 300;
  allocations = 0;
  rows = [
    { slug: '10-widget-api', epicId: 'epic-a', status: 'completed', planId: 'pl-aaa-111111' },
    { slug: '20-widget-api', epicId: 'epic-b', status: 'completed', planId: 'pl-bbb-222222' },
    { slug: '30-widget-ui', epicId: 'epic-a', status: 'completed', planId: 'pl-aaa-111111' },
    { slug: '40-repair-widget', epicId: 'epic-a', status: 'completed', planId: 'pl-aaa-111111' },
  ];
  remote = {
    async allocateParallelGroup() { allocations++; return nextNn++; },
    async readPrd() { return { ok: false }; },
    async writePrd(slug, body) {
      const p = path.join(outDir, `${slug}.md`);
      await fsp.writeFile(p, body);
      return { ok: true, path: p };
    },
    async listPrds() { return { prds: rows, total: rows.length, limit: rows.length, offset: 0, hasMore: false }; },
  };
});

const entry = (slug, o = {}) => ({
  title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g', cwd, sourcePromptId: 'epic-a',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const read = (f) => fs.readFileSync(path.join(outDir, f), 'utf8');
const fix = (prd, o = {}) => ({ prd, missKind: 'behavior-wrong', reason: 'validator passed a broken path', ...o });

test('accepted fixes are resolved to full NN slugs and round-trip through the frontmatter parser', async () => {
  const fixes = [
    fix('30-widget-ui', { missKind: 'not-checked-live', reason: 'UI "save" button never "clicked" live: it threw' }),
    fix('widget-api', { missKind: 'missing-test' }),
  ];
  const r = await createPrd(entry('repair-widget-save', { fixes }), remote);
  expect(r.ok).toBe(true);
  const text = read(r.filename);
  const { frontmatter } = parsePrdFile(text);
  expect(frontmatter.fixes).toEqual([
    { prd: '30-widget-ui', missKind: 'not-checked-live', reason: 'UI "save" button never "clicked" live: it threw' },
    // bare slug resolves to the same-Epic match (epic-a's 10-, not epic-b's higher 20-)
    { prd: '10-widget-api', missKind: 'missing-test', reason: 'validator passed a broken path' },
  ]);
  // One line, and the line-based splitter still sees every other key.
  expect(text.match(/^fixes: .*$/gm)).toHaveLength(1);
  expect(splitFrontmatter(text).fm.agentType).toBe('dev-lead');
  // A multi-Epic bare match warns naming fixes[1].
  expect(r.warnings.some((w) => /fixes\[1\]\.prd "widget-api" matches PRDs in more than one Epic/.test(w))).toBe(true);
  // serialize → parse is stable; the fixes line re-emits byte-identical when unchanged.
  const parsed = parsePrdFile(text);
  const again = serializePrdFile(parsed.frontmatter, parsed.body);
  expect(again.match(/^fixes: .*$/m)[0]).toBe(text.match(/^fixes: .*$/m)[0]);
  expect(parsePrdFile(again).frontmatter.fixes).toEqual(frontmatter.fixes);
  const edited = serializePrdFile({ ...parsed.frontmatter, fixes: [frontmatter.fixes[0]] }, parsed.body);
  expect(parsePrdFile(edited).frontmatter.fixes).toEqual([frontmatter.fixes[0]]);
});

test('a PRD without fixes has no fixes key', async () => {
  const r = await createPrd(entry('plain-prd'), remote);
  expect(r.ok).toBe(true);
  const text = read(r.filename);
  expect(text).not.toMatch(/^fixes:/m);
  expect(parsePrdFile(text).frontmatter).not.toHaveProperty('fixes');
});

test('fixes passes through the batch path too', async () => {
  const r = await createPrdBatch([entry('batch-repair', { fixes: [fix('widget-ui')] })], remote, { cwd, sourcePromptId: 'epic-a' });
  expect(r.ok).toBe(true);
  expect(parsePrdFile(read(r.prds[0].filename)).frontmatter.fixes)
    .toEqual([{ prd: '30-widget-ui', missKind: 'behavior-wrong', reason: 'validator passed a broken path' }]);
});

const refusals = [
  ['an unknown prd', [fix('30-widget-ui'), fix('no-such-prd')], /fixes\[1\]\.prd: "no-such-prd" does not resolve/],
  ['a bad missKind', [fix('30-widget-ui', { missKind: 'oops' })], /fixes\[0\]\.missKind: must be one of not-landed/],
  ['an empty reason', [fix('30-widget-ui'), fix('30-widget-ui', { reason: '  ' })], /fixes\[1\]\.reason: must be a non-empty string/],
  ['a multi-line reason', [fix('30-widget-ui', { reason: 'line one\nline two' })], /fixes\[0\]\.reason: must be one line/],
  ['a reason over 200 chars', [fix('30-widget-ui', { reason: 'x'.repeat(201) })], /fixes\[0\]\.reason: must be at most 200 chars/],
  ['the PRD naming itself', [fix('widget-ui'), fix('repair-widget-x')], /fixes\[1\]\.prd: "repair-widget-x" names this PRD itself/],
  ['an empty array', [], /fixes must have 1-20 entries \(got 0\)/],
  ['more than 20 entries', Array.from({ length: 21 }, () => fix('30-widget-ui')), /fixes must have 1-20 entries \(got 21\)/],
  ['a non-object entry', ['30-widget-ui'], /fixes\[0\]: must be an object/],
];

for (const [name, fixes, re] of refusals) {
  test(`refuses ${name}, naming the entry index, without burning an NN`, async () => {
    const r = await createPrd(entry('repair-widget-x', { fixes }), remote);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(re);
    expect(allocations).toBe(0);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
}

test('collects every bad entry into one error', async () => {
  const r = await createPrd(entry('repair-widget-x', { fixes: [fix('30-widget-ui', { missKind: 'nope' }), fix('30-widget-ui', { reason: '' })] }), remote);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/fixes\[0\]\.missKind/);
  expect(r.error).toMatch(/fixes\[1\]\.reason/);
});

test('an NN slug of an earlier same-name PRD is not the PRD naming itself', async () => {
  const r = await createPrd(entry('repair-widget', { fixes: [fix('40-repair-widget')] }), remote);
  expect(r.ok).toBe(true);
  expect(parsePrdFile(read(r.filename)).frontmatter.fixes[0].prd).toBe('40-repair-widget');
});

test('refuses fail-closed when the listing cannot be read', async () => {
  remote.listPrds = async () => { throw new Error('io'); };
  const r = await createPrd(entry('repair-widget-y', { fixes: [fix('30-widget-ui')] }), remote);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/fixes could not be checked/);
});

test('parsePrdFile drops a malformed fixes value', () => {
  const t = (v) => parsePrdFile(`---\ntitle: x\nfixes: ${v}\n---\nbody`).frontmatter.fixes;
  expect(t('[not json')).toBeUndefined();
  expect(t('{"prd":"1-a"}')).toBeUndefined();
  expect(t('[{"prd":"1-a","missKind":"other"}]')).toBeUndefined();
  expect(t('[{"prd":"1-a","missKind":"other","reason":"r"}]')).toEqual([{ prd: '1-a', missKind: 'other', reason: 'r' }]);
});
