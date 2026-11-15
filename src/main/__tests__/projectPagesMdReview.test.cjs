/**
 * projectPagesMdReview.test.cjs — the `project-pages:md-review` IPC wiring:
 * the exported mdReview() handler on a scratch project (newest review record
 * plus a validation folder), the registered handler's schema rejecting a bad
 * Epic id, and the ephemeral-cwd refusal it shares with mdNetwork().
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/projectPagesMdReview.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// Capture ipcMain.handle registrations so the schema case runs the registered
// handler (zod + body). Must precede the requires below.
const ipcHandlers = new Map();
const electronPath = require.resolve('electron');
const electronStub = new Module(electronPath);
electronStub.filename = electronPath;
electronStub.loaded = true;
electronStub.exports = { ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) } };
require.cache[electronPath] = electronStub;

const config = require('../config.cjs');
const { mdReview, registerProjectPagesIpc } = require('../projectPages.cjs');
const { schemas } = require('../ipcSchemas.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

const RECORD = [
  '# Markdown network review 2026-11-15',
  '',
  '- Date: 2026-11-15',
  '- Mode: Drift check',
  '- Scope: the whole project',
  '- Owner: Bilko',
  '- Map: CLAUDE.md',
  '',
].join('\n');

async function mkProject() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-md-review-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Root\n');
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'pipe' });
  const ops = path.join(cwd, 'session-manager-operations', 'reviews');
  fs.mkdirSync(path.join(ops, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ops, 'docs', '2026-11-01-md-network.md'), '- Date: 2026-11-01\n');
  fs.writeFileSync(path.join(ops, 'docs', '2026-11-15-md-network.md'), RECORD);
  fs.mkdirSync(path.join(ops, 'validation', 'epic-abc'), { recursive: true });
  fs.writeFileSync(path.join(ops, 'validation', 'epic-abc', 'b.md'), '# b\n');
  fs.writeFileSync(path.join(ops, 'validation', 'epic-abc', 'a.md'), '# a\n');
  fs.writeFileSync(path.join(ops, 'validation', 'epic-abc', 'notes.txt'), 'x');
  return cwd;
}

test('mdReview returns the newest record and each Epic id\'s validation records', async () => {
  const cwd = await mkProject();
  const result = await mdReview({ cwd, epicIds: ['epic-abc', 'epic-none'] });
  expect(result.ok).toBe(true);
  expect(result.recordPath).toBe('session-manager-operations/reviews/docs/2026-11-15-md-network.md');
  expect(result.record).toEqual(expect.objectContaining({
    date: '2026-11-15',
    modeKind: 'Drift check',
    scope: 'the whole project',
    owner: 'Bilko',
    map: 'CLAUDE.md',
  }));
  expect(result.validation).toEqual({
    'epic-abc': [
      'session-manager-operations/reviews/validation/epic-abc/a.md',
      'session-manager-operations/reviews/validation/epic-abc/b.md',
    ],
    'epic-none': [],
  });

  // No epicIds -> no validation lookups.
  expect((await mdReview({ cwd })).validation).toEqual({});
});

test('mdReview refuses an ephemeral cwd like mdNetwork', async () => {
  config.addAllowedRoot(os.tmpdir());
  expect(await mdReview({ cwd: os.tmpdir() })).toEqual({ ok: false, error: expect.stringMatching(/ephemeral/) });
});

test('project-pages:md-review schema rejects a bad Epic id', async () => {
  const s = schemas.projectPagesMdReview;
  expect(s.safeParse({ cwd: '/x', epicIds: ['epic-abc'] }).success).toBe(true);
  expect(s.safeParse({ cwd: '/x' }).success).toBe(true);
  for (const bad of ['../etc', 'Epic', '-lead', 'a/b', '', 'a'.repeat(129)]) {
    expect(s.safeParse({ cwd: '/x', epicIds: [bad] }).success).toBe(false);
  }
  expect(s.safeParse({ cwd: '/x', epicIds: Array.from({ length: 51 }, (_, i) => `e${i}`) }).success).toBe(false);
  expect(s.safeParse({ cwd: '/x', extra: 1 }).success).toBe(false);

  registerProjectPagesIpc();
  const handler = ipcHandlers.get('project-pages:md-review');
  expect(typeof handler).toBe('function');
  const cwd = await mkProject();
  await expect((async () => handler({}, { cwd, epicIds: ['../outside'] }))()).rejects.toThrow();
  expect((await handler({}, { cwd, epicIds: ['epic-abc'] })).validation['epic-abc']).toHaveLength(2);
});
