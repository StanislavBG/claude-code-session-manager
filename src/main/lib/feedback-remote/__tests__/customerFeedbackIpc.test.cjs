import { describe, it, expect, vi } from 'vitest';
const { registerCustomerFeedbackHandlers, submitFeedback } = require('../customerFeedbackIpc.cjs');

const CHANNELS = [
  'customerFeedback:submit', 'customerFeedback:list', 'customerFeedback:refresh-status',
  'customerFeedback:mark-seen', 'customerFeedback:owner-info', 'customerFeedback:inbox-pull',
  'customerFeedback:inbox-list', 'customerFeedback:inbox-set-status', 'customerFeedback:inbox-link-epic',
];

function setup() {
  const handlers = new Map();
  const ipcMain = { handle: (c, h) => handlers.set(c, h) };
  const client = {
    submit: vi.fn(async () => ({ ok: true })), list: vi.fn(async () => []),
    refreshStatuses: vi.fn(async () => ({ ok: true })), markSeen: vi.fn(async () => ({ ok: true })),
  };
  const inbox = {
    getOwnerInfo: vi.fn(() => ({ ownerMode: true, projectCwd: '/x' })),
    pull: vi.fn(), list: vi.fn(), setStatus: vi.fn(), linkEpic: vi.fn(),
  };
  const timers = [];
  const setTimeoutImpl = (fn, ms) => { const t = { fn, ms, unref: vi.fn() }; timers.push(t); return t; };
  registerCustomerFeedbackHandlers({ ipcMain, client, inbox, setTimeoutImpl });
  return { handlers, client, inbox, timers };
}

describe('customerFeedbackIpc', () => {
  it('registers all nine channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
  });

  it('rejects a malformed submit before reaching submit', async () => {
    const { handlers, client } = setup();
    expect(() => handlers.get('customerFeedback:submit')({}, { title: 'x', body: 'y', tag: 'nope' })).toThrow();
    expect(client.submit).not.toHaveBeenCalled();
    await handlers.get('customerFeedback:submit')({}, { title: 'x', body: 'y', tag: 'bug' });
    expect(client.submit).toHaveBeenCalledTimes(1);
  });

  it('owner-info never returns a token field', () => {
    const { handlers } = setup();
    const r = handlers.get('customerFeedback:owner-info')({});
    expect(JSON.stringify(r)).not.toMatch(/token/i);
  });

  it('schedules one unref’d ~30s refresh that swallows failures', async () => {
    const { client, timers } = setup();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(30000);
    expect(timers[0].unref).toHaveBeenCalled();
    client.refreshStatuses.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0].join(' ')).not.toContain('boom');
    warn.mockRestore();
  });

  it('IPC submit forwards images through prepare to client.submit', async () => {
    const { handlers, client } = setup();
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await handlers.get('customerFeedback:submit')({}, { title: 'x', body: 'y', tag: 'bug', images: [{ dataUrl: url }] });
    expect(client.submit).toHaveBeenCalledTimes(1);
    const arg = client.submit.mock.calls[0][0];
    expect(arg).toMatchObject({ title: 'x', body: 'y', tag: 'bug' });
    expect(arg.images).toHaveLength(1);
    expect(arg.images[0]).toMatchObject({ dataUrl: url, mime: 'image/png' });
  });

  it('submitFeedback maps images + imagePaths into prepare and returns the client result (warning included)', async () => {
    const prepared = [{ dataUrl: 'data:image/png;base64,AA', mime: 'image/png', bytes: 1 }];
    const prepare = vi.fn(async () => ({ ok: true, images: prepared }));
    const result = { ok: true, item: { id: 'f1' }, warning: 'Only 0 of 1' };
    const client = { submit: vi.fn(async () => result) };
    const r = await submitFeedback(
      { title: 't', body: 'b', tag: 'feature', images: [{ dataUrl: 'data:x' }], imagePaths: ['/a.png'] }, client, prepare);
    expect(prepare).toHaveBeenCalledWith([{ dataUrl: 'data:x' }, { path: '/a.png' }]);
    expect(client.submit).toHaveBeenCalledWith({ title: 't', body: 'b', tag: 'feature', images: prepared });
    expect(r).toBe(result);
  });

  it('a prepare error short-circuits client.submit', async () => {
    const prepare = vi.fn(async () => ({ ok: false, error: 'Image 1 (a.png) could not be found.' }));
    const client = { submit: vi.fn() };
    const r = await submitFeedback({ title: 't', body: 'b', tag: 'bug', imagePaths: ['/a.png'] }, client, prepare);
    expect(r).toEqual({ ok: false, error: 'Image 1 (a.png) could not be found.' });
    expect(client.submit).not.toHaveBeenCalled();
  });
});
