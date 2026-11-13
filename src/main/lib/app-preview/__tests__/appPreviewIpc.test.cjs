/**
 * appPreviewIpc.test.cjs — main resolves the preview dir from the active index
 * (live worktree → worktree; missing restorable worktree → refused; merged /
 * none → project cwd; proposed / unknown Epic → refused) and the handlers
 * return { ok:false } on a resolve failure instead of throwing.
 *
 * Run: timeout 120 npx vitest run src/main/lib/app-preview/__tests__/appPreviewIpc.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { resolveAppPreviewDir, registerAppPreviewHandlers } = require('../appPreviewIpc.cjs');

const CWD = '/proj';
const WT = '/tmp/session-manager-epic-worktrees/e1';

function deps(sessions, { existing = [WT, CWD], badPath = false } = {}) {
  return {
    validatePath: (p) => { if (badPath) throw new Error('Path outside allowed roots'); return p; },
    readActiveIndex: () => ({ sessions, events: {}, tombstones: {} }),
    statSync: (p) => {
      if (!existing.includes(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => true };
    },
  };
}

describe('resolveAppPreviewDir', () => {
  test('active Epic with a live worktree dir → worktree', () => {
    const r = resolveAppPreviewDir({ cwd: CWD, epicId: 'e1', deps: deps({ e1: { status: 'active', worktree: { dir: WT, status: 'active' } } }) });
    expect(r).toEqual({ ok: true, dir: WT, inWorktree: true });
  });

  test('restorable worktree whose dir is missing → refused, never the main checkout', () => {
    const r = resolveAppPreviewDir({ cwd: CWD, epicId: 'e1', deps: deps({ e1: { status: 'active', worktree: { dir: WT, status: 'active' } } }, { existing: [CWD] }) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/worktree folder is missing/);
    expect(r.error).toMatch(/Chat or Terminal/);
  });

  test('merged worktree → project cwd', () => {
    const r = resolveAppPreviewDir({ cwd: CWD, epicId: 'e1', deps: deps({ e1: { status: 'active', worktree: { dir: WT, status: 'merged' } } }, { existing: [CWD] }) });
    expect(r).toEqual({ ok: true, dir: CWD, inWorktree: false });
  });

  test('disabled worktree → project cwd', () => {
    const r = resolveAppPreviewDir({ cwd: CWD, epicId: 'e1', deps: deps({ e1: { status: 'active', worktree: { dir: WT, status: 'disabled' } } }) });
    expect(r).toEqual({ ok: true, dir: CWD, inWorktree: false });
  });

  test('no worktree record → project cwd', () => {
    const r = resolveAppPreviewDir({ cwd: CWD, epicId: 'e1', deps: deps({ e1: { status: 'active' } }) });
    expect(r).toEqual({ ok: true, dir: CWD, inWorktree: false });
  });

  test('proposed Epic refused', () => {
    const r = resolveAppPreviewDir({ cwd: CWD, epicId: 'e1', deps: deps({ e1: { status: 'proposed' } }) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not active/);
  });

  test('unknown Epic refused', () => {
    const r = resolveAppPreviewDir({ cwd: CWD, epicId: 'nope', deps: deps({}) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  test('validatePath throwing → refused, not thrown', () => {
    const r = resolveAppPreviewDir({ cwd: '/etc', epicId: 'e1', deps: deps({}, { badPath: true }) });
    expect(r).toEqual({ ok: false, error: 'Path outside allowed roots' });
  });
});

describe('registerAppPreviewHandlers', () => {
  function fakeIpc() {
    const handlers = new Map();
    return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
  }

  test('registers the four channels', () => {
    const ipc = fakeIpc();
    registerAppPreviewHandlers(ipc, { getWindow: () => null });
    expect([...ipc.handlers.keys()].sort()).toEqual(['appPreview:list', 'appPreview:scripts', 'appPreview:start', 'appPreview:stop']);
  });

  test('start and scripts return { ok:false } on a resolve failure (unknown Epic)', async () => {
    const ipc = fakeIpc();
    registerAppPreviewHandlers(ipc, { getWindow: () => null });
    // An unknown Epic in a nonexistent project — either validatePath or the
    // Epic lookup refuses; neither throws.
    const cwd = '/nonexistent-sm-preview-test-dir';
    const start = await ipc.handlers.get('appPreview:start')({}, { cwd, epicId: 'missing-epic', script: 'dev' });
    expect(start.ok).toBe(false);
    expect(typeof start.error).toBe('string');
    const scripts = await ipc.handlers.get('appPreview:scripts')({}, { cwd, epicId: 'missing-epic' });
    expect(scripts.ok).toBe(false);
    expect(typeof scripts.error).toBe('string');
  });

  test('payload validation rejects a hostile script name', () => {
    const ipc = fakeIpc();
    registerAppPreviewHandlers(ipc, { getWindow: () => null });
    expect(() => ipc.handlers.get('appPreview:start')({}, { cwd: CWD, epicId: 'e1', script: '--inspect' })).toThrow();
  });

  test('list returns an array', async () => {
    const ipc = fakeIpc();
    registerAppPreviewHandlers(ipc, { getWindow: () => null });
    expect(Array.isArray(await ipc.handlers.get('appPreview:list')({}))).toBe(true);
  });
});
