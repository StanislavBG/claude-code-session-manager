import { describe, it, expect } from 'vitest'
import rows from '../../../preload/apiSurface.json'
import { createRemoteApi, DENY_MESSAGE } from '../remoteApi'

function setup() {
  const sent: any[] = []
  let handler: (e: MessageEvent) => void = () => {}
  const api: any = createRemoteApi({
    parent: { postMessage: (m) => sent.push(m) },
    events: { addEventListener: (_t, fn) => { handler = fn } },
  })
  const deliver = (data: unknown) => handler({ data } as MessageEvent)
  return { api, sent, deliver }
}
const find = (f: (r: any) => boolean) => (rows as any[]).find(f)!

describe('remoteApi', () => {
  it('exposes every apiSurface method with the right kind', () => {
    const { api } = setup()
    expect(api.__remote).toBe(true)
    for (const r of rows as any[]) expect(typeof api[r.ns][r.method], `${r.ns}.${r.method}`).toBe('function')
  })

  it('invoke round-trips through the parent', async () => {
    const { api, sent, deliver } = setup()
    const r = find((x) => x.kind === 'invoke' && x.remote === 'read' && x.channel === 'app:version')
    const p = api[r.ns][r.method]('a', 1)
    expect(sent[0]).toMatchObject({ type: 'sm-ipc', channel: r.channel, args: ['a', 1] })
    deliver({ type: 'sm-ipc-result', id: sent[0].id, result: '1.2.3' })
    await expect(p).resolves.toBe('1.2.3')
    const p2 = api[r.ns][r.method]()
    deliver({ type: 'sm-ipc-result', id: sent[1].id, error: 'boom' })
    await expect(p2).rejects.toThrow('boom')
  })

  it('deny rows reject', async () => {
    const { api, sent } = setup()
    const r = find((x) => x.kind === 'invoke' && x.remote === 'deny')
    await expect(api[r.ns][r.method]()).rejects.toThrow(DENY_MESSAGE)
    expect(sent).toHaveLength(0)
  })

  it('persistence rows no-op and never reach the parent', async () => {
    const { api, sent } = setup()
    for (const ch of ['sessions:save', 'layout:save']) {
      const r = find((x) => x.channel === ch)
      await expect(api[r.ns][r.method]({ x: 1 })).resolves.toEqual({ ok: true })
    }
    expect(sent).toHaveLength(0)
  })

  it('lifecycle writes reach the parent (mutate tier), not the no-op path', async () => {
    const { api, sent } = setup()
    for (const ch of ['promptSessions:merge-active-index', 'promptSessions:write-archive']) {
      const r = find((x) => x.channel === ch)
      expect(r.remote).toBe('mutate')
      void api[r.ns][r.method]({ cwd: '/p' })
    }
    expect(sent).toHaveLength(2)
  })

  it('subscription delivers then unsubscribes', () => {
    const { api, sent, deliver } = setup()
    const r = find((x) => x.kind === 'on' && x.remote === 'read')
    const got: unknown[] = []
    const off = api[r.ns][r.method]((v: unknown) => got.push(v))
    expect(sent[0]).toMatchObject({ type: 'sm-ipc-subscribe', channel: r.channel })
    deliver({ type: 'sm-ipc-event', channel: r.channel, args: [42] })
    expect(got).toEqual([42])
    off()
    deliver({ type: 'sm-ipc-event', channel: r.channel, args: [43] })
    expect(got).toEqual([42])
  })
})

describe('remoteApi + transcripts.exists', () => {
  it('transcripts.exists is remote-readable (reaches the parent, not denied)', async () => {
    const { api, sent, deliver } = setup()
    const p = api.transcripts.exists('/proj', 'abc')
    expect(sent[0]).toMatchObject({ type: 'sm-ipc', channel: 'transcript:exists' })
    deliver({ type: 'sm-ipc-result', id: sent[0].id, result: true })
    await expect(p).resolves.toBe(true)
  })

  it('hydrateSessions under the web shim yields N tabs for N persisted tabs', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { api, sent, deliver } = setup()
    const tabs = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, sessionId: `s${i}`, cwd: `/p${i}`, label: `L${i}`, presetId: 'p' }))
    api.sessions.load = async () => ({ tabs, activeTabId: 't0', freshStart: false })
    // Answer transcript:exists probes through the shim; deny everything else.
    const origSend = sent.push.bind(sent)
    sent.push = (m: any) => {
      if (m.channel === 'transcript:exists') queueMicrotask(() => deliver({ type: 'sm-ipc-result', id: m.id, result: true }))
      return origSend(m)
    }
    vi.stubGlobal('window', { api })
    const { useSessions, hydrateSessions } = await import('../../state/sessions')
    await hydrateSessions()
    expect(useSessions.getState().tabs).toHaveLength(8)
    vi.unstubAllGlobals()
  })
})
