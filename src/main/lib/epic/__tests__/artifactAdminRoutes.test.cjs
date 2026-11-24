/**
 * artifactAdminRoutes.test.cjs — POST /admin/artifacts/publish and GET /admin/artifacts
 * over a real loopback admin server (token check included) and the real artifactStore
 * under a temp project root: success, relative-path resolution against the Epic
 * worktree, outside-root refusal, no-Epic refusal, missing token and list.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/artifactAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createAdminHttp, TOKEN_PATH } = require('../../feedback-remote/localAdminHttp.cjs');
const { registerAdminRoute } = require('../artifactAdminRoutes.cjs');

// Never overwrite the running app's admin-api.json (see localAdminHttp.test.cjs).
const TEST_TOKEN_PATH = path.join(path.dirname(TOKEN_PATH), `admin-api.artifact-test-${process.pid}.json`);
const prevTokenPath = process.env.SM_ADMIN_TOKEN_PATH;
process.env.SM_ADMIN_TOKEN_PATH = TEST_TOKEN_PATH;

const EPIC = 'epic-art1';
const SESSION = 'sess-123';

let admin;
let port;
let token;
let root;
let worktree;
let allowedTmp;
let outside;
/** @type {any[]} */
let resolveCalls;
/** @type {any} */
let ctxResult;
/** @type {any[]} */
let noticeCalls = [];

const mk = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

beforeAll(async () => {
  admin = createAdminHttp();
  registerAdminRoute(admin, {
    resolveProjectContext: (args) => { resolveCalls.push(args); return ctxResult; },
    readActiveIndex: (cwd) => (cwd === root
      ? { sessions: { [EPIC]: { id: EPIC, claudeSessionId: SESSION, worktree: { dir: worktree } } } }
      : { sessions: {} }),
    stagingBase: () => null,
    tmpdir: () => allowedTmp,
    postArtifactReadyNotice: async (args) => { noticeCalls.push(args); return { ok: true }; },
  });
  ({ port, token } = await admin.start());
});

afterAll(async () => {
  await admin.stop();
  fs.rmSync(TEST_TOKEN_PATH, { force: true });
  if (prevTokenPath === undefined) delete process.env.SM_ADMIN_TOKEN_PATH;
  else process.env.SM_ADMIN_TOKEN_PATH = prevTokenPath;
});

beforeEach(() => {
  root = mk('sm-art-root-');
  fs.mkdirSync(path.join(root, 'session-manager-operations'), { recursive: true });
  worktree = mk('sm-art-wt-');
  allowedTmp = mk('sm-art-tmp-');
  outside = mk('sm-art-outside-');
  resolveCalls = [];
  noticeCalls = [];
  ctxResult = { cwd: root, epicId: EPIC, epicCwd: root, source: 'epic-index' };
});

afterEach(() => {
  for (const d of [root, worktree, allowedTmp, outside]) fs.rmSync(d, { recursive: true, force: true });
});

