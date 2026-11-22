/**
 * videoReviewIpc.test.cjs — project-videos:review-list / review-decide over the
 * real runToolJob + dispatchMacroJob + videoReview store, in a temp cwd.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/videoReviewIpc.test.cjs
 */

'use strict';

import { test, expect, vi, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerVideoReviewIpc, formatLocalAt, replaceEntryInstructions, INACTIVE_ERROR } = require('../videoReviewIpc.cjs');
const videoReview = require('../videoReview.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTmpCwd() {
  const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-video-review-ipc-')));
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const ENTRY = 'vid-abc';

const tool = (cwd) => ({
  id: 'tool-v', label: 'Short video', surface: 'project-video', projects: [cwd],
  agentName: 'demo-video-builder', tag: 'feature', prompt: 'Make {{topic}}',
  inputs: [{ name: 'topic', label: 'Topic', required: true }],
  job: { estimateMinutes: 10, review: true },
});

async function setup({ epicStatus = 'active', createPrd, ...over } = {}) {
  const cwd = await mkTmpCwd();
  expect((await videoReview.recordDispatch(cwd, ENTRY, {
    macroId: 'tool-v', epicId: 'e1', slug: 'short-video-build-1', stage: 'review',
    inputValues: { topic: 'cats' }, extraInstructions: 'keep it short\nReplace entry: vid-old',
  })).ok).toBe(true);
  expect((await videoReview.writeMaterial(cwd, ENTRY, { text: 'script', images: [{ bytes: PNG }] })).ok).toBe(true);
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const deps = {
    schemas,
    validatePath: vi.fn((p) => p),
    readActiveIndex: vi.fn(() => ({ sessions: { e1: { status: epicStatus } } })),
    createPrd: createPrd || vi.fn(async () => ({ ok: true })),
    loadJobs: vi.fn(async () => []),
    archivePrd: vi.fn(async () => ({})),
    listMacros: vi.fn(async () => [tool(cwd)]),
    appendResponseEventWithReason: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  registerVideoReviewIpc(ipcMain, deps);
  const decide = (p) => handlers['project-videos:review-decide']({}, { cwd, entryId: ENTRY, ...p });
  return { cwd, handlers, deps, decide };
}

const decisionPath = (cwd) => path.join(cwd, 'session-manager-operations', 'project-pages', 'videos', ENTRY, 'review', 'decision.json');

test('registers exactly the two renderer channels', async () => {
  const { handlers } = await setup();
  expect(Object.keys(handlers).sort()).toEqual(['project-videos:review-decide', 'project-videos:review-list']);
});

test('review-list returns listReviews for a validatePath-checked cwd', async () => {
  const { cwd, handlers, deps } = await setup();
  const r = await handlers['project-videos:review-list']({}, { cwd });
  expect(deps.validatePath).toHaveBeenCalledWith(cwd);
  expect(r).toEqual(await videoReview.listReviews(cwd));
  expect(r[0]).toMatchObject({ entryId: ENTRY, status: 'waiting' });
});

test('schemas are strict; entryId matches ENTRY_ID_RE; note at most 2000 chars', () => {
  const ok = { cwd: '/p', entryId: 'vid-1', decision: 'approve' };
  expect(schemas.projectVideosReviewDecide.parse(ok)).toEqual(ok);
  expect(schemas.projectVideosReviewDecide.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  expect(schemas.projectVideosReviewDecide.safeParse({ ...ok, entryId: '_character' }).success).toBe(false);
  expect(schemas.projectVideosReviewDecide.safeParse({ ...ok, decision: 'approved' }).success).toBe(false);
  expect(schemas.projectVideosReviewDecide.safeParse({ ...ok, note: 'x'.repeat(2000) }).success).toBe(true);
  expect(schemas.projectVideosReviewDecide.safeParse({ ...ok, note: 'x'.repeat(2001) }).success).toBe(false);
  expect(schemas.projectVideosReviewList.safeParse({ cwd: '/p', x: 1 }).success).toBe(false);
});

test('approve: final run carries the approval and Replace entry; decision.json keeps the same at', async () => {
  const { cwd, deps, decide } = await setup();
  const r = await decide({ decision: 'approve' });
  expect(r.ok).toBe(true);
  expect(r.stage).toBe('final');
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
  const goal = deps.createPrd.mock.calls[0][0].goal;
  expect(goal).toContain('Make cats');
  expect(goal).toContain('keep it short');
  expect(goal).toContain(`Replace entry: ${ENTRY}`);
  expect(goal).not.toContain('vid-old');
  const m = /Review: approved by the owner at (.+)/.exec(goal);
  expect(m).not.toBeNull();
  const decision = JSON.parse(fs.readFileSync(decisionPath(cwd), 'utf8'));
  expect(decision).toMatchObject({ entryId: ENTRY, decision: 'approve' });
  expect(m[1].trim()).toBe(decision.at);
  expect(decision.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
  expect((await videoReview.readReview(cwd, ENTRY)).status).toBe('approved');
});

test('changes: the note is carried and the review stage runs again', async () => {
  const { cwd, deps, decide } = await setup();
  const r = await decide({ decision: 'changes', note: 'brighter colors' });
  expect(r.ok).toBe(true);
  expect(r.stage).toBe('review');
  const input = deps.createPrd.mock.calls[0][0];
  expect(input.goal).toContain('Review: changes requested: brighter colors');
  expect(input.goal).toContain('Review stage:');
  expect(input.goal).toContain(`Replace entry: ${ENTRY}`);
  const decision = JSON.parse(fs.readFileSync(decisionPath(cwd), 'utf8'));
  expect(decision).toMatchObject({ decision: 'changes', note: 'brighter colors' });
  const rev = await videoReview.readReview(cwd, ENTRY);
  expect(rev.dispatch.stage).toBe('review');
  expect(rev.status).toBe('changes-requested');
});

test('changes without a note is refused before any dispatch', async () => {
  const { cwd, deps, decide } = await setup();
  expect((await decide({ decision: 'changes' })).ok).toBe(false);
  expect(deps.createPrd).not.toHaveBeenCalled();
  expect(fs.existsSync(decisionPath(cwd))).toBe(false);
});

test('an Epic that is no longer active returns the press-again error and writes nothing', async () => {
  for (const readActiveIndex of [() => ({ sessions: { e1: { status: 'completed' } } }), () => ({ sessions: {} })]) {
    const { cwd, deps, decide } = await setup({ readActiveIndex: vi.fn(readActiveIndex) });
    expect(await decide({ decision: 'approve' })).toEqual({ ok: false, error: INACTIVE_ERROR });
    expect(deps.createPrd).not.toHaveBeenCalled();
    expect(deps.appendResponseEventWithReason).not.toHaveBeenCalled();
    expect(fs.existsSync(decisionPath(cwd))).toBe(false);
  }
});

test('a second decide after the first is refused', async () => {
  const { deps, decide } = await setup();
  expect((await decide({ decision: 'approve' })).ok).toBe(true);
  const again = await decide({ decision: 'changes', note: 'x' });
  expect(again.ok).toBe(false);
  expect(again.error).toMatch(/not waiting/);
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
});

test('two concurrent decides dispatch once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const createPrd = vi.fn(async () => { await gate; return { ok: true }; });
  const { decide } = await setup({ createPrd });
  const first = decide({ decision: 'approve' });
  const second = await decide({ decision: 'approve' });
  expect(second.ok).toBe(false);
  expect(second.error).toMatch(/already being sent/);
  release();
  expect((await first).ok).toBe(true);
  expect(createPrd).toHaveBeenCalledTimes(1);
});

test('a failed dispatch writes no decision and returns its error; the entry stays decidable', async () => {
  const createPrd = vi.fn(async () => ({ ok: false, error: 'queue full' }));
  const { cwd, decide } = await setup({ createPrd });
  expect(await decide({ decision: 'approve' })).toEqual({ ok: false, error: 'queue full' });
  expect(fs.existsSync(decisionPath(cwd))).toBe(false);
  expect((await videoReview.readReview(cwd, ENTRY)).status).toBe('waiting');
});

test('formatLocalAt and replaceEntryInstructions', () => {
  expect(formatLocalAt(new Date())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
  expect(replaceEntryInstructions('a\n  replace entry: x\nb', 'vid-1')).toBe('a\nb\nReplace entry: vid-1');
  expect(replaceEntryInstructions(undefined, 'vid-1')).toBe('Replace entry: vid-1');
});
