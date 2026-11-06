/**
 * prdCreateDevelopLoopOff.test.cjs — createPrd/createPrdBatch refuse (409) a PRD whose
 * Epic row has developLoop === false; rows without the key are unaffected.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreateDevelopLoopOff.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { activeIndexPath } = require('../lib/epic/epicMint.cjs');
const { createPrd, createPrdBatch } = require('../lib/prd/prdCreate.cjs');

let cwd;
let outDir;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-devloop-off-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  const idx = activeIndexPath(cwd);
  await fsp.mkdir(path.dirname(idx), { recursive: true });
  const row = (id, extra = {}) => ({ id, status: 'active', title: id, ...extra });
  await fsp.writeFile(idx, JSON.stringify({
    sessions: {
      'epic-off': row('epic-off', { developLoop: false }),
      'epic-on': row('epic-on', { developLoop: true }),
      'epic-plain': row('epic-plain'),
    },
    events: {},
  }));
  let nn = 100;
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

const body = (o = {}) => ({
  title: 'T one', cwd, estimateMinutes: 10, goal: 'g',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});

test('refuses with 409 for a develop-loop-off Epic and writes nothing', async () => {
  const r = await createPrd(body({ sourcePromptId: 'epic-off' }), remote);
  expect(r.ok).toBe(false);
  expect(r.applied).toBe(false);
  expect(r.status).toBe(409);
  expect(r.error).toContain('epic-off');
  expect(r.error).toContain('develop loop off');
  expect(fs.readdirSync(outDir)).toEqual([]);
});

test('Epic rows without developLoop, or with true, are unaffected', async () => {
  const a = await createPrd(body({ sourcePromptId: 'epic-plain' }), remote);
  expect(a.ok).toBe(true);
  const b = await createPrd(body({ title: 'T two', sourcePromptId: 'epic-on' }), remote);
  expect(b.ok).toBe(true);
  expect(fs.readdirSync(outDir).length).toBe(2);
});

test('batch for a develop-loop-off Epic writes nothing and returns per-entry errors', async () => {
  const entry = (slug) => ({
    title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
  });
  const r = await createPrdBatch([entry('step-a'), entry('step-b')], remote, { cwd, sourcePromptId: 'epic-off' });
  expect(r.ok).toBe(false);
  expect(r.errors.length).toBe(2);
  expect(r.errors[0].error).toContain('develop loop off');
  expect(fs.readdirSync(outDir)).toEqual([]);
});
