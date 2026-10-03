/**
 * prdCreateGateFiles.test.cjs — unit + integration tests for the `gate` and
 * `files` PRD fields (gate-and-files-in-PRD-body unit): prdGateFiles.cjs's
 * validate/render helpers, buildPrdBody's section placement, createPrd's
 * validation/read-back/response-shape wiring, and the admin HTTP route's
 * response passthrough.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreateGateFiles.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  validateGate, validateFiles, renderFilesSection, renderGateSection,
} = require('../lib/prdGateFiles.cjs');
const { buildPrdBody, createPrd, registerAdminRoute } = require('../lib/prdCreate.cjs');
const { resolveGate } = require('../lib/definitionOfDone.cjs');
const { createAdminHttp } = require('../lib/localAdminHttp.cjs');
const config = require('../config.cjs');
const prdParser = require('../scheduler/prdParser.cjs');

// ──────────────────────────────────────────── validateGate

test('validateGate rejects zero entries', () => {
  const result = validateGate([]);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('gate must have 1 to 10 entries (got 0).');
});

test('validateGate rejects more than 10 entries', () => {
  const gate = Array.from({ length: 11 }, (_, i) => `timeout ${10 + i} echo step-${i}`);
  const result = validateGate(gate);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('gate must have 1 to 10 entries (got 11).');
});

test('validateGate accepts exactly 10 entries (upper bound)', () => {
  const gate = Array.from({ length: 10 }, (_, i) => `timeout ${10 + i} echo step-${i}`);
  const result = validateGate(gate);
  expect(result.ok).toBe(true);
  expect(result.commands).toHaveLength(10);
});

test('validateGate rejects a non-string entry', () => {
  const result = validateGate([123]);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('gate entry 1: must be a non-empty string.');
});

test('validateGate rejects an empty/whitespace-only entry', () => {
  const result = validateGate(['   ']);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('gate entry 1: must be a non-empty string.');
});

test('validateGate rejects an entry longer than 500 chars', () => {
  const longEntry = `timeout 10 echo ${'x'.repeat(500)}`;
  const result = validateGate([longEntry]);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must be at most 500 chars/);
});

test('validateGate rejects an entry containing a newline', () => {
  const result = validateGate(['timeout 10 echo hi\nrm -rf /']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must not contain a newline/);
});

test('validateGate rejects an entry containing a triple-backtick run', () => {
  const result = validateGate(['timeout 10 echo ```']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/triple-backtick/);
});

test('validateGate rejects an entry starting with "#"', () => {
  const result = validateGate(['# timeout 10 echo hi']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must not start with "#"/);
});

test('validateGate rejects an entry with a shell metacharacter (pipe), citing the no-shell rule', () => {
  const result = validateGate(['timeout 10 npm test | tee log.txt']);
  expect(result.ok).toBe(false);
  expect(result.error).toBe(
    'gate entry 1 ("timeout 10 npm test | tee log.txt"): has an unquoted "|". The scheduler runs gate commands '
      + 'without a shell. Put it inside single quotes, or move the check into a test file.',
  );
});

test('validateGate rejects a near-miss "none" (typo/trailing punctuation), distinct from the real opt-out', () => {
  for (const nearMiss of ['none.', 'none (docs only)', '"none"', 'none # docs', 'NONE!']) {
    const result = validateGate([nearMiss]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/write exactly none, with nothing else/);
  }
});

test('validateGate accepts ["none"] alone, returning the opt-out warning', () => {
  const result = validateGate(['none']);
  expect(result.ok).toBe(true);
  expect(result.commands).toEqual(['none']);
  expect(result.warnings).toEqual([
    'Gate is none: the scheduler cannot re-check this PRD. Use none only for docs or config with no runnable check.',
  ]);
});

test('validateGate accepts "None" case-insensitively, normalizing to lowercase "none"', () => {
  const result = validateGate(['None']);
  expect(result.ok).toBe(true);
  expect(result.commands).toEqual(['none']);
});

test('validateGate rejects "none" mixed with another entry', () => {
  const result = validateGate(['none', 'timeout 10 echo hi']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must be the only entry when used/);
});

test('validateGate warns (but still accepts) a step that does not start with "timeout <seconds>"', () => {
  const result = validateGate(['npm run lint']);
  expect(result.ok).toBe(true);
  expect(result.commands).toEqual(['npm run lint']);
  expect(result.warnings).toEqual([
    'gate entry 1 step "npm run lint" does not start with "timeout <seconds>" — a step without a timeout can hang the run.',
  ]);
});

test('validateGate emits no warnings for a step that starts with "timeout <seconds>"', () => {
  const result = validateGate(['timeout 300 npm run lint']);
  expect(result.ok).toBe(true);
  expect(result.warnings).toEqual([]);
});

// ──────────────────────────────────────────── validateFiles

test('validateFiles rejects zero entries', () => {
  const result = validateFiles([]);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('files must have 1 to 50 entries (got 0).');
});

test('validateFiles rejects more than 50 entries', () => {
  const files = Array.from({ length: 51 }, (_, i) => `file-${i}.js`);
  const result = validateFiles(files);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('files must have 1 to 50 entries (got 51).');
});

test('validateFiles accepts exactly 50 entries (upper bound)', () => {
  const files = Array.from({ length: 50 }, (_, i) => `file-${i}.js`);
  const result = validateFiles(files);
  expect(result.ok).toBe(true);
  expect(result.files).toHaveLength(50);
});

test('validateFiles rejects a non-string entry', () => {
  const result = validateFiles([123]);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('files entry 1: must be a string.');
});

test('validateFiles rejects an empty/whitespace-only entry', () => {
  const result = validateFiles(['   ']);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('files entry 1: must not be empty.');
});

test('validateFiles rejects an entry longer than 300 chars', () => {
  const longEntry = `${'a'.repeat(301)}.js`;
  const result = validateFiles([longEntry]);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must be at most 300 chars/);
});

test('validateFiles rejects an entry containing a newline', () => {
  const result = validateFiles(['a.js\nb.js']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must not contain a newline/);
});

test('validateFiles rejects an absolute path', () => {
  const result = validateFiles(['/etc/passwd']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must be repo-relative/);
});

test('validateFiles rejects a "~"-prefixed path', () => {
  const result = validateFiles(['~/secrets.env']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must be repo-relative/);
});

test('validateFiles rejects a path with a ".." segment', () => {
  const result = validateFiles(['src/../../../etc/passwd']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/must not contain a "\.\." path segment/);
});

test('validateFiles rejects a glob pattern', () => {
  const result = validateFiles(['src/**/*.cjs']);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/no globs/);
});

