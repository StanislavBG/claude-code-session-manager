/**
 * prdCreate.test.cjs — unit tests for the create-PRD body builder (PRD 549,
 * gh-issue-6) and, since PRD 689, its registerAdminRoute create-prd HTTP
 * route (moved verbatim out of the former standalone admin HTTP server
 * module's handleRequest).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdCreate.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
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
  createPrd,
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
        await config.writeTextAtomic(filePath, body, { writer: 'scheduler' });
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
  // Force the e2e-suffixed token path so this suite never races the real
  // ~/.claude/session-manager/admin-api.json against other test files (or a
  // live production instance) that also call createAdminHttp() concurrently.
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  registerAdminRoute(admin, remote);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
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

test('PRD 832: an explicit parallelGroup colliding with an existing file is ignored — a fresh unique NN is allocated and nothing is clobbered', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    await fsp.writeFile(path.join(prdsDir, '777-my-explicit-slug.md'), 'ORIGINAL CONTENT\n');
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'my-explicit-slug', parallelGroup: 777 }),
    });
    expect(res.status).toBe(200);
    // Allocator scans past the existing 777 — unique per project, never reused.
    expect(res.json.nn).toBe(778);
    expect(res.json.filename).toBe('778-my-explicit-slug.md');
    const stillThere = await fsp.readFile(path.join(prdsDir, '777-my-explicit-slug.md'), 'utf8');
    expect(stillThere).toBe('ORIGINAL CONTENT\n');
  } finally {
    await admin.stop();
  }
});

test('PRD 832: explicit parallelGroup input is deprecated and ignored — NN always comes from the allocator', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'my-explicit-slug', parallelGroup: 777 }),
    });
    expect(res.status).toBe(200);
    expect(res.json.nn).toBe(1);
    expect(res.json.filename).toBe('1-my-explicit-slug.md');
    expect(fs.existsSync(path.join(prdsDir, '1-my-explicit-slug.md'))).toBeTruthy();
  } finally {
    await admin.stop();
  }
});

// ──────────────────────────────────────────── createPrd() (chat:create-prd IPC handler, PRD 749 follow-up)
//
// createPrd() is the function ipcMain.handle('chat:create-prd', ...) in
// index.cjs calls directly (in-process, no HTTP) — same function
// registerAdminRoute's HTTP handler calls above. These tests exercise it
// directly, mirroring the handler's own call shape: createPrd(input, remote).

test('createPrd rejects a cwd outside allowedRoots before any write, returning {ok:false, status:400}', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const writePrdSpy = vi.fn(remote.writePrd);
  remote.writePrd = writePrdSpy;

  const result = await createPrd(validCreateBody({ cwd: '/etc/passwd-adjacent-outside-home' }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(400);
  expect(writePrdSpy).not.toHaveBeenCalled();
  const entries = await fsp.readdir(prdsDir);
  expect(entries.filter((f) => f.endsWith('.md')).length).toBe(0);
});

test('createPrd with a valid payload allocates a group, writes through remote.writePrd, and returns {ok:true, nn, filename}', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);

  const result = await createPrd(validCreateBody({ sourcePromptId: 'ticket-abc', sourceTabId: 'tab-1' }), remote);

  expect(result.ok).toBe(true);
  expect(typeof result.nn).toBe('number');
  expect(result.filename).toMatch(/^\d+-add-widget-frobnication\.md$/);

  const written = await fsp.readFile(path.join(prdsDir, result.filename), 'utf8');
  expect(written).toMatch(/^---\n/);
  expect(written).toMatch(/title: Add widget frobnication/);
  expect(written).toMatch(/sourcePromptId: ticket-abc/);
  expect(written).toMatch(/sourceTabId: tab-1/);
  expect(written).toMatch(/# Goal/);
});

test('createPrd returns {ok:false, status:409} without clobbering when the destination already exists', async () => {
  const prdsDir = await mkTmpPrdsDir();
  // The existence guard survives PRD 832: whatever NN the allocator picks,
  // a pre-existing file at that exact destination must 409, never clobber.
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const realRead = remote.readPrd.bind(remote);
  remote.readPrd = async (slug) => (slug.endsWith('my-explicit-slug') ? { ok: true, text: 'ORIGINAL' } : realRead(slug));
  const writes = [];
  const realWrite = remote.writePrd.bind(remote);
  remote.writePrd = async (...a) => { writes.push(a[0]); return realWrite(...a); };

  const result = await createPrd(validCreateBody({ slug: 'my-explicit-slug' }), remote);

  expect(result.ok).toBe(false);
  expect(result.status).toBe(409);
  expect(writes).toEqual([]);
});

// ──────────────────────────────────────────── PRD 825: Epic PRD dir write grant + `~` cwd normalization

test('validateWrite allows writes under <root>/session-manager-operations/scheduler/epics/<id>/prds/', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-scheduler-epics-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, 'session-manager-operations', 'scheduler', 'epics', 'epic-abc123', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  const filePath = path.join(prdsDir, '1-do-thing.md');

  // Writes into scheduler/ must declare the owning surface (single-writer law).
  await config.writeTextAtomic(filePath, 'PRD body\n', { writer: 'scheduler' });

  expect(fs.existsSync(filePath)).toBeTruthy();
  expect(await fsp.readFile(filePath, 'utf8')).toBe('PRD body\n');
});

test('createPrd normalizes a `~`-prefixed cwd via expandHome before calling remote', async () => {
  const receivedCwds = [];
  const remote = {
    async allocateParallelGroup(cwd) { receivedCwds.push(cwd); return 42; },
    async readPrd(slug, cwd) { receivedCwds.push(cwd); return { ok: false }; },
    async writePrd(slug, body, cwd) { receivedCwds.push(cwd); return { ok: true, bytesWritten: body.length }; },
  };

  const result = await createPrd(validCreateBody({ cwd: '~' }), remote);

  expect(result.ok).toBe(true);
  expect(receivedCwds.length).toBeGreaterThan(0);
  for (const cwd of receivedCwds) {
    expect(cwd.startsWith('~')).toBe(false);
    expect(cwd).toBe(os.homedir());
  }
});

// ──────────────────────────────────────────── PRD 862: register cwd as an
// allowed write root at createPrd() time, not only at pty.spawn() time
//
// Before this fix, config.cjs's allowedRoots (the write-boundary allowlist)
// only ever grew via pty.cjs's addAllowedRoot call inside pty.spawn(). A
// chat-only Epic (headless `claude -p --resume`, no Terminal PTY ever
// spawned for its project cwd) reached createPrd() -> remote.writePrd() ->
// config.writeTextAtomic() -> config.validateWrite() and failed with "Write
// outside allowed write boundaries", purely because no PTY had registered
// that cwd yet in this process's lifetime. This test reproduces that exact
// scenario: a brand-new project root that has NEVER had config.addAllowedRoot
// called for it (mirroring pty.spawn() never having run), writing through the
// real config.writeTextAtomic into the real session-manager-operations/
// scheduler/ subtree (not the mocked-remote temp dirs the other tests here
// use, which pre-register their root via addAllowedRoot in mkTmpPrdsDir).
test('createPrd registers cwd as an allowed write root itself, so a chat-only Epic (no Terminal PTY ever spawned for this cwd) can still write its PRD', async () => {
  // Must live under $HOME: validatePath's read boundary is home-dir-wide
  // regardless of allowedRoots registration (matching every real project
  // cwd, which checkInsideHome forces inside $HOME) — the bug this test
  // reproduces is specifically about the *write* boundary (validateWrite),
  // not the read one.
  const root = await fsp.mkdtemp(path.join(os.homedir(), '.sm-chat-only-epic-'));
  // Deliberately do NOT call config.addAllowedRoot(root) here — pty.spawn()
  // is the only other caller of addAllowedRoot, and it never runs for a
  // chat-only Epic. createPrd() itself must perform this registration.
  const prdsEpicDir = path.join(root, 'session-manager-operations', 'scheduler', 'epics', 'chat-only-epic', 'prds');

  try {
    const remote = {
      async allocateParallelGroup() { return 1; },
      async readPrd() { return { ok: false }; },
      async writePrd(slug, body) {
        await fsp.mkdir(prdsEpicDir, { recursive: true });
        const filePath = path.join(prdsEpicDir, `${slug}.md`);
        // Real config.cjs write path — this is what threw
        // "Write outside allowed write boundaries" before the fix.
        await config.writeTextAtomic(filePath, body, { writer: 'scheduler' });
        return { ok: true };
      },
    };

    const result = await createPrd(validCreateBody({ cwd: root }), remote);

    expect(result.ok).toBe(true);
    const written = await fsp.readFile(path.join(prdsEpicDir, result.filename), 'utf8');
    expect(written).toMatch(/title: Add widget frobnication/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('POST /admin/scheduler/create-prd with sourcePromptId writes it into the created PRD frontmatter', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'from-a-ticket', sourcePromptId: 'ticket-xyz-789' }),
    });
    expect(res.status).toBe(200);
    const written = fs.readFileSync(path.join(prdsDir, `${res.json.nn}-from-a-ticket.md`), 'utf8');
    expect(written).toMatch(/sourcePromptId: ticket-xyz-789/);
  } finally {
    await admin.stop();
  }
});
