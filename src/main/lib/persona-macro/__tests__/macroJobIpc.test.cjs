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

  it('end to end with the real dispatchMacroJob: createPrd called once, no extra rescan dep', async () => {
    const { handlers, deps } = setup();
    const r = await handlers['macros:dispatch-job']({}, good);
    if (r.ok) expect(deps.createPrd).toHaveBeenCalledTimes(1);
    else expect(r.error).toMatch(/no background job/);
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
