/**
 * updatePrdStructured.test.cjs — updatePrd accepts gate/files/acceptanceCriteria
 * and applies them through applyStructuredPrdPatch; adminUpdatePrd is strict.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/updatePrdStructured.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let config;
let schemas;
let buildPrdBody;
let resolveGate;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-upd-structured-home-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  config = require('../config.cjs');
  schemas = require('../ipcSchemas.cjs').schemas;
  ({ buildPrdBody } = require('../lib/prd/prdCreate.cjs'));
  ({ resolveGate } = require('../lib/scheduler/definitionOfDone.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeFixture(slug) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-upd-structured-'));
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), `${JSON.stringify({ cwd })}\n`);
  config.addAllowedRoot(cwd);
  const ops = path.join(cwd, 'session-manager-operations');
  const prdsDir = path.join(ops, 'scheduler', 'epics', 'test-epic-1', 'prds');
  const stateDir = path.join(ops, 'scheduler', 'state');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [] }), 'utf8');
  queueStore.bustCwdCache();
  const body = buildPrdBody({
    title: 'T', goal: 'Do the thing.',
    acceptanceCriteria: ['first works'],
    implementationNotes: 'Read src/a.cjs.',
    outOfScope: ['nothing'],
    files: ['src/a.cjs'],
    gate: ['timeout 60 npx vitest run src/a.test.cjs'],
  });
  const file = path.join(prdsDir, `${slug}.md`);
  fs.writeFileSync(file, `---\ntitle: T\ncwd: ${cwd}\nestimateMinutes: 10\ncreatedVia: scheduler-api\n---\n\n${body}`, 'utf8');
  return { cwd, file };
}

test('gate-only update is re-rendered and reads back', async () => {
  const { cwd, file } = makeFixture('7-gate-only');
  try {
    const gate = ['timeout 30 npm run typecheck'];
    const r = await scheduler.remote.updatePrd({ slug: '7-gate-only', cwd, gate });
    expect(r.ok).toBe(true);
    const resolved = resolveGate(fs.readFileSync(file, 'utf8'));
    expect(resolved.source).toBe('explicit');
    expect(JSON.stringify(resolved.sequence)).toContain('npm run typecheck');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('src/a.test.cjs');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('invalid gate is refused and the file is unchanged', async () => {
  const { cwd, file } = makeFixture('7-bad-gate');
  try {
    const before = fs.readFileSync(file, 'utf8');
    const r = await scheduler.remote.updatePrd({ slug: '7-bad-gate', cwd, gate: [] });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('body together with a structured field is refused', async () => {
  const { cwd, file } = makeFixture('7-body-gate');
  try {
    const before = fs.readFileSync(file, 'utf8');
    const r = await scheduler.remote.updatePrd({ slug: '7-body-gate', cwd, body: '# Goal\nX\n', gate: ['timeout 5 true'] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not both/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('adminUpdatePrd rejects an unknown key and accepts the structured fields', () => {
  expect(schemas.adminUpdatePrd.safeParse({ slug: 'a-b', gate: ['timeout 5 true'], bogus: 1 }).success).toBe(false);
  expect(schemas.adminUpdatePrd.safeParse({ slug: 'a-b', gate: ['timeout 5 true'], files: ['src/a.cjs'], acceptanceCriteria: ['x'] }).success).toBe(true);
  expect(schemas.adminUpdatePrd.safeParse({ slug: 'a-b', body: 'x', gate: ['timeout 5 true'] }).success).toBe(false);
});
