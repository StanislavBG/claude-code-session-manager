// @ts-check
/**
 * projectCreate.test.cjs — createServiceProject: refusals create nothing, the
 * created path (real git in a temp dir, fake gh), gh failure, rollback,
 * existing, gone, and concurrent same-ref calls.
 *
 * Run: timeout 180 npx vitest run src/main/lib/feedback-remote/__tests__/projectCreate.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServiceProject, SERVICE_PROJECT_NAME_RE } = require('../projectCreate.cjs');
const { createCreatedProjects } = require('../createdProjects.cjs');
const { execGit } = require('../../git/gitExec.cjs');
const { OPS_ROOT_DIR } = require('../../opsOwnership.cjs');

const GIT_ENV_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const LOGIN = 'example-owner';

/** @type {string} */ let tmp;
/** @type {string} */ let parentDir;
/** @type {string} */ let fromCwd;
/** @type {ReturnType<typeof createCreatedProjects>} */ let ledger;
/** @type {Array<{ kind: string, fields: Record<string, unknown> }>} */ let audits;
/** @type {Record<string, string | undefined>} */ let prevEnv;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-create-')));
  parentDir = path.join(tmp, 'projects');
  fromCwd = path.join(tmp, 'service');
  fs.mkdirSync(parentDir);
  fs.mkdirSync(fromCwd);
  ledger = createCreatedProjects({ filePath: path.join(tmp, 'ledger', 'created-projects.json') });
  audits = [];
  prevEnv = {};
  for (const k of GIT_ENV_KEYS) prevEnv[k] = process.env[k];
  process.env.GIT_AUTHOR_NAME = 'Test Author';
  process.env.GIT_AUTHOR_EMAIL = 'test-author@example.invalid';
  process.env.GIT_COMMITTER_NAME = 'Test Author';
  process.env.GIT_COMMITTER_EMAIL = 'test-author@example.invalid';
});