function request({ method = 'GET', reqPath, auth = true, body }) {
  return new Promise((resolve, reject) => {
    /** @type {Record<string, string | number>} */
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${token}`;
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
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const publish = (body, auth = true) => request({ method: 'POST', reqPath: '/admin/artifacts/publish', body, auth });

test('publish copies an absolute file into the Epic store and returns storedPath, revealPath, entry', async () => {
  const src = path.join(root, 'demo.mp4');
  fs.writeFileSync(src, 'video-bytes');
  const r = await publish({ path: src, title: 'Demo', cwd: root, originClaudeSessionId: SESSION, sourcePromptId: EPIC });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.storedPath).toBe(path.join(root, 'session-manager-operations', 'artifacts', EPIC, 'demo.mp4'));
  expect(fs.readFileSync(r.json.storedPath, 'utf8')).toBe('video-bytes');
  expect(r.json.revealPath).toBe(`session-manager-operations/artifacts/${EPIC}/demo.mp4`);
  expect(r.json.entry).toMatchObject({ name: 'demo.mp4', title: 'Demo', kind: 'video', size: 11 });
  expect(r.json.entry.producer).toMatchObject({ epicId: EPIC, sessionId: SESSION });
  expect(resolveCalls[0]).toEqual({ cwd: root, originClaudeSessionId: SESSION, epicId: EPIC });
});

test('a relative path resolves against the Epic worktree, not the project root', async () => {
  fs.mkdirSync(path.join(worktree, 'out'));
  fs.writeFileSync(path.join(worktree, 'out', 'shot.png'), 'wt-image');
  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'out', 'shot.png'), 'root-image');
  const r = await publish({ path: 'out/shot.png', originClaudeSessionId: SESSION });
  expect(r.status).toBe(200);
  expect(fs.readFileSync(r.json.storedPath, 'utf8')).toBe('wt-image');
  expect(r.json.entry.kind).toBe('image');
});

test('a relative path falls back to the project root when the Epic has no worktree', async () => {
  ctxResult = { cwd: root, epicId: 'epic-nowt', epicCwd: root, source: 'epic-index' };
  fs.writeFileSync(path.join(root, 'notes.md'), 'root-notes');
  const r = await publish({ path: 'notes.md', sourcePromptId: 'epic-nowt' });
  expect(r.status).toBe(200);
  expect(fs.readFileSync(r.json.storedPath, 'utf8')).toBe('root-notes');
});

test('a file under the allowed tmp dir publishes', async () => {
  const src = path.join(allowedTmp, 'data.csv');
  fs.writeFileSync(src, 'a,b');
  const r = await publish({ path: src, originClaudeSessionId: SESSION });
  expect(r.status).toBe(200);
  expect(r.json.entry.kind).toBe('data');
});

test('a file outside every allowed root is refused with outside_root', async () => {
  const src = path.join(outside, 'secret.txt');
  fs.writeFileSync(src, 'nope');
  const r = await publish({ path: src, originClaudeSessionId: SESSION });
  expect(r.status).toBe(400);
  expect(r.json).toMatchObject({ ok: false, error: 'outside_root' });
  expect(fs.existsSync(path.join(root, 'session-manager-operations', 'artifacts', EPIC))).toBe(false);
});

test('a relative path escaping the worktree is refused with outside_root', async () => {
  fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
  const rel = path.relative(worktree, path.join(outside, 'x.txt'));
  const r = await publish({ path: rel, originClaudeSessionId: SESSION });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('outside_root');
});

test('a directory is refused with not_a_file; a missing file with not_found', async () => {
  fs.mkdirSync(path.join(root, 'adir'));
  const dir = await publish({ path: path.join(root, 'adir'), originClaudeSessionId: SESSION });
  expect(dir.status).toBe(400);
  expect(dir.json.error).toBe('not_a_file');
  const missing = await publish({ path: path.join(root, 'gone.txt'), originClaudeSessionId: SESSION });
  expect(missing.status).toBe(404);
  expect(missing.json.error).toBe('not_found');
});

test('no resolved Epic is refused with no_epic; no project with no_project', async () => {
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  ctxResult = { cwd: root, epicId: null, epicCwd: null, source: 'cwd' };
  const noEpic = await publish({ path: path.join(root, 'a.txt'), cwd: root });
  expect(noEpic.status).toBe(400);
  expect(noEpic.json.error).toBe('no_epic');
  ctxResult = { cwd: null, epicId: null, epicCwd: null, source: 'cwd' };
  const noProject = await publish({ path: 'a.txt' });
  expect(noProject.status).toBe(400);
  expect(noProject.json.error).toBe('no_project');
});

test('missing path and bad cwd are 400 bad_request', async () => {
  expect((await publish({ cwd: root })).json.error).toBe('bad_request');
  expect((await publish({ path: 'a.txt', cwd: 'relative/dir' })).json.error).toBe('bad_request');
});

test('requests without the bearer token get 401 and publish nothing', async () => {
  const src = path.join(root, 'demo.mp4');
  fs.writeFileSync(src, 'v');
  const r = await publish({ path: src, originClaudeSessionId: SESSION }, false);
  expect(r.status).toBe(401);
  expect(r.json).toEqual({ ok: false, error: 'unauthorized' });
  const list = await request({ reqPath: `/admin/artifacts?cwd=${encodeURIComponent(root)}`, auth: false });
  expect(list.status).toBe(401);
  expect(resolveCalls).toEqual([]);
  expect(fs.existsSync(path.join(root, 'session-manager-operations', 'artifacts'))).toBe(false);
});

test('GET /admin/artifacts lists published entries newest first for the resolved project', async () => {
  fs.writeFileSync(path.join(root, 'one.txt'), '1');
  fs.writeFileSync(path.join(root, 'two.txt'), '2');
  expect((await publish({ path: path.join(root, 'one.txt'), originClaudeSessionId: SESSION })).status).toBe(200);
  await new Promise((r) => setTimeout(r, 5));
  expect((await publish({ path: path.join(root, 'two.txt'), originClaudeSessionId: SESSION })).status).toBe(200);
  const r = await request({ reqPath: `/admin/artifacts?cwd=${encodeURIComponent(worktree)}` });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.projectRoot).toBe(root);
  expect(r.json.artifacts.map((e) => e.name)).toEqual(['two.txt', 'one.txt']);
  expect(r.json.artifacts[0].ownerId).toBe(EPIC);
  expect(resolveCalls.at(-1)).toEqual({ cwd: worktree });
});

test('GET /admin/artifacts without cwd is 400', async () => {
  const r = await request({ reqPath: '/admin/artifacts' });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('bad_request');
});

test('a successful Epic publish posts one artifact-ready notice with that entry; a refused one posts none', async () => {
  const src = path.join(root, 'demo.mp4');
  fs.writeFileSync(src, 'video-bytes');
  const r = await publish({ path: src, originClaudeSessionId: SESSION });
  expect(r.status).toBe(200);
  expect(noticeCalls).toHaveLength(1);
  expect(noticeCalls[0]).toEqual({
    cwd: root,
    epicId: EPIC,
    entries: [{ storedPath: r.json.storedPath, entry: r.json.entry }],
  });

  noticeCalls = [];
  const bad = path.join(outside, 'secret.txt');
  fs.writeFileSync(bad, 'nope');
  const refused = await publish({ path: bad, originClaudeSessionId: SESSION });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toBe('outside_root');
  expect(noticeCalls).toHaveLength(0);
});

test('publish into a fresh git repo project returns ok and its storedPath is git-ignored', async () => {
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const src = path.join(allowedTmp, 'demo.mp4');
  fs.writeFileSync(src, 'video-bytes');
  const r = await publish({ path: src, originClaudeSessionId: SESSION });
  expect(r.status).toBe(200);
  expect(r.json.ok).toBe(true);
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', r.json.storedPath], { cwd: root }); } catch { ignored = false; }
  expect(ignored).toBe(true);
});
