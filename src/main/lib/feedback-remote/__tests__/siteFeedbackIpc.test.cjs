import { describe, it, expect, vi } from 'vitest';
const { registerSiteFeedbackHandlers, redactSecrets } = require('../siteFeedbackIpc.cjs');

const CWD = '/tmp/proj';
const BOX = 'box_abc123';
const HOST = 'FB-AB12C';

/** channel → [service method, valid payload, expected arg, list of invalid payloads] */
const CASES = {
  'siteFeedback:widget-create': ['createWidget',
    { cwd: CWD, label: 'Site', allowedOrigins: ['https://a.example'] },
    { cwd: CWD, label: 'Site', allowedOrigins: ['https://a.example'] },
    [undefined, { cwd: CWD, label: 'Site' }, { cwd: '', label: 'S', allowedOrigins: ['https://a'] },
      { cwd: CWD, label: 'x'.repeat(81), allowedOrigins: ['https://a'] },
      { cwd: CWD, label: 'S', allowedOrigins: Array(11).fill('https://a') },
      { cwd: CWD, label: 'S', allowedOrigins: ['https://a'], privateKeyJwk: {} }]],
  'siteFeedback:widget-list': ['listWidgets', { cwd: CWD }, { cwd: CWD },
    [{ cwd: 5 }, { cwd: CWD, extra: true }]],
  'siteFeedback:widget-update': ['updateWidget',
    { boxId: BOX, state: 'paused' }, { boxId: BOX, state: 'paused' },
    [{ state: 'paused' }, { boxId: BOX, state: 'closed' }, { boxId: BOX, label: 7 }, { boxId: BOX, publicKey: 'x' }]],
  'siteFeedback:widget-delete': ['deleteWidget', { boxId: BOX }, { boxId: BOX },
    [{}, { boxId: '' }, { boxId: BOX, cwd: CWD }]],
  'siteFeedback:widget-snippet': ['getSnippet', { boxId: BOX }, { boxId: BOX },
    [{}, { boxId: 1 }, { boxId: 'x'.repeat(201) }]],
  'siteFeedback:inbox-list': ['listItems', { cwd: CWD, status: 'open' }, { cwd: CWD, status: 'open' },
    [{}, { cwd: CWD, status: 'nope' }, { cwd: CWD, all: true }]],
  'siteFeedback:inbox-get': ['getItem', { cwd: CWD, hostId: HOST }, { cwd: CWD, hostId: HOST },
    [{ cwd: CWD }, { cwd: CWD, hostId: '../etc' }, { hostId: HOST }]],
  'siteFeedback:inbox-image': ['getImage', { cwd: CWD, hostId: HOST, which: 'screenshot' },
    { cwd: CWD, hostId: HOST, which: 'screenshot' },
    [{ cwd: CWD, hostId: HOST, which: 'raw' }, { cwd: CWD, hostId: 'fb-ab12c' }, { cwd: CWD, hostId: HOST, path: '/etc/passwd' }]],
  'siteFeedback:inbox-set-status': ['setStatus', { cwd: CWD, hostId: HOST, status: 'resolved', note: 'done' },
    { cwd: CWD, hostId: HOST, status: 'resolved', note: 'done' },
    [{ cwd: CWD, hostId: HOST }, { cwd: CWD, hostId: HOST, status: 'closed' },
      { cwd: CWD, hostId: HOST, status: 'open', note: 'x'.repeat(501) }]],
  'siteFeedback:inbox-link-epic': ['linkEpic', { cwd: CWD, hostId: HOST, epicId: 'abc-123' },
    { cwd: CWD, hostId: HOST, epicId: 'abc-123' },
    [{ cwd: CWD, hostId: HOST }, { cwd: CWD, hostId: HOST, epicId: '../x' }, { cwd: CWD, hostId: HOST, epicId: '' }]],
  'siteFeedback:drain-now': ['drainNow', undefined, undefined, [{ boxId: BOX }, 'now']],
};

function setup(overrides = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (c, h) => handlers.set(c, h) };
  const service = {};
  for (const [method] of Object.values(CASES)) {
    service[method] = vi.fn(async () => ({ ok: true, method }));
  }
  Object.assign(service, overrides);
  registerSiteFeedbackHandlers({ ipcMain, service });
  return { handlers, service };
}

describe('siteFeedbackIpc', () => {
  it('registers exactly the eleven siteFeedback:* channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const [channel, [method, valid, expectedArg, invalid]] of Object.entries(CASES)) {
    it(`${channel} delegates a valid payload to service.${method}`, async () => {
      const { handlers, service } = setup();
      const r = await handlers.get(channel)({}, valid);
      expect(service[method]).toHaveBeenCalledTimes(1);
      if (expectedArg === undefined) expect(service[method].mock.calls[0].length).toBe(0);
      else expect(service[method]).toHaveBeenCalledWith(expectedArg);
      expect(r).toEqual({ ok: true, method });
    });

    it(`${channel} rejects malformed payloads before reaching service.${method}`, () => {
      const { handlers, service } = setup();
      for (const bad of invalid) {
        expect(() => handlers.get(channel)({}, bad), JSON.stringify(bad)).toThrow();
      }
      expect(service[method]).not.toHaveBeenCalled();
    });
  }

  it('widget-list and drain-now accept an empty payload', async () => {
    const { handlers, service } = setup();
    await handlers.get('siteFeedback:widget-list')({}, undefined);
    expect(service.listWidgets).toHaveBeenCalledWith({});
    await handlers.get('siteFeedback:drain-now')({}, {});
    expect(service.drainNow).toHaveBeenCalledTimes(1);
  });

  it('no channel returns a private key or the device token, even if the service leaked one', async () => {
    const leak = {
      ok: true,
      privateKeyJwk: { d: 'SECRET' },
      widgets: [{ boxId: BOX, privateKey: 'SECRET', deviceToken: 'SECRET', snippet: 's' }],
      relayError: { token: 'SECRET', error: 'x' },
    };
    const overrides = {};
    for (const [method] of Object.values(CASES)) overrides[method] = vi.fn(async () => leak);
    const { handlers } = setup(overrides);
    for (const [channel, [, valid]] of Object.entries(CASES)) {
      const r = await handlers.get(channel)({}, valid);
      expect(JSON.stringify(r), channel).not.toContain('SECRET');
      expect(r.widgets[0]).toEqual({ boxId: BOX, snippet: 's' });
    }
  });

  it('redactSecrets leaves image data URLs and ordinary fields intact', () => {
    const v = { ok: true, dataUrl: 'data:image/png;base64,AA', fingerprint: 'f', items: [{ hostId: HOST }] };
    expect(redactSecrets(v)).toEqual(v);
  });
});
