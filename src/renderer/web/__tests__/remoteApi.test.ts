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
    for (const ch of ['sessions:save', 'layout:save', 'promptSessions:merge-active-index']) {
      const r = find((x) => x.channel === ch)
      await expect(api[r.ns][r.method]({ x: 1 })).resolves.toEqual({ ok: true })
    }
    expect(sent).toHaveLength(0)
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
