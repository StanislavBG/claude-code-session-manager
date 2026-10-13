import { describe, it, expect, vi } from 'vitest';
import {
  listProjects,
  listProjectSessions,
  getTranscript,
  listSessionPrds,
  sendChat,
  RemoteError,
  REFUSED_MESSAGE,
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
    it(`${name}: sends ${type} and passes payload through`, async () => {
      const s = fake({ ok: 1 });
      expect(await run(s)).toEqual({ ok: 1 });
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
});