afterEach(() => {
  for (const k of GIT_ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Fake gh: `api user` answers the login; `repo create` adds a GitHub origin
 * (or fails when told to). Records every call.
 * @param {{ failUser?: boolean, failCreate?: boolean }} [opts]
 */
function fakeGh(opts = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @param {string[]} args */
  const execGh = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') {
      if (opts.failUser) throw new Error('gh: not logged in');
      return { stdout: `${LOGIN}\n` };
    }
    if (args[0] === 'repo' && args[1] === 'create') {
      if (opts.failCreate) throw Object.assign(new Error('gh failed'), { stderrText: 'HTTP 422: name already exists' });
      const source = args.find((a) => a.startsWith('--source='));
      const cwd = source ? source.slice('--source='.length) : '';
      await execGit(cwd, ['remote', 'add', 'origin', `git@github.com:${args[2]}.git`]);
      return { stdout: '' };
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { execGh, calls };
}

/** @param {Record<string, unknown>} [extra] */
function deps(extra = {}) {
  return {
    ledger,
    validatePath: (/** @type {string} */ p) => p,
    appendAudit: (/** @type {string} */ kind, /** @type {Record<string, unknown>} */ fields) => { audits.push({ kind, fields }); },
    execGh: fakeGh().execGh,
    ...extra,
  };
}

/** @param {Record<string, unknown>} [over] */
function input(over = {}) {
  return { name: 'new-tool', parentDir, fromCwd, externalRef: 'kiln:idea-1', ...over };
}

function expectNothingCreated() {
  expect(fs.readdirSync(parentDir)).toEqual([]);
  expect(ledger.list()).toEqual([]);
  expect(audits).toEqual([]);
}

test('SERVICE_PROJECT_NAME_RE is the documented pattern', () => {
  expect(SERVICE_PROJECT_NAME_RE.source).toBe('^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$');
});

const refusals = [
  ['missing externalRef', { externalRef: undefined }, 400, 'invalid-ref'],
  ['invalid externalRef', { externalRef: 'has space' }, 400, 'invalid-ref'],
  ['relative fromCwd', { fromCwd: 'rel/path' }, 400, 'invalid-ref'],
  ['relative parentDir', { parentDir: 'rel' }, 400, 'invalid-parent'],
  ['missing parentDir', { parentDir: '/definitely/not/here-xyz' }, 400, 'invalid-parent'],
  ['bad name chars', { name: 'bad name' }, 400, 'invalid-name'],
  ['leading dot', { name: '.hidden' }, 400, 'invalid-name'],
  ['slash in name', { name: 'a/b' }, 400, 'invalid-name'],
  ['name ending .git', { name: 'thing.git' }, 400, 'invalid-name'],
  ['too long name', { name: 'a'.repeat(101) }, 400, 'invalid-name'],
  ['public github', { github: { private: false } }, 400, 'invalid-github'],
];

for (const [label, over, status, code] of refusals) {
  test(`refuses ${label} and creates nothing`, async () => {
    const r = await createServiceProject(input(/** @type {Record<string, unknown>} */ (over)), deps());
    expect(r).toMatchObject({ ok: false, status, code });
    expectNothingCreated();
  });
}

test('refuses a parentDir validatePath rejects', async () => {
  const r = await createServiceProject(input(), deps({
    validatePath: () => { throw new Error('Path outside allowed boundaries'); },
  }));
  expect(r).toMatchObject({ ok: false, status: 400, code: 'invalid-parent' });
  expectNothingCreated();
});

test('refuses a parentDir that is a file', async () => {
  const file = path.join(tmp, 'a-file');
  fs.writeFileSync(file, 'x');
  const r = await createServiceProject(input({ parentDir: file }), deps());
  expect(r).toMatchObject({ ok: false, status: 400, code: 'invalid-parent' });
  expectNothingCreated();
});

test('refuses when gh api user fails', async () => {
  const r = await createServiceProject(input({ github: true }), deps({ execGh: fakeGh({ failUser: true }).execGh }));
  expect(r).toMatchObject({ ok: false, status: 400, code: 'gh-unavailable' });
  expectNothingCreated();
});

test('refuses a github.owner that is not the gh login', async () => {
  const r = await createServiceProject(input({ github: { owner: 'another-owner' } }), deps());
  expect(r).toMatchObject({ ok: false, status: 403, code: 'gh-owner' });
  expectNothingCreated();
});

test('refuses an existing folder the ledger does not hold', async () => {
  fs.mkdirSync(path.join(parentDir, 'new-tool'));
  fs.writeFileSync(path.join(parentDir, 'new-tool', 'keep.txt'), 'mine');
  const r = await createServiceProject(input(), deps());
  expect(r).toMatchObject({ ok: false, status: 409, code: 'exists' });
  expect(fs.readFileSync(path.join(parentDir, 'new-tool', 'keep.txt'), 'utf8')).toBe('mine');
  expect(ledger.list()).toEqual([]);
  expect(audits).toEqual([]);
});

test('creates the folder, git repo on main with one empty commit, ops root, ledger entry, audit row', async () => {
  const r = await createServiceProject(input(), deps());
  const cwd = path.join(parentDir, 'new-tool');
  expect(r).toEqual({ ok: true, status: 'created', cwd, name: 'new-tool', externalRef: 'kiln:idea-1', repo: null });
  expect((await execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
  expect((await execGit(cwd, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  expect((await execGit(cwd, ['ls-tree', '-r', 'HEAD'])).trim()).toBe('');
  expect(fs.readdirSync(path.join(cwd, OPS_ROOT_DIR))).toEqual([]);
  expect(ledger.findByRef(fromCwd, 'kiln:idea-1')).toMatchObject({ cwd, fromCwd, externalRef: 'kiln:idea-1', repo: null });
  expect(audits).toEqual([{ kind: 'project_created', fields: { cwd, fromCwd, externalRef: 'kiln:idea-1', repo: null } }]);
});

test('creates a private GitHub repo as origin when github is requested', async () => {
  const gh = fakeGh();
  const r = await createServiceProject(input({ github: { owner: LOGIN, private: true } }), deps({ execGh: gh.execGh }));
  const cwd = path.join(parentDir, 'new-tool');
  const repo = { fullName: `${LOGIN}/new-tool`, url: `https://github.com/${LOGIN}/new-tool`, private: true };
  expect(r).toMatchObject({ ok: true, status: 'created', cwd, repo });
  expect(gh.calls[1]).toEqual([
    'repo', 'create', `${LOGIN}/new-tool`, '--private', `--source=${cwd}`, '--remote=origin', '--push',
  ]);
  expect(ledger.findByCwd(cwd)?.repo).toBe(repo.url);
});

test('a gh failure after the local steps keeps the local project', async () => {
  const r = await createServiceProject(input({ github: true }), deps({ execGh: fakeGh({ failCreate: true }).execGh }));
  const cwd = path.join(parentDir, 'new-tool');
  expect(r).toMatchObject({ ok: true, status: 'created', cwd, repo: null, github: { ok: false } });
  expect(/** @type {{ github: { error: string } }} */ (r).github.error).toContain('name already exists');
  expect(fs.existsSync(path.join(cwd, '.git'))).toBe(true);
  expect(ledger.findByCwd(cwd)).not.toBeNull();
});

test('a failing git step removes the folder it created and answers 500 io', async () => {
  /** @param {string} cwd @param {string[]} args */
  const failingGit = async (cwd, args) => {
    if (args[0] === 'commit') {
      throw Object.assign(new Error('git commit failed'), { stderrText: 'Author identity unknown\n*** Please tell me who you are.' });
    }
    return execGit(cwd, args);
  };
  const r = await createServiceProject(input(), deps({ execGit: failingGit }));
  expect(r).toMatchObject({ ok: false, status: 500, code: 'io' });
  expect(/** @type {{ error: string }} */ (r).error).toMatch(/user\.name and user\.email/);
  expectNothingCreated();
});

test('a failing git init rolls back too', async () => {
  const r = await createServiceProject(input(), deps({ execGit: async () => { throw new Error('no git'); } }));
  expect(r).toMatchObject({ ok: false, status: 500, code: 'io' });
  expectNothingCreated();
});

test('a repeat with the same ref answers existing, reading origin', async () => {
  const first = await createServiceProject(input({ github: true }), deps());
  expect(first).toMatchObject({ status: 'created' });
  const gh = fakeGh();
  const again = await createServiceProject(input({ name: 'other-name', github: true }), deps({ execGh: gh.execGh }));
  const cwd = path.join(parentDir, 'new-tool');
  expect(again).toEqual({
    ok: true, status: 'existing', existing: true, cwd, name: 'new-tool', externalRef: 'kiln:idea-1',
    repo: { fullName: `${LOGIN}/new-tool`, url: `https://github.com/${LOGIN}/new-tool`, private: true },
  });
  expect(gh.calls.filter((c) => c[0] === 'repo')).toEqual([]);
  expect(fs.readdirSync(parentDir)).toEqual(['new-tool']);
  expect(audits).toHaveLength(1);
});

test('existing retries the GitHub step when origin is unset', async () => {
  await createServiceProject(input({ github: true }), deps({ execGh: fakeGh({ failCreate: true }).execGh }));
  const again = await createServiceProject(input({ github: true }), deps());
  expect(again).toMatchObject({
    ok: true, status: 'existing', existing: true,
    repo: { fullName: `${LOGIN}/new-tool`, private: true },
  });
});

test('existing without github leaves repo null', async () => {
  await createServiceProject(input(), deps());
  const again = await createServiceProject(input(), deps());
  expect(again).toMatchObject({ ok: true, status: 'existing', repo: null });
});

test('a recorded folder that is gone answers 409 gone', async () => {
  await createServiceProject(input(), deps());
  fs.rmSync(path.join(parentDir, 'new-tool'), { recursive: true, force: true });
  const again = await createServiceProject(input(), deps());
  expect(again).toMatchObject({ ok: false, status: 409, code: 'gone' });
  expect(fs.readdirSync(parentDir)).toEqual([]);
});

test('two concurrent same-ref calls create one folder', async () => {
  const [a, b] = await Promise.all([
    createServiceProject(input(), deps()),
    createServiceProject(input(), deps()),
  ]);
  const statuses = [a, b].map((r) => /** @type {{ status: string }} */ (r).status).sort();
  expect(statuses).toEqual(['created', 'existing']);
  expect(fs.readdirSync(parentDir)).toEqual(['new-tool']);
  expect(ledger.list()).toHaveLength(1);
  expect(audits).toHaveLength(1);
});