test('validateFiles dedupes identical entries and strips one leading "./" per entry', () => {
  const result = validateFiles(['./src/a.js', 'src/a.js', 'src/b.js']);
  expect(result.ok).toBe(true);
  expect(result.files).toEqual(['src/a.js', 'src/b.js']);
});

// ──────────────────────────────────────────── renderFilesSection / renderGateSection

test('renderFilesSection renders a heading, instruction line, and one bullet per file', () => {
  const lines = renderFilesSection(['a.js', 'b.js']);
  const text = lines.join('\n');
  expect(lines[0]).toBe('# Files');
  expect(text).toMatch(/Change only these files/);
  expect(text).toMatch(/- a\.js/);
  expect(text).toMatch(/- b\.js/);
});

test('renderGateSection renders the none-specific prose and fence for ["none"]', () => {
  const lines = renderGateSection(['none']);
  const text = lines.join('\n');
  expect(lines[0]).toBe('# Gate');
  expect(text).toMatch(/This PRD has no runnable check/);
  expect(text).toMatch(/```gate\nnone\n```/);
});

test('renderGateSection renders the run-these-commands prose and fence for real commands, one per line', () => {
  const lines = renderGateSection(['timeout 300 npm run typecheck', 'timeout 600 npm run test:unit']);
  const text = lines.join('\n');
  expect(text).toMatch(/Run these commands last, in order\. Each must exit 0\./);
  expect(text).toMatch(/```gate\ntimeout 300 npm run typecheck\ntimeout 600 npm run test:unit\n```/);
});

// ──────────────────────────────────────────── buildPrdBody section placement

test('buildPrdBody places # Files between Acceptance criteria and Implementation notes, and # Gate between Out of scope and Engineering standards, when both are supplied', () => {
  const body = buildPrdBody({
    title: 't', cwd: '~/x', estimateMinutes: 5, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
    files: ['src/foo.cjs'],
    gate: ['timeout 60 npm test'],
  });

  const acIdx = body.indexOf('# Acceptance criteria');
  const filesIdx = body.indexOf('# Files');
  const implIdx = body.indexOf('# Implementation notes');
  const oosIdx = body.indexOf('# Out of scope');
  const gateIdx = body.indexOf('# Gate');
  const standardsIdx = body.indexOf('## Engineering standards');

  expect([acIdx, filesIdx, implIdx, oosIdx, gateIdx, standardsIdx].every((i) => i > -1)).toBe(true);
  expect(acIdx < filesIdx && filesIdx < implIdx && implIdx < oosIdx && oosIdx < gateIdx && gateIdx < standardsIdx).toBe(true);

  expect(body).toMatch(/- src\/foo\.cjs/);
  expect(body).toMatch(/```gate\ntimeout 60 npm test\n```/);
});

