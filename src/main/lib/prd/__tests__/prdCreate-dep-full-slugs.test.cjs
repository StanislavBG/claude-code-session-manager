/**
 * prdCreate-dep-full-slugs.test.cjs — createPrd / createPrdBatch store every
 * dependsOn entry as the full NN slug it resolved to (batch sibling > same Epic >
 * others), warn when a bare dep matches PRDs in more than one Epic, and never
 * inherit a planId from another Epic's PRD.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdCreate-dep-full-slugs.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd, createPrdBatch } = require('../prdCreate.cjs');
const { resolveInheritedPlanId } = require('../prdDisposition.cjs');

let cwd;
let outDir;
let nextNn;
let rows;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-dep-full-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 200;
  rows = [];
  remote = {
    async allocateParallelGroup() { return nextNn++; },
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
  title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const read = (f) => fs.readFileSync(path.join(outDir, f), 'utf8');
const planIdOf = (text) => (/^planId: (.+)$/m.exec(text) || [])[1];

test('bare sibling dep in a batch is stored as the sibling\'s allocated NN slug, even over an existing same-name PRD', async () => {
  rows = [{ slug: '50-step-a', epicId: 'epic-a', sourcePromptId: 'epic-a', status: 'completed', planId: 'pl-old-aaaaaa' }];
  const r = await createPrdBatch([
    entry('step-b', { dependsOn: ['step-a'] }),
    entry('step-a'),
    entry('step-c', { dependsOn: ['step-a', 'step-b'] }),
  ], remote, { cwd, sourcePromptId: 'epic-a' });
  expect(r.ok).toBe(true);
  expect(r.prds.map((p) => p.filename)).toEqual(['200-step-b.md', '201-step-a.md', '202-step-c.md']);
  expect(read('200-step-b.md')).toContain('dependsOn: [201-step-a]');
  expect(read('202-step-c.md')).toContain('dependsOn: [201-step-a, 200-step-b]');
  // Sibling deps never inherit the existing same-name PRD's plan.
  expect(planIdOf(read('200-step-b.md'))).not.toBe('pl-old-aaaaaa');
  expect(new Set(['200-step-b.md', '201-step-a.md', '202-step-c.md'].map((f) => planIdOf(read(f)))).size).toBe(1);
});

test('single create stores a bare dep as the same-Epic full slug', async () => {
  rows = [
    { slug: '10-sm-contract-client', epicId: 'epic-a', status: 'completed', planId: 'pl-aaa-111111' },
    { slug: '20-sm-contract-client', epicId: 'epic-a', status: 'completed', planId: 'pl-aaa-111111' },
  ];
  const r = await createPrd(entry('consumer', { cwd, sourcePromptId: 'epic-a', dependsOn: ['sm-contract-client'] }), remote);
  expect(r.ok).toBe(true);
  const text = read('200-consumer.md');
  expect(text).toContain('dependsOn: [20-sm-contract-client]');
  expect(planIdOf(text)).toBe('pl-aaa-111111');
  expect(r.warnings.some((w) => /more than one Epic/.test(w))).toBe(false);
});

test('cross-Epic bare match warns naming the candidates and the one chosen; planId not inherited across Epics', async () => {
  rows = [
    { slug: '1047-sm-contract-client', epicId: 'epic-a', status: 'completed', planId: 'pl-aaa-111111' },
    { slug: '1056-sm-contract-client', epicId: 'epic-b', status: 'completed', planId: 'pl-bbb-222222' },
  ];
  const r = await createPrd(entry('consumer', { cwd, sourcePromptId: 'epic-a', dependsOn: ['sm-contract-client'] }), remote);
  expect(r.ok).toBe(true);
  const text = read('200-consumer.md');
  expect(text).toContain('dependsOn: [1047-sm-contract-client]');
  expect(planIdOf(text)).toBe('pl-aaa-111111');
  const w = r.warnings.find((x) => /more than one Epic/.test(x));
  expect(w).toBeTruthy();
  expect(w).toContain('1047-sm-contract-client');
  expect(w).toContain('1056-sm-contract-client');
  expect(w).toContain('Stored as "1047-sm-contract-client"');

  // A dep living only in another Epic resolves (and warns nothing) but donates no planId.
  rows = [{ slug: '1056-other-thing', epicId: 'epic-b', status: 'completed', planId: 'pl-bbb-222222' }];
  const r2 = await createPrd(entry('consumer-two', { cwd, sourcePromptId: 'epic-a', dependsOn: ['other-thing'] }), remote);
  expect(r2.ok).toBe(true);
  const text2 = read('201-consumer-two.md');
  expect(text2).toContain('dependsOn: [1056-other-thing]');
  expect(planIdOf(text2)).not.toBe('pl-bbb-222222');
});

test('batch planId is not inherited from another Epic\'s dep', async () => {
  rows = [{ slug: '1056-shared', epicId: 'epic-b', status: 'completed', planId: 'pl-bbb-222222' }];
  const r = await createPrdBatch([
    entry('one', { dependsOn: ['shared'] }),
    entry('two', { dependsOn: ['one'] }),
  ], remote, { cwd, sourcePromptId: 'epic-a' });
  expect(r.ok).toBe(true);
  expect(read('200-one.md')).toContain('dependsOn: [1056-shared]');
  expect(read('201-two.md')).toContain('dependsOn: [200-one]');
  expect(planIdOf(read('200-one.md'))).not.toBe('pl-bbb-222222');
});

test('resolveInheritedPlanId with epicId only reads that Epic\'s rows', () => {
  const r = [
    { slug: '1-a', epicId: 'epic-b', planId: 'pl-bbb-222222' },
    { slug: '2-a', sourcePromptId: 'epic-a', planId: 'pl-aaa-111111' },
    { slug: '3-b', epicId: 'epic-b', planId: 'pl-bbb-222222' },
  ];
  expect(resolveInheritedPlanId(['a'], r, { epicId: 'epic-a' }).planId).toBe('pl-aaa-111111');
  expect(resolveInheritedPlanId(['3-b'], r, { epicId: 'epic-a' }).planId).toBeNull();
  expect(resolveInheritedPlanId(['3-b'], r).planId).toBe('pl-bbb-222222');
});
