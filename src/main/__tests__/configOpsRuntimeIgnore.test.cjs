/**
 * configOpsRuntimeIgnore.test.cjs — config.cjs's shared ops write helpers
 * (writeTextAtomic → writeJson, writeBinaryAtomic, writeJsonSync,
 * writeRendererText) self-ignore the target RUNTIME namespace right after the
 * single-writer gate passes and before any byte lands, so a project Session
 * Manager only writes to (no ~/.claude/projects entry → no hourly sweep) never
 * shows its runtime state to git.
 *
 * Roots live under os.homedir() (not os.tmpdir()): opsPath() refuses ephemeral
 * tmpdir roots, which would make validateWrite refuse every ops write.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/configOpsRuntimeIgnore.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../config.cjs');

const OPS = 'session-manager-operations';
const roots = [];
afterEach(async () => {
  while (roots.length) await fsp.rm(roots.pop(), { recursive: true, force: true });
});

async function mkGitProject(tag) {
  const root = await fsp.mkdtemp(path.join(os.homedir(), `.sm-configopsignore-${tag}-`));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  config.addAllowedRoot(root);
  return fs.realpathSync(root);
}

function porcelain(root, sub) {
  return execFileSync('git', ['status', '--porcelain', '-uall', '--', sub], { cwd: root, encoding: 'utf8' });
}

test('writeJson into prompt-sessions/active-index.json self-ignores the namespace in a fresh git repo', async () => {
  const root = await mkGitProject('epics');
  const target = path.join(root, OPS, 'prompt-sessions', 'active-index.json');
  const res = await config.writeJson(target, { sessions: [] }, { writer: 'epics' });
  expect(res.ok).toBe(true);
  expect(fs.existsSync(target)).toBe(true);
  const gi = path.join(root, OPS, 'prompt-sessions', '.gitignore');
  expect(fs.readFileSync(gi, 'utf8').split('\n')).toContain('*');
  expect(porcelain(root, `${OPS}/prompt-sessions`)).toBe('');
});

test('writeBinaryAtomic, writeJsonSync and writeRendererText each self-ignore their runtime namespace', async () => {
  const root = await mkGitProject('others');
  const bin = path.join(root, OPS, 'logs', 'shot.bin');
  await config.writeBinaryAtomic(bin, Buffer.from([1, 2, 3]), { writer: 'logs' });
  const sync = path.join(root, OPS, 'ui-prefs', 'prefs.json');
  config.writeJsonSync(sync, { a: 1 }, { writer: 'ui-prefs' });
  const txt = path.join(root, OPS, 'tasks', 'note.txt');
  await config.writeRendererText(txt, 'hi', { writer: 'tasks' });
  for (const ns of ['logs', 'ui-prefs', 'tasks']) {
    expect(fs.readFileSync(path.join(root, OPS, ns, '.gitignore'), 'utf8')).toBe('*\n');
    expect(porcelain(root, `${OPS}/${ns}`)).toBe('');
  }
});

test('a write into an authored namespace creates no .gitignore', async () => {
  const root = await mkGitProject('authored');
  const target = path.join(root, OPS, 'project-pages', 'knowledge', 'overview', 'page.md');
  await config.writeTextAtomic(target, '# hi\n', { writer: 'project-home' });
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.existsSync(path.join(root, OPS, 'project-pages', '.gitignore'))).toBe(false);
  expect(fs.existsSync(path.join(root, OPS, 'project-pages', 'knowledge', 'overview', '.gitignore'))).toBe(false);
});

test('a write into reviews/ (authored, not a writable namespace) is refused and creates no .gitignore', async () => {
  const root = await mkGitProject('reviews');
  const target = path.join(root, OPS, 'reviews', 'r.md');
  await expect(config.writeTextAtomic(target, 'x', { writer: 'epics' })).rejects.toThrow();
  expect(fs.existsSync(path.join(root, OPS, 'reviews'))).toBe(false);
});

test('a write refused by assertOpsWrite creates no .gitignore and no namespace dir', async () => {
  const root = await mkGitProject('refused');
  const target = path.join(root, OPS, 'prompt-sessions', 'active-index.json');
  await expect(config.writeJson(target, {}, { writer: 'logs' })).rejects.toThrow();
  expect(() => config.writeJsonSync(target, {}, { writer: 'logs' })).toThrow();
  expect(fs.existsSync(path.join(root, OPS, 'prompt-sessions'))).toBe(false);
});

test('when ensureRuntimeIgnoreForPath throws, the helper throws that error and the target is not written', async () => {
  const root = await mkGitProject('throws');
  const nsDir = path.join(root, OPS, 'prompt-sessions');
  // A directory sitting at the .gitignore path → ensureRuntimeIgnore's write fails.
  fs.mkdirSync(path.join(nsDir, '.gitignore'), { recursive: true });
  const { ensureRuntimeIgnoreForPath } = require('../lib/opsOwnership.cjs');
  const target = path.join(nsDir, 'active-index.json');
  let expected;
  try { ensureRuntimeIgnoreForPath(target); } catch (e) { expected = e; }
  expect(expected && expected.code).toBe('EISDIR');
  const same = { code: expected.code, syscall: expected.syscall };
  const syncErr = (fn) => { try { fn(); } catch (e) { return e; } return null; };
  await expect(config.writeJson(target, { a: 1 }, { writer: 'epics' })).rejects.toMatchObject(same);
  expect(syncErr(() => config.writeJsonSync(target, { a: 1 }, { writer: 'epics' }))).toMatchObject(same);
  await expect(config.writeBinaryAtomic(target, Buffer.from('x'), { writer: 'epics' })).rejects.toMatchObject(same);
  await expect(config.writeRendererText(target, 'x', { writer: 'epics' })).rejects.toMatchObject(same);
  expect(fs.existsSync(target)).toBe(false);
});
