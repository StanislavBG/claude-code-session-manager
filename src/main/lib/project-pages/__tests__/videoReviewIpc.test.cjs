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
const { registerVideoReviewIpc, formatLocalAt, replaceEntryInstructions, retryable, INACTIVE_ERROR, NOT_RETRYABLE_ERROR } = require('../videoReviewIpc.cjs');
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

async function setup({ epicStatus = 'active', createPrd, macroId = 'tool-v', ...over } = {}) {
  const cwd = await mkTmpCwd();
  expect((await videoReview.recordDispatch(cwd, ENTRY, {
    macroId, epicId: 'e1', slug: 'short-video-build-1', stage: 'review',
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
    checkProjectVideoToolRunnable: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  registerVideoReviewIpc(ipcMain, deps);
  const decide = (p) => handlers['project-videos:review-decide']({}, { cwd, entryId: ENTRY, ...p });
  const retry = () => handlers['project-videos:review-retry']({}, { cwd, entryId: ENTRY });
  return { cwd, handlers, deps, decide, retry };
}

/** An approved entry whose final run's job row has `status` (null = no row). */
async function approvedWithJob(status, over = {}) {
  const ctx = await setup(over);
  expect((await ctx.decide({ decision: 'approve' })).ok).toBe(true);
  const rev = await videoReview.readReview(ctx.cwd, ENTRY);
  const finalSlug = rev.dispatch.slug;
  const rows = status ? [{ slug: finalSlug, cwd: ctx.cwd, status, finishedAt: new Date().toISOString() }] : [];
  ctx.deps.loadJobs.mockImplementation(async () => rows);
  ctx.deps.readHistoryTail = vi.fn(async () => '');
  ctx.deps.createPrd.mockClear();
  return { ...ctx, rev, finalSlug, rows };
}

const decisionPath = (cwd) => path.join(cwd, 'session-manager-operations', 'project-pages', 'videos', ENTRY, 'review', 'decision.json');

test('registers exactly the two renderer channels', async () => {
  const { handlers } = await setup();
  expect(Object.keys(handlers).sort()).toEqual(['project-videos:review-decide', 'project-videos:review-list', 'project-videos:review-retry']);
});

test('review-list returns listReviews for a validatePath-checked cwd', async () => {
  const { cwd, handlers, deps } = await setup();
  const r = await handlers['project-videos:review-list']({}, { cwd });
  expect(deps.validatePath).toHaveBeenCalledWith(cwd);
  expect(r).toEqual((await videoReview.listReviews(cwd)).map((e) => ({ ...e, job: null, canRetry: false })));
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
  expect(second.error).toBe('a decision or retry for this entry is already in progress');
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

test('review-list: canRetry only for approved + final + failed', async () => {
  for (const [status, want] of [['failed', true], ['needs_review', true], ['running', false], ['completed', false], ['pending', false], [null, false]]) {
    const { cwd, handlers, finalSlug } = await approvedWithJob(status);
    const [e] = await handlers['project-videos:review-list']({}, { cwd });
    expect(e.status).toBe('approved');
    expect(e.canRetry).toBe(want);
    if (status) expect(e.job).toMatchObject({ slug: finalSlug });
    else expect(e.job).toBeNull();
  }
  // a waiting entry whose review-stage run failed is not retryable
  const { cwd, handlers, deps } = await setup();
  deps.loadJobs.mockImplementation(async () => [{ slug: 'short-video-build-1', cwd, status: 'failed' }]);
  const [e] = await handlers['project-videos:review-list']({}, { cwd });
  expect(e.job).toMatchObject({ state: 'failed' });
  expect(e.canRetry).toBe(false);
});

test('retryable is pure and strict about the decision', () => {
  const rev = { status: 'approved', decision: { decision: 'approve', at: '2026-11-22 13:05 PST' }, dispatch: { stage: 'final' } };
  expect(retryable(rev, { state: 'failed' })).toBe(true);
  expect(retryable(rev, null)).toBe(false);
  expect(retryable({ ...rev, decision: { decision: 'approve', at: '' } }, { state: 'failed' })).toBe(false);
  expect(retryable({ ...rev, dispatch: { stage: 'review' } }, { state: 'failed' })).toBe(false);
  expect(retryable({ ...rev, status: 'waiting' }, { state: 'failed' })).toBe(false);
});

test('retry: final run carries the stored at and Replace entry, archives the old slug, writes no decision', async () => {
  const { cwd, deps, retry, finalSlug } = await approvedWithJob('failed');
  const before = fs.readFileSync(decisionPath(cwd), 'utf8');
  const r = await retry();
  expect(r.ok).toBe(true);
  expect(r.stage).toBe('final');
  expect(r.slug).not.toBe(finalSlug);
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
  const goal = deps.createPrd.mock.calls[0][0].goal;
  expect(goal).toContain('Make cats');
  expect(goal).toContain('keep it short');
  expect(goal).toContain(`Replace entry: ${ENTRY}`);
  expect(goal.match(/Replace entry:/g)).toHaveLength(1);
  const at = JSON.parse(before).at;
  expect(/Review: approved by the owner at (.+)/.exec(goal)[1].trim()).toBe(at);
  expect(goal).not.toContain('Review stage:');
  expect(fs.readFileSync(decisionPath(cwd), 'utf8')).toBe(before);
  expect(deps.archivePrd).toHaveBeenCalledWith(finalSlug, cwd);
  const rev = await videoReview.readReview(cwd, ENTRY);
  expect(rev.status).toBe('approved');
  expect(rev.dispatch).toMatchObject({ stage: 'final', slug: r.slug });
  // the new run has no row yet -> not failed -> a second retry is refused
  const again = await retry();
  expect(again).toEqual({ ok: false, error: NOT_RETRYABLE_ERROR });
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
});

test('retry of a not-retryable entry is refused and dispatches nothing', async () => {
  for (const status of ['running', 'completed', null]) {
    const { deps, retry } = await approvedWithJob(status);
    expect(await retry()).toEqual({ ok: false, error: NOT_RETRYABLE_ERROR });
    expect(deps.createPrd).not.toHaveBeenCalled();
    expect(deps.archivePrd).not.toHaveBeenCalled();
  }
  const { deps, retry } = await setup();
  expect(await retry()).toEqual({ ok: false, error: NOT_RETRYABLE_ERROR });
  expect(deps.createPrd).not.toHaveBeenCalled();
});

test('retry with an inactive Epic returns runToolJob\'s refusal', async () => {
  const { deps, retry } = await approvedWithJob('failed');
  deps.readActiveIndex.mockImplementation(() => ({ sessions: { e1: { status: 'completed' } } }));
  const r = await retry();
  expect(r).toEqual({ ok: false, error: 'epic e1 is not an active session in this project' });
  expect(deps.createPrd).not.toHaveBeenCalled();
  expect(deps.archivePrd).not.toHaveBeenCalled();
});

test('two concurrent retries dispatch once', async () => {
  const { deps, retry } = await approvedWithJob('failed');
  let release;
  const gate = new Promise((res) => { release = res; });
  deps.createPrd.mockImplementation(async () => { await gate; return { ok: true }; });
  const first = retry();
  const second = await retry();
  expect(second.ok).toBe(false);
  expect(second.error).toBe('a decision or retry for this entry is already in progress');
  release();
  expect((await first).ok).toBe(true);
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
});

test('a tool whose persona cannot run it: approve and retry return the refusal, dispatch nothing, keep the entry state', async () => {
  const refusal = { ok: false, error: 'persona demo-video-builder is not installed for this project' };
  const { cwd, deps, decide } = await setup({ checkProjectVideoToolRunnable: vi.fn(async () => refusal) });
  expect(await decide({ decision: 'approve' })).toEqual({ ok: false, error: refusal.error });
  expect(deps.checkProjectVideoToolRunnable).toHaveBeenCalled();
  expect(deps.createPrd).not.toHaveBeenCalled();
  expect(fs.existsSync(decisionPath(cwd))).toBe(false);
  expect((await videoReview.readReview(cwd, ENTRY)).status).toBe('waiting');

  const ctx = await approvedWithJob('failed');
  const before = fs.readFileSync(decisionPath(ctx.cwd), 'utf8');
  ctx.deps.checkProjectVideoToolRunnable.mockImplementation(async () => refusal);
  expect(await ctx.retry()).toEqual({ ok: false, error: refusal.error });
  expect(ctx.deps.createPrd).not.toHaveBeenCalled();
  expect(ctx.deps.archivePrd).not.toHaveBeenCalled();
  expect(fs.readFileSync(decisionPath(ctx.cwd), 'utf8')).toBe(before);
  const [e] = await ctx.handlers['project-videos:review-list']({}, { cwd: ctx.cwd });
  expect(e.status).toBe('approved');
  expect(e.canRetry).toBe(true);
});

test('retry schema is strict; entryId matches ENTRY_ID_RE', () => {
  const ok = { cwd: '/p', entryId: 'vid-1' };
  expect(schemas.projectVideosReviewRetry.parse(ok)).toEqual(ok);
  expect(schemas.projectVideosReviewRetry.safeParse({ ...ok, x: 1 }).success).toBe(false);
  expect(schemas.projectVideosReviewRetry.safeParse({ ...ok, entryId: '_character' }).success).toBe(false);
});

test('builtin-demo-video entry: approve dispatches the final stage with the recorded extraInstructions and records it', async () => {
  const { cwd, deps, decide } = await setup({ macroId: 'builtin-demo-video' });
  const r = await decide({ decision: 'approve' });
  expect(r).toMatchObject({ ok: true, stage: 'final' });
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
  const input = deps.createPrd.mock.calls[0][0];
  expect(input.goal).toContain('keep it short');
  expect(input.goal).toContain(`Replace entry: ${ENTRY}`);
  expect(input.goal).not.toContain('vid-old');
  expect(input.goal).toMatch(/Review: approved by the owner at /);
  expect(input.goal).not.toContain('Review stage:');
  expect(input.artifactPaths).toEqual([`session-manager-operations/project-pages/videos/${ENTRY}/index.html`]);
  const rev = await videoReview.readReview(cwd, ENTRY);
  expect(rev.status).toBe('approved');
  expect(rev.dispatch).toMatchObject({ macroId: 'builtin-demo-video', stage: 'final', slug: r.slug });
});

test('builtin-demo-video entry: changes re-runs the review stage with the note', async () => {
  const { cwd, deps, decide } = await setup({ macroId: 'builtin-demo-video' });
  const r = await decide({ decision: 'changes', note: 'slower pace' });
  expect(r).toMatchObject({ ok: true, stage: 'review' });
  const goal = deps.createPrd.mock.calls[0][0].goal;
  expect(goal).toContain('Review: changes requested: slower pace');
  expect(goal).toContain('Review stage:');
  const rev = await videoReview.readReview(cwd, ENTRY);
  expect(rev.status).toBe('changes-requested');
  expect(rev.dispatch).toMatchObject({ macroId: 'builtin-demo-video', stage: 'review', slug: r.slug });
});

test('builtin-demo-video entry: retry of a failed final run dispatches the final stage again', async () => {
  const { cwd, deps, retry, finalSlug } = await approvedWithJob('failed', { macroId: 'builtin-demo-video' });
  const r = await retry();
  expect(r).toMatchObject({ ok: true, stage: 'final' });
  expect(r.slug).not.toBe(finalSlug);
  expect(deps.createPrd).toHaveBeenCalledTimes(1);
  expect(deps.createPrd.mock.calls[0][0].goal).toContain(`Replace entry: ${ENTRY}`);
  expect(deps.archivePrd).toHaveBeenCalledWith(finalSlug, cwd);
  expect((await videoReview.readReview(cwd, ENTRY)).dispatch).toMatchObject({ macroId: 'builtin-demo-video', stage: 'final', slug: r.slug });
});

test('builtin-demo-video entry: inactive-Epic and in-flight refusals are unchanged', async () => {
  const a = await setup({ macroId: 'builtin-demo-video', epicStatus: 'completed' });
  expect(await a.decide({ decision: 'approve' })).toEqual({ ok: false, error: INACTIVE_ERROR });
  expect(a.deps.createPrd).not.toHaveBeenCalled();
  let release;
  const gate = new Promise((res) => { release = res; });
  const createPrd = vi.fn(async () => { await gate; return { ok: true }; });
  const b = await setup({ macroId: 'builtin-demo-video', createPrd });
  const first = b.decide({ decision: 'approve' });
  expect((await b.decide({ decision: 'approve' })).error).toBe('a decision or retry for this entry is already in progress');
  release();
  expect((await first).ok).toBe(true);
  expect(createPrd).toHaveBeenCalledTimes(1);
});
