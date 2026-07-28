/**
 * prdCreate.test.cjs — unit tests for the create-PRD body builder (PRD 549,
 * gh-issue-6) and, since PRD 689, its registerAdminRoute create-prd HTTP
 * route (moved verbatim out of the former standalone admin HTTP server
 * module's handleRequest).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreate.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  deriveSlugFromTitle,
  buildPrdBody,
  readStandards,
  STANDARDS_PATH,
  PRD_CREATE_SLUG_RE,
  registerAdminRoute,
} = require('../lib/prdCreate.cjs');
const { createAdminHttp } = require('../lib/localAdminHttp.cjs');
const config = require('../config.cjs');
const prdParser = require('../scheduler/prdParser.cjs');

test('deriveSlugFromTitle lowercases, kebab-cases, and strips non-alnum runs', () => {
  expect(deriveSlugFromTitle('Add Foo Bar!! Baz')).toBe('add-foo-bar-baz');
  expect(deriveSlugFromTitle('  leading/trailing  ')).toBe('leading-trailing');
});

test('deriveSlugFromTitle output always satisfies PRD_CREATE_SLUG_RE', () => {
  const slug = deriveSlugFromTitle('Some Title 123');
  expect(PRD_CREATE_SLUG_RE.test(slug)).toBeTruthy();
});

test('readStandards reads the real standards.md and returns non-empty text', async () => {
  const text = await readStandards();
  expect(text.includes('Execution discipline')).toBeTruthy();
});

test('buildPrdBody emits required frontmatter keys and body sections in order', async () => {
  const body = buildPrdBody({
    title: 'Do the thing',
    cwd: '~/Projects/session-manager',
    estimateMinutes: 15,
    goal: 'Build the thing.',
    acceptanceCriteria: ['thing exists', 'tests pass'],
    implementationNotes: 'See file.cjs:10.',
    outOfScope: ['not this'],
  });

  expect(body.startsWith('---\n')).toBeTruthy();
  expect(body).toMatch(/title: Do the thing/);
  expect(body).toMatch(/cwd: ~\/Projects\/session-manager/);
  expect(body).toMatch(/estimateMinutes: 15/);

  const goalIdx = body.indexOf('# Goal');
  const acIdx = body.indexOf('# Acceptance criteria');
  const implIdx = body.indexOf('# Implementation notes');
  const oosIdx = body.indexOf('# Out of scope');
  const standardsIdx = body.indexOf('## Engineering standards');
  // sections must appear in Goal -> AC -> Implementation notes -> Out of scope -> Engineering standards order
  expect(goalIdx > 0 && goalIdx < acIdx && acIdx < implIdx && implIdx < oosIdx && oosIdx < standardsIdx).toBeTruthy();

  expect(body).toMatch(/- \[ \] thing exists/);
  expect(body).toMatch(/- \[ \] tests pass/);
  expect(body).toMatch(/- not this/);
  // must point at STANDARDS_PATH rather than inline the standards.md content
  expect(body.includes(STANDARDS_PATH)).toBeTruthy();
  expect(body).toMatch(/Before writing any code, read/);
  // the pointer block mentions "Execution discipline" by name, but must not
  // inline the full standards.md prose (e.g. its Performance-section rules)
  expect(body.includes('Lay out hot data contiguously')).toBeFalsy();
});

test('buildPrdBody omits parallelGroup frontmatter key when not supplied', () => {
  const body = buildPrdBody({
    title: 't', cwd: '~/x', estimateMinutes: 5, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
  });
  expect(!/parallelGroup:/.test(body)).toBeTruthy();
});

test('buildPrdBody writes sourcePromptId into frontmatter when supplied (PRD 749 traceability)', () => {
  const body = buildPrdBody({
    title: 't', cwd: '~/x', estimateMinutes: 5, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
    sourcePromptId: 'ticket-abc-123',
  });
  expect(body).toMatch(/sourcePromptId: ticket-abc-123/);
});

test('buildPrdBody omits sourcePromptId frontmatter key when not supplied', () => {
  const body = buildPrdBody({
    title: 't', cwd: '~/x', estimateMinutes: 5, goal: 'g',
    acceptanceCriteria: ['a'], implementationNotes: 'n',
  });
  expect(!/sourcePromptId:/.test(body)).toBeTruthy();
});

test('readStandards result is byte-identical to the on-disk file (single source of truth)', async () => {
  const onDisk = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'plugins', 'session-manager-dev', 'skills', 'develop', 'standards.md'),
    'utf8',
  );
  expect(await readStandards()).toBe(onDisk);
});

// ──────────────────────────────────────────── create-prd admin route

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

// config.cjs's validateWrite only allows writes under a registered non-home
// allowedRoot's `.claude/` subtree (mirrors the real ROOT layout, which is
// $HOME/.claude/session-manager/...) — so the temp prdsDir must live under
// `<root>/.claude/...`, not directly under the temp root itself.
async function mkTmpPrdsDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-admin-create-prd-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, '.claude', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  return prdsDir;
}

// Mirrors scheduler.cjs's real `remote.allocateParallelGroup` / `remote.writePrd`
// (same underlying prdParser.allocateParallelGroup + config.writeTextAtomic
// calls) but pointed at a throwaway temp dir instead of the user's real
// scheduled-plans/prds — so these tests never touch $HOME/.claude.
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
        await config.writeTextAtomic(filePath, body);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
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

async function startWithRemote(remote) {
  const admin = createAdminHttp();
  registerAdminRoute(admin, remote);
  const { port, token } = await admin.start();
  return { admin, port, token };
}

test('POST /admin/scheduler/create-prd without token returns 401', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', body: validCreateBody(),
    });
    expect(res.status).toBe(401);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with a valid payload writes a file with frontmatter + standards appended, returns {nn, filename, status}', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token, body: validCreateBody(),
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('queued');
    expect(typeof res.json.nn).toBe('number');
    expect(res.json.filename).toMatch(/^\d+-add-widget-frobnication\.md$/);

    const written = await fsp.readFile(path.join(prdsDir, res.json.filename), 'utf8');
    expect(written).toMatch(/^---\n/);
    expect(written).toMatch(/title: Add widget frobnication/);
    expect(written).toMatch(/cwd: .+/);
    expect(written).toMatch(/estimateMinutes: 15/);
    expect(written).toMatch(/# Goal/);
    expect(written).toMatch(/# Acceptance criteria/);
    expect(written).toMatch(/- \[ \] widget frobnicates on click/);
    expect(written).toMatch(/# Implementation notes/);
    expect(written).toMatch(/# Out of scope/);
    expect(written).toMatch(/## Engineering standards/);
    // must point at STANDARDS_PATH rather than inline standards.md
    expect(written.includes(STANDARDS_PATH)).toBeTruthy();
    expect(written.includes('Lay out hot data contiguously')).toBeFalsy();
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with malformed frontmatter (missing acceptanceCriteria) is rejected and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const body = validCreateBody();
    delete body.acceptanceCriteria;
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token, body,
    });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    const entries = await fsp.readdir(prdsDir);
    expect(entries.filter((f) => f.endsWith('.md')).length).toBe(0);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with cwd outside allowed roots is rejected and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ cwd: '/etc/passwd-adjacent-outside-home' }),
    });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    const entries = await fsp.readdir(prdsDir);
    expect(entries.filter((f) => f.endsWith('.md')).length).toBe(0);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd rejects a title containing a newline (frontmatter-injection guard) and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ title: 'Legit title\n---\nEvil: injected' }),
    });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    const entries = await fsp.readdir(prdsDir);
    expect(entries.filter((f) => f.endsWith('.md')).length).toBe(0);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with an explicit parallelGroup+slug that already exists on disk returns 409 and does not clobber the file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    await fsp.writeFile(path.join(prdsDir, '777-my-explicit-slug.md'), 'ORIGINAL CONTENT\n');
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'my-explicit-slug', parallelGroup: 777 }),
    });
    expect(res.status).toBe(409);
    expect(res.json.ok).toBe(false);
    const stillThere = await fsp.readFile(path.join(prdsDir, '777-my-explicit-slug.md'), 'utf8');
    // existing PRD file must not be overwritten
    expect(stillThere).toBe('ORIGINAL CONTENT\n');
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd honors an explicit slug + parallelGroup instead of deriving/allocating', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'my-explicit-slug', parallelGroup: 777 }),
    });
    expect(res.status).toBe(200);
    expect(res.json.nn).toBe(777);
    expect(res.json.filename).toBe('777-my-explicit-slug.md');
    expect(fs.existsSync(path.join(prdsDir, '777-my-explicit-slug.md'))).toBeTruthy();
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with sourcePromptId writes it into the created PRD frontmatter', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'from-a-ticket', parallelGroup: 888, sourcePromptId: 'ticket-xyz-789' }),
    });
    expect(res.status).toBe(200);
    const written = fs.readFileSync(path.join(prdsDir, '888-from-a-ticket.md'), 'utf8');
    expect(written).toMatch(/sourcePromptId: ticket-xyz-789/);
  } finally {
    await admin.stop();
  }
});
