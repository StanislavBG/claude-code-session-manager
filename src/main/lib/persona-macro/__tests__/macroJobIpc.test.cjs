'use strict';
import { describe, it, expect, vi } from 'vitest';
const { registerMacroJobIpc, runToolJob } = require('../macroJobIpc.cjs');
const videoReview = require('../../project-pages/videoReview.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');

function setup(over = {}) {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const deps = {
    schemas,
    validatePath: vi.fn((p) => p),
    readActiveIndex: vi.fn(() => ({ sessions: { e1: { status: 'active' }, e2: { status: 'completed' } } })),
    createPrd: vi.fn(async () => ({ ok: true })),
    loadJobs: vi.fn(async () => []),
    archivePrd: vi.fn(async () => ({})),
    listMacros: vi.fn(async () => []),
    videoReview: { recordDispatch: vi.fn(async () => ({ ok: true })) },
    checkProjectVideoToolRunnable: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  registerMacroJobIpc(ipcMain, deps);
  return { handlers, deps };
}
const good = { cwd: '/p', macroId: 'demo-video', epicId: 'e1' };

describe('macros:dispatch-job', () => {
  it('registers both channels', () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual(['macros:dispatch-job', 'macros:job-status']);
  });

  it('rejects invalid payloads via the zod schema', async () => {
    const { handlers, deps } = setup();
    for (const bad of [{}, { ...good, cwd: '' }, { ...good, macroId: 'x'.repeat(129) }, { ...good, epicId: 'x'.repeat(201) }, { ...good, extraInstructions: 'x'.repeat(4001) }]) {
      await expect(handlers['macros:dispatch-job']({}, bad)).rejects.toThrow();
    }
    expect(deps.createPrd).not.toHaveBeenCalled();
  });

  it('validates cwd with validatePath and propagates its refusal', async () => {
    const { handlers, deps } = setup({ validatePath: vi.fn(() => { throw new Error('outside'); }) });
    await expect(handlers['macros:dispatch-job']({}, good)).rejects.toThrow('outside');
    expect(deps.validatePath).toHaveBeenCalledWith('/p');
  });

  it('refuses an epicId that is not an active session', async () => {
    const { handlers, deps } = setup();
    for (const epicId of ['e2', 'nope', '__proto__']) {
      const r = await handlers['macros:dispatch-job']({}, { ...good, epicId });
      expect(r.ok).toBe(false);
    }
    expect(deps.createPrd).not.toHaveBeenCalled();
  });

  it("returns dispatchMacroJob's result and wires createPrd through", async () => {
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's', epicId: 'e1' }));
    const { handlers, deps } = setup({ dispatchMacroJob });
    const r = await handlers['macros:dispatch-job']({}, { ...good, extraInstructions: 'hi' });
    expect(r).toEqual({ ok: true, slug: 's', epicId: 'e1' });
    const [args, d] = dispatchMacroJob.mock.calls[0];
    expect(args).toEqual({ cwd: '/p', macroId: 'demo-video', epicId: 'e1', extraInstructions: 'hi' });
    expect(d.createPrd).toBe(deps.createPrd);
    await d.archivePrd('slug', '/p');
    expect(deps.archivePrd).toHaveBeenCalledWith('slug', '/p');
  });

  it('forwards effort to dispatchMacroJob', async () => {
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's', epicId: 'e1' }));
    const { handlers } = setup({ dispatchMacroJob });
    await handlers['macros:dispatch-job']({}, { ...good, effort: 'medium' });
    expect(dispatchMacroJob.mock.calls[0][0].effort).toBe('medium');
  });

  it('the real macrosDispatchJob schema accepts only the PRD effort levels', () => {
    expect(schemas.macrosDispatchJob.safeParse({ ...good, effort: 'turbo' }).success).toBe(false);
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(schemas.macrosDispatchJob.parse({ ...good, effort }).effort).toBe(effort);
    }
  });

  it('end to end with the real dispatchMacroJob: createPrd called once, no extra rescan dep', async () => {
    const { handlers, deps } = setup();
    const r = await handlers['macros:dispatch-job']({}, good);
    if (r.ok) expect(deps.createPrd).toHaveBeenCalledTimes(1);
    else expect(r.error).toMatch(/no background job/);
  });
});