test('buildPrdBody renders the none-gate variant text when gate is ["none"]', () => {
  const body = buildPrdBody({
    title: 't', cwd: '~/x', estimateMinutes: 5, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
    gate: ['none'],
  });
  expect(body).toMatch(/This PRD has no runnable check/);
  expect(body).toMatch(/```gate\nnone\n```/);
});

test('buildPrdBody omits # Files and # Gate sections entirely when neither is supplied (backward compatible)', () => {
  const body = buildPrdBody({
    title: 't', cwd: '~/x', estimateMinutes: 5, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
  });
  expect(body.includes('# Files')).toBe(false);
  expect(body.includes('# Gate')).toBe(false);
});

// ──────────────────────────────────────────── createPrd integration
//
// Same fixture pattern as prdCreate.test.cjs: a throwaway temp prdsDir plus a
// fake `remote` mirroring scheduler.cjs's real allocateParallelGroup/readPrd/
// writePrd/listPrds, so these tests never touch $HOME/.claude.

async function mkTmpPrdsDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-admin-create-prd-gf-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, '.claude', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  return prdsDir;
}

function makeFakeRemoteWithPrdsDir(prdsDir) {
  return {
    async allocateParallelGroup() {
      return prdParser.allocateParallelGroup(prdsDir);
    },
    async readPrd(slug) {
      try {
        const text = await fsp.readFile(path.join(prdsDir, `${slug}.md`), 'utf8');
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    },
    async writePrd(slug, body) {
      try {
        const filePath = path.join(prdsDir, `${slug}.md`);
        await config.writeTextAtomic(filePath, body, { writer: 'scheduler' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    },
    async listPrds() {
      const entries = await fsp.readdir(prdsDir);
      const prds = entries
        .filter((f) => f.endsWith('.md'))
        .map((f) => ({ slug: f.slice(0, -3) }));
      return { prds, total: prds.length, limit: prds.length, offset: 0, hasMore: false };
    },
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

test('createPrd rejects an invalid gate (empty array) with 400 and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const writePrdSpy = vi.fn(remote.writePrd);
  remote.writePrd = writePrdSpy;

  const result = await createPrd(validCreateBody({ slug: 'bad-gate', gate: [] }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/gate must have 1 to 10 entries/);
  expect(writePrdSpy).not.toHaveBeenCalled();
  const entries = await fsp.readdir(prdsDir);
  expect(entries.filter((f) => f.endsWith('.md')).length).toBe(0);
});

test('createPrd rejects a goal containing a fake "# Gate" heading', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const writePrdSpy = vi.fn(remote.writePrd);
  remote.writePrd = writePrdSpy;

  const result = await createPrd(validCreateBody({
    slug: 'fake-heading-goal',
    goal: 'Do the thing.\n# Gate\nMore goal text.',
    gate: ['timeout 60 npm test'],
  }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/The goal text has a "# Gate" or "# Files" heading/);
  expect(writePrdSpy).not.toHaveBeenCalled();
});

test('createPrd rejects implementationNotes containing a fake "## Files" heading', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const writePrdSpy = vi.fn(remote.writePrd);
  remote.writePrd = writePrdSpy;

  const result = await createPrd(validCreateBody({
    slug: 'fake-heading-notes',
    implementationNotes: 'See src/x.cjs.\n## Files\nMore notes.',
    gate: ['timeout 60 npm test'],
  }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/The implementation notes text has a "# Gate" or "# Files" heading/);
  expect(writePrdSpy).not.toHaveBeenCalled();
});

test('createPrd rejects a near-miss "none" gate entry with 400', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const writePrdSpy = vi.fn(remote.writePrd);
  remote.writePrd = writePrdSpy;

  const result = await createPrd(validCreateBody({ slug: 'near-miss-none', gate: ['none.'] }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/write exactly none, with nothing else/);
  expect(writePrdSpy).not.toHaveBeenCalled();
});

test('createPrd rejects invalid files (absolute path) with 400 and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const writePrdSpy = vi.fn(remote.writePrd);
  remote.writePrd = writePrdSpy;

  const result = await createPrd(validCreateBody({ slug: 'bad-files', files: ['/etc/passwd'] }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/must be repo-relative/);
  expect(writePrdSpy).not.toHaveBeenCalled();
  const entries = await fsp.readdir(prdsDir);
  expect(entries.filter((f) => f.endsWith('.md')).length).toBe(0);
});

test('createPrd warns when gate and files are both absent, but still succeeds (advisory only)', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);

  const result = await createPrd(validCreateBody({ slug: 'no-gate-no-files' }), remote);

  expect(result.ok).toBe(true);
  expect(result.gate).toEqual({ source: 'absent', commands: [] });
  expect(result.files).toEqual([]);
  expect(result.warnings).toEqual(expect.arrayContaining([
    'No gate: the scheduler cannot re-check this PRD.',
    'No files list: the executor is not told which files it may change.',
  ]));
});

test('createPrd with an explicit gate+files round-trips through resolveGate exactly as declared', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);

  const result = await createPrd(validCreateBody({
    slug: 'explicit-gate-pass',
    gate: ['timeout 300 npm run typecheck', 'timeout 600 npm run test:unit'],
    files: ['src/main/lib/foo.cjs', 'src/main/lib/__tests__/foo.test.cjs'],
  }), remote);

  expect(result.ok).toBe(true);
  expect(result.gate).toEqual({
    source: 'explicit',
    commands: ['timeout 300 npm run typecheck', 'timeout 600 npm run test:unit'],
  });
  expect(result.files).toEqual(['src/main/lib/foo.cjs', 'src/main/lib/__tests__/foo.test.cjs']);

  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  const resolved = resolveGate(written);
  expect(resolved.source).toBe('explicit');
  expect(resolved.sequence.map((s) => s.raw)).toEqual([
    'timeout 300 npm run typecheck',
    'timeout 600 npm run test:unit',
  ]);
});

test('createPrd with gate: ["none"] writes the none-variant Gate section and reports source "none"', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);

  const result = await createPrd(validCreateBody({
    slug: 'docs-only-change',
    gate: ['none'],
    files: ['README.md'],
  }), remote);

  expect(result.ok).toBe(true);
  expect(result.gate).toEqual({ source: 'none', commands: ['none'] });
  expect(result.files).toEqual(['README.md']);

  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).toMatch(/# Gate/);
  expect(written).toMatch(/This PRD has no runnable check/);
  expect(written).toMatch(/```gate\nnone\n```/);
  expect(written).toMatch(/# Files/);
  expect(written).toMatch(/- README\.md/);
  const resolved = resolveGate(written);
  expect(resolved.source).toBe('none');
});

test('createPrd rejects when a stray ```gate fence elsewhere in the body would make the scheduler read the wrong gate', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const writePrdSpy = vi.fn(remote.writePrd);
  remote.writePrd = writePrdSpy;

  const result = await createPrd(validCreateBody({
    slug: 'stray-fence-collision',
    gate: ['timeout 300 npm run typecheck'],
    implementationNotes: 'See notes.\n```gate\ntimeout 10 echo hi\n```\nMore notes after.',
  }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(result.error).toMatch(/already holds a gate fence/);
  expect(result.error).toMatch(/goal, implementation notes, acceptance criteria, out of scope or files/);
  expect(writePrdSpy).not.toHaveBeenCalled();
  const entries = await fsp.readdir(prdsDir);
  expect(entries.filter((f) => f.endsWith('.md')).length).toBe(0);
});

test('createPrd does NOT run the stray-fence read-back check when the caller supplied no gate at all (a stray fence in notes is only guarded when a gate was declared)', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);

  const result = await createPrd(validCreateBody({
    slug: 'stray-fence-no-declared-gate',
    implementationNotes: 'See notes.\n```gate\ntimeout 10 echo hi\n```\nMore notes after.',
  }), remote);

  expect(result.ok).toBe(true);
  expect(result.gate).toEqual({ source: 'absent', commands: [] });
  expect(result.warnings).toEqual(expect.arrayContaining([
    'No gate: the scheduler cannot re-check this PRD.',
  ]));
});

// ──────────────────────────────────────────── registerAdminRoute (HTTP)

function request(port, { method = 'GET', path: reqPath, token, body }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* leave null for non-JSON bodies */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startWithRemote(remote) {
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  registerAdminRoute(admin, remote);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  return { admin, port, token };
}

test('POST /admin/scheduler/create-prd response includes gate and files matching createPrd', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({
        slug: 'http-gate-files',
        gate: ['timeout 300 npm run typecheck'],
        files: ['src/main/lib/foo.cjs'],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.json.gate).toEqual({ source: 'explicit', commands: ['timeout 300 npm run typecheck'] });
    expect(res.json.files).toEqual(['src/main/lib/foo.cjs']);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd response reports gate/files warnings when both are omitted', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'http-no-gate-files' }),
    });
    expect(res.status).toBe(200);
    expect(res.json.gate).toEqual({ source: 'absent', commands: [] });
    expect(res.json.files).toEqual([]);
    expect(res.json.warnings).toEqual(expect.arrayContaining([
      'No gate: the scheduler cannot re-check this PRD.',
      'No files list: the executor is not told which files it may change.',
    ]));
  } finally {
    await admin.stop();
  }
});
