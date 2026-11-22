/**
 * prdCreate-cross-epic-duplicate.test.cjs — createPrd / createPrdBatch refuse a
 * PRD whose bare slug matches another Epic's PRD (the 2026-11-22 Self stall:
 * 1047-sm-contract-client and 1056-sm-contract-client from two Epics), unless
 * allowDuplicateOf lists every match; legacy no-epicId rows and scheduler-
 * internal mints (internalMint) are never refused.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdCreate-cross-epic-duplicate.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd, createPrdBatch, findCrossEpicDuplicates } = require('../prdCreate.cjs');
const { auditLogPath } = require('../../telemetry/auditLog.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');

const EPIC_A = 'portfolio-and-kiln-owner-decisions-in-session-ma-f25f3d71';
const EPIC_B = 'portfolio-use-session-manager-s-outside-contract-a23ae9c4';

let cwd;
let outDir;
let nextNn;
let rows;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cross-epic-dup-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 1047;
  rows = [];
  remote = {
    async allocateParallelGroup() { return nextNn++; },
    async readPrd() { return { ok: false }; },
    async writePrd(slug, body) {
      const p = path.join(outDir, `${slug}.md`);
      await fsp.writeFile(p, body);
      // Mirror listPrds: the written PRD now shows up with its Epic + status.
      const epicId = (/^sourcePromptId: (.+)$/m.exec(body) || [])[1] ?? null;
      rows.push({ slug, epicId, status: 'pending' });
      return { ok: true, path: p, epicId };
    },
    async listPrds() { return { prds: rows, total: rows.length, limit: rows.length, offset: 0, hasMore: false }; },
  };
});

const entry = (slug, o = {}) => ({
  title: `T ${slug}`, slug, estimateMinutes: 10, goal: 'g',
  acceptanceCriteria: ['a'], implementationNotes: 'n', ...o,
});
const written = () => fs.readdirSync(outDir).sort();
const auditRows = (kind) => {
  try {
    return fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.kind === kind || r.event === kind || r.type === kind);
  } catch { return []; }
};

test('1047/1056 sequence: the second Epic\'s create is refused naming the existing slug, Epic and status', async () => {
  const a = await createPrd(entry('sm-contract-client', { cwd, sourcePromptId: EPIC_A }), remote);
  expect(a.ok).toBe(true);
  expect(a.filename).toBe('1047-sm-contract-client.md');

  const b = await createPrd(entry('sm-contract-client', { cwd, sourcePromptId: EPIC_B }), remote);
  expect(b.ok).toBe(false);
  expect(b.status).toBe(409);
  expect(b.error).toContain('1047-sm-contract-client');
  expect(b.error).toContain(EPIC_A);
  expect(b.error).toContain('pending');
  expect(b.error).toContain('dependsOn');
  expect(b.error).toContain('allowDuplicateOf: [1047-sm-contract-client]');
  // Nothing written, no number burned.
  expect(written()).toEqual(['1047-sm-contract-client.md']);
  expect(nextNn).toBe(1048);
});

test('archived rows of any status count too', async () => {
  rows = [{ slug: '900-sm-contract-client', epicId: EPIC_A, status: 'cancelled' }];
  const b = await createPrd(entry('sm-contract-client', { cwd, sourcePromptId: EPIC_B }), remote);
  expect(b.status).toBe(409);
  expect(b.error).toContain('900-sm-contract-client (Epic ' + EPIC_A + ', status cancelled)');
});

test('allowDuplicateOf listing every match lets it through and writes an audit row', async () => {
  await createPrd(entry('sm-contract-client', { cwd, sourcePromptId: EPIC_A }), remote);
  rows.push({ slug: '1000-sm-contract-client', epicId: 'epic-c', status: 'completed' });

  const partial = await createPrd(entry('sm-contract-client', {
    cwd, sourcePromptId: EPIC_B, allowDuplicateOf: ['1047-sm-contract-client'],
  }), remote);
  expect(partial.status).toBe(409);
  expect(partial.error).toContain('1000-sm-contract-client');

  const b = await createPrd(entry('sm-contract-client', {
    cwd, sourcePromptId: EPIC_B, allowDuplicateOf: ['1047-sm-contract-client', '1000-sm-contract-client'],
  }), remote);
  expect(b.ok).toBe(true);
  expect(b.filename).toBe('1048-sm-contract-client.md');
  // allowDuplicateOf is a create-time override, never frontmatter.
  expect(fs.readFileSync(path.join(outDir, b.filename), 'utf8')).not.toContain('allowDuplicateOf');
  const audit = auditRows('prd_create_duplicate_allowed').filter((r) => JSON.stringify(r).includes(cwd));
  expect(audit.length).toBe(1);
  expect(JSON.stringify(audit[0])).toContain('1048-sm-contract-client');
  expect(JSON.stringify(audit[0])).toContain('1047-sm-contract-client');
});

test('a same bare slug in a no-epicId legacy row is not refused', async () => {
  rows = [{ slug: '12-sm-contract-client', epicId: null, status: 'completed' }];
  const b = await createPrd(entry('sm-contract-client', { cwd, sourcePromptId: EPIC_B }), remote);
  expect(b.ok).toBe(true);
  expect(findCrossEpicDuplicates('sm-contract-client', EPIC_B, rows)).toEqual([]);
});

test('an internalMint sweep create is not refused', async () => {
  const slug = 'validate-sweep-202610250052';
  rows = [{ slug: `500-${slug}`, epicId: EPIC_A, status: 'completed' }];
  const refused = await createPrd(entry(slug, { cwd, sourcePromptId: EPIC_B }), remote);
  expect(refused.status).toBe(409);
  const b = await createPrd(entry(slug, { cwd, sourcePromptId: EPIC_B }), remote, { internalMint: true });
  expect(b.ok).toBe(true);
});

test('batch path refuses all-or-nothing with per-entry errors and status 409', async () => {
  rows = [{ slug: '1047-sm-contract-client', epicId: EPIC_A, status: 'running' }];
  const r = await createPrdBatch([
    entry('other-step'),
    entry('sm-contract-client'),
  ], remote, { cwd, sourcePromptId: EPIC_B });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].index).toBe(1);
  expect(r.errors[0].error).toContain('1047-sm-contract-client');
  expect(r.errors[0].error).toContain(EPIC_A);
  expect(r.errors[0].error).toContain('running');
  expect(written()).toEqual([]);

  const ok = await createPrdBatch([
    entry('other-step'),
    entry('sm-contract-client', { allowDuplicateOf: ['1047-sm-contract-client'] }),
  ], remote, { cwd, sourcePromptId: EPIC_B });
  expect(ok.ok).toBe(true);
  expect(written()).toHaveLength(2);
});

test('schemas accept allowDuplicateOf as exact NN slugs on single and batch creates', () => {
  const single = entry('x', { allowDuplicateOf: ['1047-sm-contract-client'] });
  expect(schemas.schedulerCreatePrd.parse(single).allowDuplicateOf).toEqual(['1047-sm-contract-client']);
  expect(() => schemas.schedulerCreatePrd.parse(entry('x', { allowDuplicateOf: ['sm-contract-client'] }))).toThrow();
  expect(schemas.adminCreatePrds.parse({ prds: [single] }).prds[0].allowDuplicateOf).toEqual(['1047-sm-contract-client']);
});
