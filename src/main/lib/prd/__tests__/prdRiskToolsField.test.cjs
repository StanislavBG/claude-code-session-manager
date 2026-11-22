/**
 * prdRiskToolsField.test.cjs — createPrd's optional `riskTools` input (tool-risk
 * rule strings a PRD is cleared to call): each entry must pass
 * toolRiskMarks.parseRule, at most 20, de-duplicated, written as an inline
 * `riskTools: [a, b]` frontmatter list that prdFrontmatter.cjs parses back —
 * including rules with parentheses, spaces, colons and commas.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdRiskToolsField.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd } = require('../prdCreate.cjs');
const { parsePrdFile, serializePrdFile, splitFrontmatter, RECOGNIZED_KEYS } = require('../prdFrontmatter.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');

let cwd;
let outDir;
let nextNn;
let allocations;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-risktools-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 500;
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

test('parsePrdFile reads a bare inline riskTools list', () => {
  expect(RECOGNIZED_KEYS.has('riskTools')).toBe(true);
  const { frontmatter } = parsePrdFile('---\ntitle: x\nriskTools: [a, b]\n---\nbody\n');
  expect(frontmatter.riskTools).toEqual(['a', 'b']);
  expect(frontmatter.extras).toBeUndefined();
});

test('riskTools round-trips through createPrd, de-duplicated, rules with parens/spaces/colons/commas intact', async () => {
  const riskTools = [
    'mcp__bilko-host__publish_static_project',
    'Bash(npm publish:*)',
    'Bash(echo a,b)',
    'mcp__bilko-host__publish_static_project',
  ];
  const r = await createPrd(entry('publish-site', { riskTools }), remote);
  expect(r.ok).toBe(true);
  const text = read(r.filename);
  expect(text.match(/^riskTools: .*$/gm)).toHaveLength(1);
  expect(text).toMatch(/^riskTools: \[mcp__bilko-host__publish_static_project, Bash\(npm publish:\*\), "Bash\(echo a,b\)"\]$/m);
  const expected = ['mcp__bilko-host__publish_static_project', 'Bash(npm publish:*)', 'Bash(echo a,b)'];
  const parsed = parsePrdFile(text);
  expect(parsed.frontmatter.riskTools).toEqual(expected);
  // riskTools sits after effort in emit order, and the line splitter still sees later keys.
  expect(splitFrontmatter(text).fm.agentType).toBe('dev-lead');
  // serialize → parse is stable and byte-identical when unchanged; an edit re-emits.
  const again = serializePrdFile(parsed.frontmatter, parsed.body);
  expect(again.match(/^riskTools: .*$/m)[0]).toBe(text.match(/^riskTools: .*$/m)[0]);
  expect(parsePrdFile(again).frontmatter.riskTools).toEqual(expected);
  const edited = serializePrdFile({ ...parsed.frontmatter, riskTools: ['Bash(git push, --force:*)', 'Bash(npm publish:*)'] }, parsed.body);
  expect(parsePrdFile(edited).frontmatter.riskTools).toEqual(['Bash(git push, --force:*)', 'Bash(npm publish:*)']);
  const effortOrder = serializePrdFile({ ...parsed.frontmatter, effort: 'high', _raw: undefined }, parsed.body);
  expect(effortOrder.indexOf('effort: high')).toBeLessThan(effortOrder.indexOf('riskTools:'));
});

test('omitted or empty riskTools writes no line', async () => {
  const a = await createPrd(entry('plain-prd'), remote);
  expect(a.ok).toBe(true);
  expect(read(a.filename)).not.toMatch(/^riskTools:/m);
  const b = await createPrd(entry('empty-risk', { riskTools: [] }), remote);
  expect(b.ok).toBe(true);
  expect(read(b.filename)).not.toMatch(/^riskTools:/m);
});

test('an entry parseRule rejects is refused naming the entry, before NN allocation', async () => {
  const r = await createPrd(entry('bad-rule', { riskTools: ['Bash(npm publish:*)', 'Read(secrets)'] }), remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(400);
  expect(r.error).toContain('Read(secrets)');
  expect(allocations).toBe(0);
});

test('more than 20 entries is refused', async () => {
  const many = Array.from({ length: 21 }, (_, i) => `mcp__srv__tool_${i}`);
  const r = await createPrd(entry('too-many', { riskTools: many }), remote);
  expect(r.ok).toBe(false);
  expect(r.status).toBe(400);
  expect(r.error).toMatch(/20/);
  expect(allocations).toBe(0);
});

test('the schedulerCreatePrd schema keeps riskTools and bounds it', () => {
  const base = { title: 't', goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n' };
  const ok = schemas.schedulerCreatePrd.safeParse({ ...base, riskTools: ['Bash(npm publish:*)'] });
  expect(ok.success).toBe(true);
  expect(ok.data.riskTools).toEqual(['Bash(npm publish:*)']);
  expect(schemas.schedulerCreatePrd.safeParse({ ...base, riskTools: Array(21).fill('mcp__a__b') }).success).toBe(false);
  expect(schemas.schedulerCreatePrd.safeParse({ ...base, riskTools: [''] }).success).toBe(false);
});
