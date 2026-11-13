'use strict';
import { describe, it, expect, vi } from 'vitest';
const { registerMacroJobIpc } = require('../macroJobIpc.cjs');
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
    expect(macroJobStatuses).toHaveBeenCalledWith({ cwd: '/p' }, { loadJobs: deps.loadJobs, readHistoryTail });
    await expect(handlers['macros:job-status']({}, {})).rejects.toThrow();
  });
});
