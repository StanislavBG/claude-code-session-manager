import { describe, it, expect, vi } from 'vitest';
const { registerCustomerFeedbackHandlers } = require('../customerFeedbackIpc.cjs');

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

  it('rejects a malformed submit before reaching submit', () => {
    const { handlers, client } = setup();
    expect(() => handlers.get('customerFeedback:submit')({}, { title: 'x', body: 'y', tag: 'nope' })).toThrow();
    expect(client.submit).not.toHaveBeenCalled();
    handlers.get('customerFeedback:submit')({}, { title: 'x', body: 'y', tag: 'bug' });
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
});
