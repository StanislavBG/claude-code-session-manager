import { describe, it, expect, vi } from 'vitest';
import {
  listProjects,
  listProjectSessions,
  getTranscript,
  listSessionPrds,
  sendChat,
  getAppInfo,
  RemoteError,
  REFUSED_MESSAGE,
  refusalMessage,
} from '../remoteApi';

function fake(payload: unknown) {
  return { sendCommand: vi.fn().mockResolvedValue({ type: 'resp', id: 'x', ts: 1, payload }) };
}

describe('remoteApi', () => {
  const cases: Array<[string, (s: any) => Promise<unknown>, string, unknown]> = [
    ['projects', (s) => listProjects(s, 'd'), 'cmd:projects:list', undefined],
    ['sessions', (s) => listProjectSessions(s, 'd', '/p'), 'cmd:project:sessions', { cwd: '/p' }],
    [
      'transcript',
      (s) => getTranscript(s, 'd', { cwd: '/p', sessionKey: 'k', limit: 5 }),
      'cmd:session:transcript',
      { cwd: '/p', sessionKey: 'k', limit: 5 },
    ],
    [
      'prds',
      (s) => listSessionPrds(s, 'd', { cwd: '/p', epicId: 'e' }),
      'cmd:session:prds',
      { cwd: '/p', epicId: 'e' },
    ],
    [
      'chat',
      (s) => sendChat(s, 'd', { target: 'e', prompt: 'hi' }),
      'cmd:chat:send',
      { tabId: 'e', prompt: 'hi' },
    ],
  ];

  for (const [name, run, type, payload] of cases) {
    it(`${name}: sends ${type} with the expected payload`, async () => {
      const s = fake({ ok: 1 });
      await run(s);
      expect(s.sendCommand).toHaveBeenCalledWith(type, 'd', payload);
    });

    it(`${name}: payload.error throws RemoteError`, async () => {
      const err: any = await run(fake({ error: 'rejected' })).catch((e) => e);
      expect(err).toBeInstanceOf(RemoteError);
      expect(err.message).toBe(REFUSED_MESSAGE);
    });

    it(`${name}: socket rejection becomes RemoteError with original message`, async () => {
      const s = { sendCommand: vi.fn().mockRejectedValue(new Error('timeout waiting for resp:1')) };
      const err: any = await run(s).catch((e) => e);
      expect(err).toBeInstanceOf(RemoteError);
      expect(err.message).toBe('timeout waiting for resp:1');
    });
  }

  it('transcript: forwards before only when given and passes page through', async () => {
    const s = fake({ messages: [{ role: 'user', text: 'a', ts: 1, uuid: 'u' }], hasMore: true, nextBefore: 7 });
    const page = await getTranscript(s as any, 'd', { cwd: '/p', sessionKey: 'k', before: 9 });
    expect(s.sendCommand).toHaveBeenCalledWith('cmd:session:transcript', 'd', { cwd: '/p', sessionKey: 'k', before: 9 });
    expect(page).toEqual({ messages: [{ role: 'user', text: 'a', ts: 1, uuid: 'u' }], hasMore: true, nextBefore: 7 });
    const s2 = fake({ messages: [] });
    await getTranscript(s2 as any, 'd', { cwd: '/p', sessionKey: 'k' });
    expect(s2.sendCommand.mock.calls[0][2]).not.toHaveProperty('before');
  });

  it('transcript: legacy payload normalises to hasMore false', async () => {
    expect(await getTranscript(fake({ messages: [] }) as any, 'd', { cwd: '/p', sessionKey: 'k' })).toEqual({
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
    expect(await getTranscript(fake({}) as any, 'd', { cwd: '/p', sessionKey: 'k' })).toEqual({
      messages: [],
      hasMore: false,
      nextBefore: null,
    });
  });

  describe('sendChat outcomes', () => {
    const send = (payload: unknown) => sendChat(fake(payload) as any, 'd', { target: 'e', prompt: 'hi' });

    it('sent', async () => {
      expect(await send({ ok: true, disposition: 'sent' })).toEqual({ disposition: 'sent', reason: undefined });
    });
    it('queued', async () => {
      expect(await send({ ok: true, disposition: 'queued', reason: 'busy' })).toEqual({
        disposition: 'queued',
        reason: 'busy',
      });
    });
    it('legacy ok without disposition is unconfirmed', async () => {
      expect(await send({ ok: true })).toEqual({ disposition: 'unconfirmed' });
    });
    it('refused throws with the reason copy', async () => {
      const err: any = await send({ ok: false, disposition: 'refused', reason: 'proposed' }).catch((e) => e);
      expect(err).toBeInstanceOf(RemoteError);
      expect(err.message).toBe(refusalMessage('proposed'));
    });
    it('opaque error keeps REFUSED_MESSAGE', async () => {
      const err: any = await send({ error: 'nope' }).catch((e) => e);
      expect(err.message).toBe(REFUSED_MESSAGE);
    });
  });

  describe('refusalMessage', () => {
    it.each([
      ['terminal-attached', 'This session is open in Terminal mode on your computer. Switch it back to Chat there to reply from your phone.'],
      ['proposed', 'This session has not started yet. Approve it on your computer first.'],
      ['not-active', 'This session is completed, so it cannot take new messages. Start a new session instead.'],
      ['completed', 'This session is completed, so it cannot take new messages. Start a new session instead.'],
      ['unknown-target', 'Your computer no longer has this session open. Go back and refresh the list.'],
      ['empty-prompt', 'Type a message first.'],
      ['weird', 'Your computer did not accept this message.'],
      [undefined, 'Your computer did not accept this message.'],
    ])('%s', (reason, msg) => {
      expect(refusalMessage(reason)).toBe(msg);
    });
  });
});

describe('getAppInfo', () => {
  it('sends cmd:app:info and normalizes missing fields to null', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ payload: { version: '1.0.0', hostname: '' } });
    const r = await getAppInfo({ sendCommand } as never, 'dev1');
    expect(sendCommand).toHaveBeenCalledWith('cmd:app:info', 'dev1', undefined);
    expect(r).toEqual({ version: '1.0.0', platform: null, hostname: null });
  });
});