describe('macros:dispatch-job — job-not-queued notice (PRD 2950)', () => {
  const idx = () => ({ sessions: { e1: { status: 'active' }, p1: { status: 'proposed' } } });

  it('appends one notice to a proposed Epic refused as not active', async () => {
    const appendResponseEventWithReason = vi.fn(async () => ({ ok: true }));
    const { handlers, deps } = setup({ readActiveIndex: vi.fn(idx), appendResponseEventWithReason });
    const r = await handlers['macros:dispatch-job']({}, { cwd: '/p', macroId: 'builtin-competitor-matrix', epicId: 'p1' });
    expect(r).toEqual({ ok: false, error: 'epic p1 is not an active session in this project' });
    expect(deps.createPrd).not.toHaveBeenCalled();
    expect(appendResponseEventWithReason).toHaveBeenCalledTimes(1);
    const [cwd, epicId, text, meta] = appendResponseEventWithReason.mock.calls[0];
    expect([cwd, epicId]).toEqual(['/p', 'p1']);
    expect(text).toContain('Competitor matrix');
    expect(text).toContain('epic p1 is not an active session in this project');
    expect(text).toContain("press it again in Project Home ▸ Tools to retry");
    expect(meta).toEqual({ notice: 'job-not-queued', allowInactive: true });
  });

  it('appends no notice for an epicId that is not in the index', async () => {
    const appendResponseEventWithReason = vi.fn(async () => ({ ok: true }));
    const { handlers } = setup({ readActiveIndex: vi.fn(idx), appendResponseEventWithReason });
    const r = await handlers['macros:dispatch-job']({}, { ...good, epicId: 'nope' });
    expect(r.ok).toBe(false);
    expect(appendResponseEventWithReason).not.toHaveBeenCalled();
  });

  it('appends one notice naming the createPrd failure, falling back to the macroId as label', async () => {
    const appendResponseEventWithReason = vi.fn(async () => ({ ok: true }));
    const createPrd = vi.fn(async () => ({ ok: false, error: 'disk full' }));
    const builtins = [{ id: 'm-x', job: { artifactPaths: ['a.json'], estimateMinutes: 5 }, prompt: 'p' }];
    const { handlers } = setup({ readActiveIndex: vi.fn(idx), appendResponseEventWithReason, createPrd });
    const r = await handlers['macros:dispatch-job']({}, { cwd: '/p', macroId: 'builtin-competitor-matrix', epicId: 'e1' });
    expect(r).toEqual({ ok: false, error: 'disk full' });
    expect(appendResponseEventWithReason).toHaveBeenCalledTimes(1);
    const text = appendResponseEventWithReason.mock.calls[0][2];
    expect(text).toContain('Competitor matrix');
    expect(text).toContain('disk full');
    expect(text).toContain("press it again in Project Home ▸ Tools to retry");
    // label fallback: an unknown macroId names itself
    const dispatchMacroJob = vi.fn(async () => ({ ok: false, error: 'boom' }));
    const s2 = setup({ readActiveIndex: vi.fn(idx), appendResponseEventWithReason: vi.fn(async () => ({ ok: true })), dispatchMacroJob, builtins });
    await s2.handlers['macros:dispatch-job']({}, { cwd: '/p', macroId: 'unknown-macro', epicId: 'e1' });
    expect(s2.deps.appendResponseEventWithReason.mock.calls[0][2]).toContain('unknown-macro');
  });

  it('appends no notice on a successful dispatch', async () => {
    const appendResponseEventWithReason = vi.fn(async () => ({ ok: true }));
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's', epicId: 'e1' }));
    const { handlers } = setup({ readActiveIndex: vi.fn(idx), appendResponseEventWithReason, dispatchMacroJob });
    expect((await handlers['macros:dispatch-job']({}, good)).ok).toBe(true);
    expect(appendResponseEventWithReason).not.toHaveBeenCalled();
  });

  it('appends no notice when the macro is already building', async () => {
    const appendResponseEventWithReason = vi.fn(async () => ({ ok: true }));
    const loadJobs = vi.fn(async () => [{ macroId: 'builtin-competitor-matrix', status: 'running', slug: 'cm-1', cwd: '/p' }]);
    const { handlers } = setup({ readActiveIndex: vi.fn(idx), appendResponseEventWithReason, loadJobs });
    const r = await handlers['macros:dispatch-job']({}, { cwd: '/p', macroId: 'builtin-competitor-matrix', epicId: 'e1' });
    expect(r).toMatchObject({ ok: false, activeSlug: 'cm-1' });
    expect(appendResponseEventWithReason).not.toHaveBeenCalled();
  });

  it('a failed or throwing append keeps the original result and never throws', async () => {
    const dispatchMacroJob = vi.fn(async () => ({ ok: false, error: 'queue unreadable' }));
    for (const append of [vi.fn(async () => { throw new Error('locked'); }), vi.fn(async () => ({ ok: false, reason: 'error' })), vi.fn(() => { throw new Error('sync'); })]) {
      const { handlers } = setup({ readActiveIndex: vi.fn(idx), appendResponseEventWithReason: append, dispatchMacroJob });
      expect(await handlers['macros:dispatch-job']({}, good)).toEqual({ ok: false, error: 'queue unreadable' });
      const refused = await handlers['macros:dispatch-job']({}, { ...good, epicId: 'p1' });
      expect(refused).toEqual({ ok: false, error: 'epic p1 is not an active session in this project' });
      expect(append).toHaveBeenCalledTimes(2);
    }
  });
});

