/**
 * prdFrontmatterVoiceId.test.cjs — `voiceId` (an in-process-only per-PRD
 * library voice, e.g. a Video tool job's voice) is a recognized frontmatter
 * key restricted to VOICE_ID_RE, mirroring `effort`. The admin HTTP / MCP
 * create-prd path never forwards a caller-supplied voiceId (the
 * schedulerCreatePrd zod schema strips it, same as effort).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterVoiceId.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { parsePrdFile, serializePrdFile, RECOGNIZED_KEYS } = require('../lib/prd/prdFrontmatter.cjs');
const { buildPrdBody, createPrd, registerAdminRoute } = require('../lib/prd/prdCreate.cjs');
const { createAdminHttp } = require('../lib/feedback-remote/localAdminHttp.cjs');
const prdParser = require('../scheduler/prdParser.cjs');
const config = require('../config.cjs');

test('voiceId is a recognized key', () => {
  expect(RECOGNIZED_KEYS.has('voiceId')).toBe(true);
});

test('voiceId parses and round-trips', () => {
  const text = '---\ntitle: T\nmacroId: demo-video\neffort: medium\nvoiceId: narrator_1\n---\nbody\n';
  const { frontmatter, body } = parsePrdFile(text);
  expect(frontmatter.voiceId).toBe('narrator_1');
  expect(frontmatter.extras?.voiceId).toBeUndefined();
  const out = serializePrdFile(frontmatter, body);
  expect(out).toMatch(/^voiceId: narrator_1$/m);
  expect(parsePrdFile(out).frontmatter.voiceId).toBe('narrator_1');
  const fresh = serializePrdFile({ title: 'T', effort: 'low', voiceId: 'v-2' }, 'b\n');
  expect(fresh).toMatch(/effort: low\nvoiceId: v-2\n/);
  expect(parsePrdFile('---\ntitle: T\nvoiceId:  "abc"  \n---\nb\n').frontmatter.voiceId).toBe('abc');
});

test('malformed voiceId frontmatter values are dropped', () => {
  for (const bad of ['Narrator', '-lead', '', 'a b', 'x'.repeat(65), '../etc', 'a;rm']) {
    const { frontmatter } = parsePrdFile(`---\ntitle: T\nvoiceId: ${bad}\n---\nbody\n`);
    expect(frontmatter.voiceId).toBeUndefined();
    expect(frontmatter.extras?.voiceId).toBeUndefined();
  }
});

const BASE = { title: 't', cwd: '~/x', goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n' };

test('buildPrdBody emits voiceId only for a valid id', () => {
  expect(buildPrdBody({ ...BASE, voiceId: 'narrator_1' })).toMatch(/^voiceId: narrator_1$/m);
  for (const bad of [undefined, null, 'BAD', '-x', 42, 'a\nb']) {
    expect(buildPrdBody({ ...BASE, voiceId: bad })).not.toMatch(/^voiceId:/m);
  }
});

async function mkTmpPrdsDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-voiceid-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, '.claude', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  return prdsDir;
}

function makeFakeRemote(prdsDir) {
  return {
    async allocateParallelGroup() { return prdParser.allocateParallelGroup(prdsDir); },
    async readPrd() { return { ok: false, error: 'n/a' }; },
    async writePrd(slug, body) {
      await config.writeTextAtomic(path.join(prdsDir, `${slug}.md`), body, { writer: 'scheduler' });
      return { ok: true };
    },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
  };
}

function validCreateBody(overrides = {}) {
  return {
    title: 'Add widget frobnication',
    cwd: os.homedir(),
    estimateMinutes: 15,
    goal: 'Add frobnication to the widget subsystem.',
    acceptanceCriteria: ['widget frobnicates on click', 'timeout 300 npm run typecheck passes'],
    implementationNotes: 'See src/widget.cjs:10.',
    outOfScope: ['not touching gadgets'],
    ...overrides,
  };
}

function readOnlyPrd(prdsDir) {
  const files = fs.readdirSync(prdsDir).filter((f) => f.endsWith('.md'));
  expect(files.length).toBe(1);
  return fs.readFileSync(path.join(prdsDir, files[0]), 'utf8');
}

test('createPrd writes voiceId then parse reads it back', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const result = await createPrd(validCreateBody({ voiceId: 'narrator_1' }), makeFakeRemote(prdsDir));
  expect(result.ok).toBe(true);
  const text = readOnlyPrd(prdsDir);
  expect(text).toMatch(/^voiceId: narrator_1$/m);
  expect(parsePrdFile(text).frontmatter.voiceId).toBe('narrator_1');
});

test('createPrd refuses a bad voiceId with 400 naming voiceId, before NN allocation', async () => {
  for (const bad of ['Narrator', '-x', '', 42, 'a b', 'x'.repeat(65)]) {
    const prdsDir = await mkTmpPrdsDir();
    const remote = makeFakeRemote(prdsDir);
    const allocSpy = vi.fn(remote.allocateParallelGroup);
    remote.allocateParallelGroup = allocSpy;
    const result = await createPrd(validCreateBody({ voiceId: bad }), remote);
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/voiceId/);
    expect(allocSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(prdsDir)).toEqual([]);
  }
});

function request(port, { path: reqPath, token, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: reqPath,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('POST /admin/scheduler/create-prd ignores a caller-supplied voiceId (valid or not)', async () => {
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  const prdsDir = await mkTmpPrdsDir();
  registerAdminRoute(admin, makeFakeRemote(prdsDir));
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  try {
    const res = await request(port, { path: '/admin/scheduler/create-prd', token, body: validCreateBody({ voiceId: 'narrator_1', effort: 'max' }) });
    expect(res.status).toBe(200);
    const text = readOnlyPrd(prdsDir);
    expect(text).not.toMatch(/^voiceId:/m);
    expect(text).not.toMatch(/^effort:/m);
    // A malformed voiceId is stripped too, never a 400 from this path.
    const res2 = await request(port, { path: '/admin/scheduler/create-prd', token, body: validCreateBody({ title: 'Second one', voiceId: 'BAD ID' }) });
    expect(res2.status).toBe(200);
  } finally {
    await admin.stop();
  }
});
