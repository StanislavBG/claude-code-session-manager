/**
 * prdCreateBatch.test.cjs — createPrdBatch(): all-or-nothing multi-PRD create with
 * intra-batch dependsOn.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreateBatch.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { createPrdBatch } = require('../lib/prd/prdCreate.cjs');

let cwd;
let outDir;
let nextNn;
let remote;
let failOnWrite;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-batch-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  await fsp.mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.claude', 'agents', 'validator.md'), '---\nname: validator\n---\n');
  nextNn = 100;
  failOnWrite = null;
  let writes = 0;
  remote = {
    async allocateParallelGroup() { return nextNn++; },
    async readPrd() { return { ok: false }; },
    async writePrd(slug, body) {
      writes += 1;
      if (failOnWrite === writes) return { ok: false, error: 'disk full' };
      const p = path.join(outDir, `${slug}.md`);
      await fsp.writeFile(p, body);
      return { ok: true, path: p };
    },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
  };
});

const entry = (slug, o = {}) => ({
  title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const files = () => fs.readdirSync(outDir).sort();

test('returns prds in input order and writes bare intra-batch deps (earlier and later)', async () => {
  const r = await createPrdBatch([
    entry('step-b', { dependsOn: ['step-a'] }),
    entry('step-a'),
    entry('step-validate', { agentType: 'validator', dependsOn: ['step-a', 'step-b'] }),
  ], remote, { cwd });
  expect(r.ok).toBe(true);
  expect(r.applied).toBe(true);
  expect(r.prds.map((p) => p.slug)).toEqual(['step-b', 'step-a', 'step-validate']);
  expect(r.prds.map((p) => p.nn)).toEqual([100, 101, 102]);
  expect(r.prds[0].filename).toBe('100-step-b.md');
  expect(Array.isArray(r.prds[0].warnings)).toBe(true);
  expect(files()).toEqual(['100-step-b.md', '101-step-a.md', '102-step-validate.md']);
  const v = fs.readFileSync(path.join(outDir, '102-step-validate.md'), 'utf8');
  expect(v).toContain('dependsOn: [step-a, step-b]');
  expect(v).toContain('agentType: validator');
});

test('cycle inside batch writes nothing', async () => {
  const r = await createPrdBatch([
    entry('aa', { dependsOn: ['bb'] }), entry('bb', { dependsOn: ['cc'] }), entry('cc', { dependsOn: ['aa'] }),
  ], remote, { cwd });
  expect(r.ok).toBe(false);
  expect(r.applied).toBe(false);
  expect(r.errors[0].error).toMatch(/cycle/);
  expect(files()).toEqual([]);
  expect(nextNn).toBe(100);
});

test('duplicate slug, >40 entries, and one invalid entry write nothing', async () => {
  let r = await createPrdBatch([entry('dup'), entry('dup')], remote, { cwd });
  expect(r.ok).toBe(false);
  expect(r.errors[0].error).toMatch(/duplicate/);

  r = await createPrdBatch(Array.from({ length: 41 }, (_, i) => entry(`e-${i}`)), remote, { cwd });
  expect(r.ok).toBe(false);
  expect(r.errors[0].error).toMatch(/40/);

  r = await createPrdBatch([entry('good-one'), entry('bad-one', { dependsOn: ['nowhere'] })], remote, { cwd });
  expect(r.ok).toBe(false);
  expect(r.errors).toEqual([expect.objectContaining({ index: 1, slug: 'bad-one' })]);
  expect(files()).toEqual([]);
  expect(nextNn).toBe(100);
});

test('write failure on entry 2 of 3 removes files already written', async () => {
  failOnWrite = 2;
  const r = await createPrdBatch([entry('one'), entry('two'), entry('three')], remote, { cwd });
  expect(r.ok).toBe(false);
  expect(r.applied).toBe(false);
  expect(r.errors[0]).toMatchObject({ index: 1, slug: 'two' });
  expect(files()).toEqual([]);
  // allocator only moves forward: burned numbers are never reissued
  expect(nextNn).toBeGreaterThan(100);
});
