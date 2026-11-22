/**
 * prdCreate-plan-records.test.cjs — createPrd auto-declares a PRD whose every
 * files entry is under session-manager-operations/plan-records/ as
 * artifact-only (deliverable: artifact, artifactPaths = those files), and
 * leaves a mixed or explicitly-declared PRD alone.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdCreate-plan-records.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { createPrd } = require('../prdCreate.cjs');

const REC = 'session-manager-operations/plan-records/epic-a/validate-x.md';
const REC2 = 'session-manager-operations/plan-records/epic-a/validate-y.md';

let cwd;
let outDir;
let nextNn;
let remote;

beforeEach(async () => {
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-plan-rec-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  config.addAllowedRoot(cwd);
  nextNn = 300;
  remote = {
    async allocateParallelGroup() { return nextNn++; },
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
  acceptanceCriteria: [`Record written at ${REC}`], implementationNotes: 'n', gate: ['none'], ...o,
});
const read = (f) => fs.readFileSync(path.join(outDir, f), 'utf8');

test('every files entry under plan-records/ auto-declares artifact-only', async () => {
  const r = await createPrd(entry('rec-only', { files: [REC, REC2] }), remote);
  expect(r.ok).toBe(true);
  const text = read('300-rec-only.md');
  expect(text).toMatch(/^deliverable: artifact$/m);
  expect(text).toContain(`artifactPaths: [${REC}, ${REC2}]`);
  expect((r.warnings || []).some((w) => /plan-records/.test(w) && /gitignored/.test(w))).toBe(false);
});

test('a PRD mixing code files and a plan-records path is left unchanged', async () => {
  const r = await createPrd(entry('mixed', { files: ['src/a.cjs', REC] }), remote);
  expect(r.ok).toBe(true);
  const text = read('300-mixed.md');
  expect(text).not.toMatch(/^deliverable:/m);
  expect(text).not.toMatch(/^artifactPaths:/m);
});

test('an explicit declaration is kept as given', async () => {
  const other = 'session-manager-operations/plan-records/epic-a/other.md';
  const r = await createPrd(entry('explicit', { files: [REC], deliverable: 'artifact', artifactPaths: [other] }), remote);
  expect(r.ok).toBe(true);
  const text = read('300-explicit.md');
  expect(text).toMatch(/^deliverable: artifact$/m);
  expect(text).toContain(`artifactPaths: [${other}]`);
  expect(text).not.toContain(`artifactPaths: [${REC}]`);
});

test('no files list is left unchanged', async () => {
  const r = await createPrd(entry('nofiles'), remote);
  expect(r.ok).toBe(true);
  expect(read('300-nofiles.md')).not.toMatch(/^deliverable:/m);
});
