'use strict';

/**
 * competitiveMatrix.cjs — data model for the Project Home "Competitor matrix"
 * tool. The matrix is a local, schema-checked JSON file
 * (`project-pages/matrix/matrix.json`) that the research macro reads at the
 * start of every run so it never starts cold: my product ('self') + 1..4
 * competitors, logical feature groups, features with per-product support,
 * user sentiment and a recommendation, cited sources, and run history.
 *
 * This module is read-only: schema, referential validation, derived JSON
 * Schema, path helpers, a never-throwing reader and a missing-features helper.
 * Writing lives elsewhere (matrixStore.cjs, writer 'project-home').
 */

const fsp = require('node:fs/promises');
const { z } = require('zod/v4');
const { opsPath } = require('../opsOwnership.cjs');

const MAX_MATRIX_BYTES = 1048576;
const SCHEMA_ID = 'session-manager/competitive-matrix.v1';
const ERROR_MAX = 300;

const ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const Status = z.enum(['yes', 'partial', 'no', 'unknown']);
const HttpsUrl = z.string().max(500).url()
  .refine((s) => s.startsWith('https://'), { message: 'URL must start with https://' });
const DateTime = z.iso.datetime();
const SourceIds = z.array(ID).max(20);

const ProductSchema = z.object({
  id: z.literal('self'),
  name: z.string().min(1).max(80),
  summary: z.string().max(600),
}).strict();

const CompetitorSchema = z.object({
  id: ID,
  name: z.string().min(1).max(80),
  url: HttpsUrl.optional(),
  category: z.string().max(60),
  chosenBy: z.enum(['user', 'auto']),
  why: z.string().max(600),
}).strict();

const GroupSchema = z.object({
  id: ID,
  title: z.string().min(1).max(80),
  description: z.string().max(400),
}).strict();

const SupportSchema = z.object({
  status: Status,
  note: z.string().max(400),
  sourceIds: SourceIds,
}).strict();

const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'none'];

const FeatureSchema = z.object({
  id: ID,
  groupId: ID,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  sentiment: z.object({
    signal: z.enum(['loved', 'requested', 'mixed', 'complained', 'none']),
    summary: z.string().max(600),
    sourceIds: SourceIds,
  }).strict(),
  support: z.record(ID, SupportSchema),
  recommendation: z.object({
    priority: z.enum(PRIORITIES),
    rationale: z.string().max(1000),
    sessionGoal: z.string().max(2000),
  }).strict(),
  firstSeenAt: DateTime,
  updatedAt: DateTime,
}).strict();

const SourceSchema = z.object({
  id: ID,
  url: HttpsUrl,
  title: z.string().min(1).max(200),
  publisher: z.string().max(80),
  publishedAt: z.string().max(40).nullable(),
  retrievedAt: DateTime,
  kind: z.enum(['announcement', 'blog', 'docs', 'changelog', 'forum', 'review', 'social', 'repo']),
}).strict();

const RunSchema = z.object({
  at: DateTime,
  model: z.string().max(60),
  competitors: z.array(z.string().max(80)).max(4),
  added: z.array(ID).max(300),
  changed: z.array(ID).max(300),
  notes: z.string().max(1000),
}).strict();

const CompetitiveMatrixSchema = z.object({
  schemaVersion: z.literal(1),
  product: ProductSchema,
  competitors: z.array(CompetitorSchema).min(1).max(4),
  groups: z.array(GroupSchema).min(1).max(30),
  features: z.array(FeatureSchema).max(300),
  sources: z.array(SourceSchema).max(600),
  runs: z.array(RunSchema).min(1).max(200),
  updatedAt: DateTime,
}).strict();

function fail(pathStr, message) {
  const text = `${pathStr || '(root)'}: ${message}`.replace(/\s+/g, ' ').trim();
  return { ok: false, error: text.slice(0, ERROR_MAX) };
}

function fmtPath(parts) {
  return parts.reduce((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), '');
}

function dupId(list, name) {
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const id = list[i].id;
    if (seen.has(id)) return fail(`${name}[${i}].id`, `duplicate id '${id}'`);
    seen.add(id);
  }
  return null;
}