describe('macros:job-status', () => {
  it('validates { cwd } and returns macroJobStatuses with live queue + history tail', async () => {
    const macroJobStatuses = vi.fn(async () => [{ macroId: 'a' }]);
    const readHistoryTail = vi.fn();
    const { handlers, deps } = setup({ macroJobStatuses, readHistoryTail });
    expect(await handlers['macros:job-status']({}, { cwd: '/p' })).toEqual([{ macroId: 'a' }]);
    expect(deps.validatePath).toHaveBeenCalledWith('/p');
    expect(macroJobStatuses).toHaveBeenCalledWith({ cwd: '/p' }, { loadJobs: deps.loadJobs, macros: [], readHistoryTail });
    await expect(handlers['macros:job-status']({}, {})).rejects.toThrow();
  });
});

const tool = (over = {}) => ({
  id: 'tool-v', label: 'Short video', surface: 'project-video', projects: ['/p'],
  agentName: 'demo-video-builder', tag: 'feature', prompt: 'Make {{topic}}',
  inputs: [{ name: 'topic', label: 'Topic', required: true }],
  job: { estimateMinutes: 10 }, ...over,
});

describe('macrosDispatchJob schema — inputValues', () => {
  it('accepts at most 20 string values of at most 4000 chars', () => {
    const vals = (n, len = 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'x'.repeat(len)]));
    expect(schemas.macrosDispatchJob.parse({ ...good, inputValues: vals(20, 4000) }).inputValues).toEqual(vals(20, 4000));
    expect(schemas.macrosDispatchJob.safeParse({ ...good, inputValues: vals(21) }).success).toBe(false);
    expect(schemas.macrosDispatchJob.safeParse({ ...good, inputValues: vals(1, 4001) }).success).toBe(false);
    expect(schemas.macrosDispatchJob.safeParse({ ...good, inputValues: { a: 1 } }).success).toBe(false);
    expect(schemas.macrosDispatchJob.safeParse({ ...good, inputValues: ['a'] }).success).toBe(false);
  });

  it('has no review key: a press cannot send a review decision', async () => {
    const parsed = schemas.macrosDispatchJob.parse({ ...good, review: { decision: 'approved', at: 'now' } });
    expect('review' in parsed).toBe(false);
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's' }));
    const { handlers } = setup({ dispatchMacroJob });
    await handlers['macros:dispatch-job']({}, { ...good, inputValues: { topic: 't' }, review: { decision: 'approved', at: 'now' } });
    const args = dispatchMacroJob.mock.calls[0][0];
    expect('review' in args).toBe(false);
    expect(args.inputValues).toEqual({ topic: 't' });
  });
});

