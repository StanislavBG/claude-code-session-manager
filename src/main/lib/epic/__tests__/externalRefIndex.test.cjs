/**
 * externalRefIndex.test.cjs — the machine-level (cwd, externalRef) -> epicId
 * index, its open-Epic fallback, and the per-key in-process lock.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/externalRefIndex.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { externalRefIndexPath, schedulerHome } = require('../../scheduler/schedulerPaths.cjs');
const {
  recordExternalRef,
  lookupExternalRef,
  findEpicByExternalRef,
  withExternalRefLock,
} = require('../externalRefIndex.cjs');

const tmpDirs = [];
let prevHome;

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-extref-home-');
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function writeIndex(cwd, index) {
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify(index, null, 2));
}

function readFile() {
  return JSON.parse(fs.readFileSync(externalRefIndexPath(), 'utf8'));
}

test('externalRefIndexPath lives inside schedulerHome', () => {
  expect(externalRefIndexPath()).toBe(path.join(schedulerHome(), 'external-refs.json'));
});

test('record then lookup round-trips; file shape uses NUL-joined key and omits absent fields', async () => {
  const cwd = await mkTmp('sm-extref-cwd-');
  await recordExternalRef({ cwd, externalRef: 'portfolio:a1', epicId: 'e1', producer: 'cross-project-feedback', fromCwd: '/other' });
  const hit = await lookupExternalRef({ cwd, externalRef: 'portfolio:a1' });
  expect(hit).toMatchObject({ epicId: 'e1', producer: 'cross-project-feedback', fromCwd: '/other' });
  expect(typeof hit.at).toBe('string');
  const file = readFile();
  expect(file.version).toBe(1);
  const entry = file.refs[`${cwd}\u0000portfolio:a1`];
  expect(entry.epicId).toBe('e1');
  expect('macroId' in entry).toBe(false);
});

test('same ref under another cwd and an unknown ref return null', async () => {
  const cwd = await mkTmp('sm-extref-cwd-');
  const other = await mkTmp('sm-extref-cwd-');
  await recordExternalRef({ cwd, externalRef: 'r', epicId: 'e1', producer: 'new-epic-ui', macroId: 'm1' });
  expect(await lookupExternalRef({ cwd: other, externalRef: 'r' })).toBeNull();
  expect(await lookupExternalRef({ cwd, externalRef: 'nope' })).toBeNull();
  expect((await lookupExternalRef({ cwd, externalRef: 'r' })).macroId).toBe('m1');
});

test('findEpicByExternalRef marks open vs closed from the active index', async () => {
  const cwd = await mkTmp('sm-extref-cwd-');
  writeIndex(cwd, { sessions: { e1: { id: 'e1', source: { producer: 'new-epic-ui' } } }, events: {} });
  await recordExternalRef({ cwd, externalRef: 'open-ref', epicId: 'e1', producer: 'new-epic-ui' });
  await recordExternalRef({ cwd, externalRef: 'done-ref', epicId: 'e-gone', producer: 'new-epic-ui' });
  expect(await findEpicByExternalRef({ cwd, externalRef: 'open-ref' })).toMatchObject({ epicId: 'e1', open: true });
  expect(await findEpicByExternalRef({ cwd, externalRef: 'done-ref' })).toMatchObject({ epicId: 'e-gone', open: false });
});

test('findEpicByExternalRef falls back to open sessions, records the hit, else null', async () => {
  const cwd = await mkTmp('sm-extref-cwd-');
  writeIndex(cwd, {
    sessions: {
      e2: { id: 'e2', source: { producer: 'cross-project-feedback', fromCwd: '/asker', macroId: 'mac', externalRef: 'scan-ref' } },
      e3: { id: 'e3', source: { producer: 'new-epic-ui', externalRef: 'other' } },
      e4: { id: 'e4' },
    },
    events: {},
  });
  const hit = await findEpicByExternalRef({ cwd, externalRef: 'scan-ref' });
  expect(hit).toMatchObject({ epicId: 'e2', open: true, producer: 'cross-project-feedback', fromCwd: '/asker', macroId: 'mac' });
  const stored = await lookupExternalRef({ cwd, externalRef: 'scan-ref' });
  expect(stored).toMatchObject({ epicId: 'e2', producer: 'cross-project-feedback', fromCwd: '/asker', macroId: 'mac' });
  expect('open' in stored).toBe(false);
  expect(await findEpicByExternalRef({ cwd, externalRef: 'missing' })).toBeNull();
});

test('withExternalRefLock serializes same key, runs different keys concurrently, passes results and rejections', async () => {
  const cwd = '/p';
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const task = (name, ms) => async () => { log.push(`${name}:start`); await sleep(ms); log.push(`${name}:end`); return name; };
  const [a, b] = await Promise.all([
    withExternalRefLock({ cwd, externalRef: 'k' }, task('a', 30)),
    withExternalRefLock({ cwd, externalRef: 'k' }, task('b', 5)),
  ]);
  expect([a, b]).toEqual(['a', 'b']);
  expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);

  log.length = 0;
  await Promise.all([
    withExternalRefLock({ cwd, externalRef: 'x' }, task('x', 30)),
    withExternalRefLock({ cwd, externalRef: 'y' }, task('y', 5)),
  ]);
  expect(log).toEqual(['x:start', 'y:start', 'y:end', 'x:end']);

  const boom = withExternalRefLock({ cwd, externalRef: 'k' }, async () => { throw new Error('boom'); });
  const after = withExternalRefLock({ cwd, externalRef: 'k' }, async () => 'after');
  await expect(boom).rejects.toThrow('boom');
  await expect(after).resolves.toBe('after');
});

test.each([
  ['missing', null],
  ['empty', ''],
  ['corrupt', '{not json'],
  ['wrong shape', '[1,2,3]'],
])('a %s index file reads as empty and is replaced by the next record', async (_label, content) => {
  const cwd = await mkTmp('sm-extref-cwd-');
  if (content !== null) {
    fs.mkdirSync(path.dirname(externalRefIndexPath()), { recursive: true });
    fs.writeFileSync(externalRefIndexPath(), content);
  }
  expect(await lookupExternalRef({ cwd, externalRef: 'r' })).toBeNull();
  expect(await findEpicByExternalRef({ cwd, externalRef: 'r' })).toBeNull();
  await expect(withExternalRefLock({ cwd, externalRef: 'r' }, async () => 1)).resolves.toBe(1);
  await recordExternalRef({ cwd, externalRef: 'r', epicId: 'e1', producer: 'new-epic-ui' });
  expect(readFile()).toMatchObject({ version: 1, refs: { [`${cwd}\u0000r`]: { epicId: 'e1' } } });
});

test('two records issued together both land in the file', async () => {
  const cwd = await mkTmp('sm-extref-cwd-');
  await Promise.all([
    recordExternalRef({ cwd, externalRef: 'one', epicId: 'e1', producer: 'new-epic-ui' }),
    recordExternalRef({ cwd, externalRef: 'two', epicId: 'e2', producer: 'new-epic-ui' }),
  ]);
  const refs = readFile().refs;
  expect(refs[`${cwd}\u0000one`].epicId).toBe('e1');
  expect(refs[`${cwd}\u0000two`].epicId).toBe('e2');
});
