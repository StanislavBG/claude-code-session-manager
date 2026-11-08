/**
 * competitiveMatrix.test.cjs — Competitor matrix data model: schema, referential
 * validation, size cap, JSON Schema, missing-features order, never-throwing reader.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/competitiveMatrix.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const {
  CompetitiveMatrixSchema, validateMatrix, matrixJsonSchema, missingFeatures,
  matrixPaths, readMatrix, MAX_MATRIX_BYTES,
} = require('../competitiveMatrix.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTmpCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-competitive-matrix-'));
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  return dir;
}

const T = '2026-11-08T12:00:00.000Z';
const COMPETITORS = ['claude-desktop', 'opencode', 'cursor', 'aider'];

function support(selfStatus = 'yes') {
  const s = { self: { status: selfStatus, note: '', sourceIds: [] } };
  for (const c of COMPETITORS) s[c] = { status: 'yes', note: 'n', sourceIds: ['src-1'] };
  return s;
}

function feature(id, title, selfStatus, priority) {
  return {
    id, groupId: 'sessions', title, description: `${title} description`,
    sentiment: { signal: 'loved', summary: 'users like it', sourceIds: ['src-1'] },
    support: support(selfStatus),
    recommendation: { priority, rationale: 'r', sessionGoal: 'g' },
    firstSeenAt: T, updatedAt: T,
  };
}

function buildMatrix() {
  return {
    schemaVersion: 1,
    product: { id: 'self', name: 'Session Manager', summary: 'cockpit' },
    competitors: COMPETITORS.map((id) => ({
      id, name: id, url: `https://example.com/${id}`, category: 'harness', chosenBy: 'user', why: 'popular',
    })),
    groups: [
      { id: 'sessions', title: 'Sessions', description: '' },
      { id: 'tools', title: 'Tools', description: 'tooling' },
    ],
    features: [
      feature('f-yes', 'Has it', 'yes', 'none'),
      feature('f-p2', 'Bravo', 'no', 'P2'),
      feature('f-p0b', 'Zulu', 'partial', 'P0'),
      feature('f-p0a', 'Alpha', 'no', 'P0'),
      feature('f-none', 'Echo', 'no', 'none'),
      feature('f-p3', 'Delta', 'partial', 'P3'),
      feature('f-p1', 'Charlie', 'unknown', 'P1'),
    ],
    sources: [{
      id: 'src-1', url: 'https://example.com/post', title: 'Post', publisher: 'Ex',
      publishedAt: null, retrievedAt: T, kind: 'blog',
    }],
    runs: [{ at: T, model: 'opus', competitors: ['Claude Desktop'], added: ['f-yes'], changed: [], notes: '' }],
    updatedAt: T,
  };
}

function expectFail(m, pathFragment) {
  const r = validateMatrix(m);
  expect(r.ok).toBe(false);
  expect(r.error).not.toMatch(/\n/);
  expect(r.error.length).toBeLessThanOrEqual(300);
  expect(r.error).toContain(pathFragment);
  return r.error;
}

test('exports', () => {
  expect(MAX_MATRIX_BYTES).toBe(1048576);
  expect(typeof CompetitiveMatrixSchema.safeParse).toBe('function');
  expect(typeof matrixPaths).toBe('function');
});

test('valid fixture with 4 competitors passes', () => {
  const r = validateMatrix(buildMatrix());
  expect(r.ok).toBe(true);
  expect(r.matrix.competitors).toHaveLength(4);
});

test('duplicate ids fail', () => {
  for (const list of ['competitors', 'groups', 'features', 'sources']) {
    const m = buildMatrix();
    m[list].push(JSON.parse(JSON.stringify(m[list][0])));
    if (list === 'competitors') m.competitors.splice(1, 1); // stay within the 1..4 cap
    expectFail(m, `${list}[${m[list].length - 1}].id`);
  }
});

test("competitor id 'self' fails", () => {
  const m = buildMatrix();
  m.competitors[3].id = 'self';
  expectFail(m, 'competitors[3].id');
});

test('feature.groupId not in groups fails', () => {
  const m = buildMatrix();
  m.features[1].groupId = 'nope';
  expectFail(m, 'features[1].groupId');
});

test('feature.support missing a product key fails', () => {
  const m = buildMatrix();
  delete m.features[2].support.opencode;
  expect(expectFail(m, 'features[2].support')).toContain('missing opencode');
});

test('feature.support adding a product key fails', () => {
  const m = buildMatrix();
  m.features[0].support.extra = { status: 'no', note: '', sourceIds: [] };
  expect(expectFail(m, 'features[0].support')).toContain('unexpected extra');
});

test('unknown sourceIds fail (sentiment and support)', () => {
  const a = buildMatrix();
  a.features[0].sentiment.sourceIds = ['ghost'];
  expectFail(a, 'features[0].sentiment.sourceIds[0]');
  const b = buildMatrix();
  b.features[1].support.cursor.sourceIds = ['src-1', 'ghost'];
  expectFail(b, 'features[1].support.cursor.sourceIds[1]');
});

test('non-https URL fails', () => {
  const a = buildMatrix();
  a.sources[0].url = 'http://example.com/post';
  expectFail(a, 'sources[0].url');
  const b = buildMatrix();
  b.competitors[0].url = 'http://example.com';
  expectFail(b, 'competitors[0].url');
});

test('size over MAX_MATRIX_BYTES fails', () => {
  const m = buildMatrix();
  m.padding = 'x'.repeat(MAX_MATRIX_BYTES);
  expectFail(m, '(root)');
  expect(validateMatrix(m).error).toMatch(/cap/);
});

test('long error text is one line, capped at 300 chars', () => {
  const m = buildMatrix();
  m.features[0].groupId = 'a'.repeat(64);
  const err = expectFail(m, 'features[0].groupId');
  expect(err.length).toBeLessThanOrEqual(300);
});

test('missingFeatures: no/partial only, P0..P3, none, then title', () => {
  const out = missingFeatures(buildMatrix()).map((f) => f.id);
  expect(out).toEqual(['f-p0a', 'f-p0b', 'f-p2', 'f-p3', 'f-none']);
});

test('matrixJsonSchema shape', () => {
  const s = matrixJsonSchema();
  expect(s.$id).toBe('session-manager/competitive-matrix.v1');
  for (const k of ['schemaVersion', 'product', 'competitors', 'groups', 'features', 'sources', 'runs', 'updatedAt']) {
    expect(s.required).toContain(k);
  }
  expect(s.type).toBe('object');
  expect(s.properties.competitors.maxItems).toBe(4);
});

test('readMatrix: absent, invalid, unreadable JSON, valid', async () => {
  const cwd = await mkTmpCwd();
  const paths = matrixPaths(cwd);
  expect(paths.matrix).toBe(path.join(cwd, 'session-manager-operations', 'project-pages', 'matrix', 'matrix.json'));
  expect(paths.schema.endsWith('matrix.schema.json')).toBe(true);
  expect(paths.history.endsWith(path.join('matrix', 'history'))).toBe(true);

  expect(await readMatrix(cwd)).toEqual({ matrix: null, error: null, path: paths.matrix });

  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.matrix, '{not json');
  let r = await readMatrix(cwd);
  expect(r.matrix).toBeNull();
  expect(typeof r.error).toBe('string');
  expect(r.path).toBe(paths.matrix);

  const bad = buildMatrix();
  bad.features[0].groupId = 'nope';
  fs.writeFileSync(paths.matrix, JSON.stringify(bad));
  r = await readMatrix(cwd);
  expect(r.matrix).toBeNull();
  expect(r.error).toContain('features[0].groupId');

  fs.rmSync(paths.matrix);
  fs.mkdirSync(paths.matrix); // EISDIR — unreadable, not absent
  r = await readMatrix(cwd);
  expect(r.matrix).toBeNull();
  expect(typeof r.error).toBe('string');
  fs.rmdirSync(paths.matrix);

  fs.writeFileSync(paths.matrix, JSON.stringify(buildMatrix()));
  r = await readMatrix(cwd);
  expect(r.error).toBeNull();
  expect(r.matrix.product.id).toBe('self');
  expect(r.path).toBe(paths.matrix);
});

test('readMatrix: ephemeral cwd returns path null and never throws', async () => {
  expect(matrixPaths(os.tmpdir())).toBeNull();
  expect(await readMatrix(os.tmpdir())).toEqual({ matrix: null, error: null, path: null });
  const r = await readMatrix('relative/path');
  expect(r.matrix).toBeNull();
  expect(r.path).toBeNull();
});