describe('runToolJob', () => {
  it('macros:dispatch-job passes the library macros and inputValues to dispatch', async () => {
    const macros = [tool()];
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's' }));
    const { handlers, deps } = setup({ dispatchMacroJob, listMacros: vi.fn(async () => macros) });
    await handlers['macros:dispatch-job']({}, { ...good, macroId: 'tool-v', inputValues: { topic: 'cats' } });
    expect(deps.listMacros).toHaveBeenCalled();
    const [args, d] = dispatchMacroJob.mock.calls[0];
    expect(args).toMatchObject({ macroId: 'tool-v', inputValues: { topic: 'cats' } });
    expect(d.macros).toBe(macros);
  });

  it('holds the active-Epic check and forwards review to dispatch', async () => {
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's' }));
    const { deps } = setup({ dispatchMacroJob });
    expect(await runToolJob(deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e2' })).toMatchObject({ ok: false });
    expect(dispatchMacroJob).not.toHaveBeenCalled();
    const review = { decision: 'approved', at: '2026-11-22' };
    await runToolJob(deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1', review });
    expect(dispatchMacroJob.mock.calls[0][0].review).toBe(review);
  });

  it('records the dispatch after every ok project-video tool dispatch (review or not), with the real dispatcher', async () => {
    for (const job of [{ estimateMinutes: 10, review: true }, { estimateMinutes: 10 }]) {
      const macros = [tool({ job })];
      const recordDispatch = vi.fn(async () => ({ ok: true }));
      const { deps } = setup({ listMacros: vi.fn(async () => macros), videoReview: { recordDispatch } });
      const r = await runToolJob(deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1', inputValues: { topic: 'cats' }, extraInstructions: 'short' });
      expect(r.ok).toBe(true);
      expect(recordDispatch).toHaveBeenCalledTimes(1);
      expect(recordDispatch).toHaveBeenCalledWith('/p', r.entryId, {
        macroId: 'tool-v', epicId: 'e1', slug: r.slug, stage: job.review ? 'review' : 'final',
        inputValues: { topic: 'cats' }, extraInstructions: 'short',
      });
    }
  });

  it('records nothing for a built-in, a failed dispatch or a tool of another project; a failed record keeps the result', async () => {
    const recordDispatch = vi.fn(async () => ({ ok: true }));
    const ok = vi.fn(async () => ({ ok: true, slug: 's', entryId: 'vid-1', stage: null }));
    const s1 = setup({ dispatchMacroJob: ok, videoReview: { recordDispatch }, listMacros: vi.fn(async () => [tool({ projects: ['/other'] })]) });
    await runToolJob(s1.deps, { cwd: '/p', macroId: 'demo-video', epicId: 'e1' });
    await runToolJob(s1.deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1' });
    const s2 = setup({ dispatchMacroJob: vi.fn(async () => ({ ok: false, error: 'x' })), videoReview: { recordDispatch }, listMacros: vi.fn(async () => [tool()]) });
    await runToolJob(s2.deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1' });
    expect(recordDispatch).not.toHaveBeenCalled();
    const throwing = { recordDispatch: vi.fn(async () => { throw new Error('disk'); }) };
    const s3 = setup({ dispatchMacroJob: ok, videoReview: throwing, listMacros: vi.fn(async () => [tool()]) });
    expect(await runToolJob(s3.deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1' })).toEqual({ ok: true, slug: 's', entryId: 'vid-1', stage: null });
    expect(throwing.recordDispatch).toHaveBeenCalledWith('/p', 'vid-1', expect.objectContaining({ stage: 'final', inputValues: {}, extraInstructions: '' }));
  });

  it("videoReview.REVIEW_MATERIAL_REL is the material path macroJobDispatch gates on", async () => {
    const createPrd = vi.fn(async () => ({ ok: true }));
    const { deps } = setup({ createPrd, listMacros: vi.fn(async () => [tool({ job: { estimateMinutes: 10, review: true } })]) });
    const r = await runToolJob(deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1', inputValues: { topic: 'cats' } });
    expect(r.stage).toBe('review');
    const input = createPrd.mock.calls[0][0];
    expect(input.artifactPaths).toEqual([videoReview.REVIEW_MATERIAL_REL.split('{id}').join(r.entryId)]);
    expect(input.gate[0]).toContain(videoReview.REVIEW_MATERIAL_REL.split('{id}').join(r.entryId));
  });

  it("the job-not-queued notice names a library tool's label", async () => {
    const appendResponseEventWithReason = vi.fn(async () => ({ ok: true }));
    const { handlers } = setup({
      appendResponseEventWithReason,
      dispatchMacroJob: vi.fn(async () => ({ ok: false, error: 'boom' })),
      listMacros: vi.fn(async () => [tool()]),
    });
    await handlers['macros:dispatch-job']({}, { ...good, macroId: 'tool-v' });
    expect(appendResponseEventWithReason.mock.calls[0][2]).toContain('Short video background build was not queued: boom');
  });
});

describe('runToolJob — Demo Video review stage', () => {
  it('a reviewStage press for builtin-demo-video creates a review-stage PRD and records dispatch.json', async () => {
    const recordDispatch = vi.fn(async () => ({ ok: true }));
    const createPrd = vi.fn(async () => ({ ok: true }));
    const { handlers } = setup({ createPrd, videoReview: { recordDispatch } });
    const r = await handlers['macros:dispatch-job']({}, { cwd: '/p', macroId: 'builtin-demo-video', epicId: 'e1', extraInstructions: 'Video kind: Feature', reviewStage: true });
    expect(r).toMatchObject({ ok: true, stage: 'review' });
    expect(createPrd).toHaveBeenCalledTimes(1);
    const input = createPrd.mock.calls[0][0];
    expect(input.goal).toContain('Review stage:');
    expect(input.artifactPaths).toEqual([videoReview.REVIEW_MATERIAL_REL.split('{id}').join(r.entryId)]);
    expect(recordDispatch).toHaveBeenCalledTimes(1);
    expect(recordDispatch).toHaveBeenCalledWith('/p', r.entryId, {
      macroId: 'builtin-demo-video', epicId: 'e1', slug: r.slug, stage: 'review',
      inputValues: {}, extraInstructions: 'Video kind: Feature',
    });
  });

  it('forwards reviewStage to dispatchMacroJob', async () => {
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's' }));
    const { handlers } = setup({ dispatchMacroJob });
    await handlers['macros:dispatch-job']({}, { cwd: '/p', macroId: 'builtin-demo-video', epicId: 'e1', reviewStage: true });
    expect(dispatchMacroJob.mock.calls[0][0].reviewStage).toBe(true);
  });

  it('a plain Demo Video press (stage null) records nothing', async () => {
    const recordDispatch = vi.fn(async () => ({ ok: true }));
    const createPrd = vi.fn(async () => ({ ok: true }));
    const { handlers } = setup({ createPrd, videoReview: { recordDispatch } });
    for (const extra of [{}, { reviewStage: false }]) {
      const r = await handlers['macros:dispatch-job']({}, { cwd: '/p', macroId: 'builtin-demo-video', epicId: 'e1', ...extra });
      expect(r).toMatchObject({ ok: true, stage: null });
    }
    expect(createPrd).toHaveBeenCalledTimes(2);
    expect(recordDispatch).not.toHaveBeenCalled();
  });

  it('an approved review of builtin-demo-video records the final stage', async () => {
    const recordDispatch = vi.fn(async () => ({ ok: true }));
    const { deps } = setup({ videoReview: { recordDispatch } });
    const r = await runToolJob(deps, { cwd: '/p', macroId: 'builtin-demo-video', epicId: 'e1', extraInstructions: 'Replace entry: vid-abc', review: { decision: 'approved', at: '2026-11-23 10:00 PST' } });
    expect(r).toMatchObject({ ok: true, stage: 'final', entryId: 'vid-abc' });
    expect(recordDispatch).toHaveBeenCalledWith('/p', 'vid-abc', expect.objectContaining({ macroId: 'builtin-demo-video', stage: 'final' }));
  });
});

describe('macros:job-status — library macros', () => {
  it('passes macros from listMacros and an injected listReviews', async () => {
    const macros = [tool()];
    const macroJobStatuses = vi.fn(async () => []);
    const listReviews = vi.fn();
    const { handlers, deps } = setup({ macroJobStatuses, listReviews, listMacros: vi.fn(async () => macros) });
    await handlers['macros:job-status']({}, { cwd: '/p' });
    expect(macroJobStatuses).toHaveBeenCalledWith({ cwd: '/p' }, { loadJobs: deps.loadJobs, macros, listReviews });
  });
});

describe('runToolJob — project-video runnable check', () => {
  it('refuses a project-video tool the persona cannot run: { ok:false, error }, no PRD, job-not-queued notice', async () => {
    const check = vi.fn(async () => ({ ok: false, error: 'persona cannot save its video' }));
    const appendResponseEventWithReason = vi.fn(async () => ({ ok: true }));
    const { deps } = setup({ checkProjectVideoToolRunnable: check, appendResponseEventWithReason, listMacros: vi.fn(async () => [tool({ job: { estimateMinutes: 10, review: true } })]) });
    const r = await runToolJob(deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1', inputValues: { topic: 'cats' } });
    expect(r).toEqual({ ok: false, error: 'persona cannot save its video' });
    expect(check).toHaveBeenCalledWith({ cwd: '/p', agentName: 'demo-video-builder', job: { estimateMinutes: 10, review: true } });
    expect(deps.createPrd).not.toHaveBeenCalled();
    expect(deps.videoReview.recordDispatch).not.toHaveBeenCalled();
    expect(appendResponseEventWithReason).toHaveBeenCalledTimes(1);
    const [, epicId, text, opts] = appendResponseEventWithReason.mock.calls[0];
    expect(epicId).toBe('e1');
    expect(text).toContain('Short video');
    expect(text).toContain('persona cannot save its video');
    expect(opts).toMatchObject({ notice: 'job-not-queued' });
  });

  it('dispatches a project-video tool the check passes', async () => {
    const check = vi.fn(async () => ({ ok: true }));
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's' }));
    const { deps } = setup({ checkProjectVideoToolRunnable: check, dispatchMacroJob, listMacros: vi.fn(async () => [tool()]) });
    expect(await runToolJob(deps, { cwd: '/p', macroId: 'tool-v', epicId: 'e1' })).toEqual({ ok: true, slug: 's' });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('never checks a built-in macro', async () => {
    const check = vi.fn(async () => ({ ok: false, error: 'no' }));
    const dispatchMacroJob = vi.fn(async () => ({ ok: true, slug: 's' }));
    const { deps } = setup({ checkProjectVideoToolRunnable: check, dispatchMacroJob });
    expect(await runToolJob(deps, { cwd: '/p', macroId: 'builtin-demo-video', epicId: 'e1' })).toEqual({ ok: true, slug: 's' });
    expect(check).not.toHaveBeenCalled();
    expect(dispatchMacroJob).toHaveBeenCalledTimes(1);
  });
});