/** Cross-reference checks the zod shape cannot express. */
function referentialError(m) {
  for (const name of ['competitors', 'groups', 'features', 'sources']) {
    const err = dupId(m[name], name);
    if (err) return err;
  }
  for (let i = 0; i < m.competitors.length; i++) {
    if (m.competitors[i].id === 'self') {
      return fail(`competitors[${i}].id`, "'self' is reserved for the product");
    }
  }
  const groupIds = new Set(m.groups.map((g) => g.id));
  const sourceIds = new Set(m.sources.map((s) => s.id));
  const expectedKeys = ['self', ...m.competitors.map((c) => c.id)].sort();
  const checkSources = (ids, at) => {
    for (let k = 0; k < ids.length; k++) {
      if (!sourceIds.has(ids[k])) return fail(`${at}.sourceIds[${k}]`, `unknown source '${ids[k]}'`);
    }
    return null;
  };
  for (let i = 0; i < m.features.length; i++) {
    const f = m.features[i];
    const at = `features[${i}]`;
    if (!groupIds.has(f.groupId)) return fail(`${at}.groupId`, `unknown group '${f.groupId}'`);
    const keys = Object.keys(f.support).sort();
    if (keys.length !== expectedKeys.length || keys.some((k, j) => k !== expectedKeys[j])) {
      const missing = expectedKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !expectedKeys.includes(k));
      return fail(`${at}.support`, `keys must be exactly [${expectedKeys.join(', ')}]`
        + (missing.length ? `; missing ${missing.join(', ')}` : '')
        + (extra.length ? `; unexpected ${extra.join(', ')}` : ''));
    }
    let err = checkSources(f.sentiment.sourceIds, `${at}.sentiment`);
    if (err) return err;
    for (const key of keys) {
      err = checkSources(f.support[key].sourceIds, `${at}.support.${key}`);
      if (err) return err;
    }
  }
  return null;
}

/** validateMatrix(value) → { ok: true, matrix } | { ok: false, error }. Never throws. */
function validateMatrix(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    return fail('(root)', `not serializable: ${e && e.message ? e.message : e}`);
  }
  if (json === undefined) return fail('(root)', 'expected an object');
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_MATRIX_BYTES) {
    return fail('(root)', `matrix is ${bytes} bytes, over the ${MAX_MATRIX_BYTES}-byte cap`);
  }
  const parsed = CompetitiveMatrixSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(fmtPath(issue.path), issue.message);
  }
  const err = referentialError(parsed.data);
  if (err) return err;
  return { ok: true, matrix: parsed.data };
}

/** JSON Schema for the matrix, written beside it so the macro can read the contract. */
function matrixJsonSchema() {
  return { $id: SCHEMA_ID, ...z.toJSONSchema(CompetitiveMatrixSchema) };
}

/** Features my product lacks or only partly has — P0..P3, none, then title. */
function missingFeatures(matrix) {
  const rank = (f) => PRIORITIES.indexOf(f.recommendation.priority);
  return matrix.features
    .filter((f) => f.support.self && (f.support.self.status === 'no' || f.support.self.status === 'partial'))
    .sort((a, b) => (rank(a) - rank(b)) || a.title.localeCompare(b.title));
}

/** Paths under project-pages/matrix/, or null for an ephemeral cwd. */
function matrixPaths(realCwd) {
  try {
    return {
      dir: opsPath(realCwd, 'project-pages', 'matrix'),
      matrix: opsPath(realCwd, 'project-pages', 'matrix', 'matrix.json'),
      schema: opsPath(realCwd, 'project-pages', 'matrix', 'matrix.schema.json'),
      history: opsPath(realCwd, 'project-pages', 'matrix', 'history'),
    };
  } catch (e) {
    if (e && e.ephemeral) return null;
    throw e;
  }
}

/** readMatrix(realCwd) → { matrix, error, path }. Never throws. */
async function readMatrix(realCwd) {
  let paths;
  try {
    paths = matrixPaths(realCwd);
  } catch (e) {
    return { matrix: null, error: fail('(cwd)', e && e.message ? e.message : String(e)).error, path: null };
  }
  if (!paths) return { matrix: null, error: null, path: null };
  const file = paths.matrix;
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { matrix: null, error: null, path: file };
    return { matrix: null, error: fail('matrix.json', `unreadable: ${e && e.message ? e.message : e}`).error, path: file };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { matrix: null, error: fail('matrix.json', `invalid JSON: ${e && e.message ? e.message : e}`).error, path: file };
  }
  const v = validateMatrix(value);
  if (!v.ok) return { matrix: null, error: v.error, path: file };
  return { matrix: v.matrix, error: null, path: file };
}

module.exports = {
  CompetitiveMatrixSchema,
  validateMatrix,
  matrixJsonSchema,
  missingFeatures,
  matrixPaths,
  readMatrix,
  MAX_MATRIX_BYTES,
};
