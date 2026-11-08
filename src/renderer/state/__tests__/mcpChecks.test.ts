import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { McpCheckRequest, McpCheckResult } from '../../../preload/api'

const connected = (name: string): McpCheckResult => ({
  ok: true,
  status: 'connected',
  tools: [{ name: `${name}_tool` }],
  checkedAt: 1,
})

const user = (name: string): McpCheckRequest => ({ source: 'user', name })

interface PendingCall {
  req: McpCheckRequest
  resolve: (r: McpCheckResult) => void
  reject: (e: unknown) => void
}

/** window.api.mcp.checkServer whose calls stay pending until the test settles them. */
function installApi() {
  const pending: PendingCall[] = []
  let active = 0
  let maxActive = 0
  const checkServer = vi.fn(
    (req: McpCheckRequest) =>
      new Promise<McpCheckResult>((resolve, reject) => {
        active++
        maxActive = Math.max(maxActive, active)
        pending.push({
          req,
          resolve: (r) => {
            active--
            resolve(r)
          },
          reject: (e) => {
            active--
            reject(e)
          },
        })
      }),
  )
  vi.stubGlobal('window', { api: { mcp: { checkServer } } })
  return { checkServer, pending, maxActive: () => maxActive }
}

/** The settle step of a pending call; fails the test if the call never started. */
function take(pending: PendingCall[], i: number): PendingCall {
  const call = pending[i]
  if (!call) throw new Error(`checkServer call #${i} never started`)
  return call
}

async function load() {
  const mod = await import('../mcpChecks')
  const { toast } = await import('../toast')
  return { ...mod, errSpy: vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id') }
}

/** Let every queued promise callback run. */
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('mcpChecks store', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('keys a server as source:(pluginKey ?? cwd ?? ""):name and checks nothing on import', async () => {
    const api = installApi()
    const { mcpCheckKey, useMcpChecks } = await load()
    expect(mcpCheckKey(user('fs'))).toBe('user::fs')
    expect(mcpCheckKey({ source: 'project', name: 'fs', cwd: '/p' })).toBe('project:/p:fs')
    expect(mcpCheckKey({ source: 'plugin', name: 'gh', pluginKey: 'gh@mkt' })).toBe('plugin:gh@mkt:gh')
    await tick()
    expect(api.checkServer).not.toHaveBeenCalled()
    expect(useMcpChecks.getState().results).toEqual({})
    expect(useMcpChecks.getState().checking).toEqual({})
  })

  it('stores each result under its own key and clears checking when it settles', async () => {
    const api = installApi()
    const m = await load()
    const s = m.useMcpChecks
    const a = user('fs')
    const b: McpCheckRequest = { source: 'project', name: 'fs', cwd: '/p' }
    const ka = m.mcpCheckKey(a)
    const kb = m.mcpCheckKey(b)
    const pa = s.getState().check(a)
    const pb = s.getState().check(b)
    expect(s.getState().checking).toEqual({ [ka]: true, [kb]: true })
    expect(m.selectMcpIsChecking(ka)(s.getState())).toBe(true)
    expect(api.checkServer).toHaveBeenCalledWith(a)
    expect(api.checkServer).toHaveBeenCalledWith(b)

    const ra = connected('fs')
    const rb: McpCheckResult = { ok: false, status: 'needs-auth', error: 'login required', checkedAt: 2 }
    take(api.pending, 0).resolve(ra)
    take(api.pending, 1).resolve(rb)
    expect(await pa).toBe(ra)
    expect(await pb).toBe(rb)

    const state = s.getState()
    expect(state.results).toEqual({ [ka]: ra, [kb]: rb })
    expect(state.results[ka]).toBe(ra)
    expect(state.checking).toEqual({})
    // Selectors hand back the stored references themselves, never a rebuilt value.
    expect(m.selectMcpCheckResult(ka)(state)).toBe(state.results[ka])
    expect(m.selectMcpCheckResult('user::missing')(state)).toBeUndefined()
    expect(m.selectMcpIsChecking(ka)(state)).toBe(false)
    expect(m.selectMcpCheckResults(state)).toBe(state.results)
    expect(m.selectMcpChecking(state)).toBe(state.checking)
  })

  it('checkAll never runs more than 2 checks at once with 5 requests and resolves when all finish', async () => {
    const api = installApi()
    const { useMcpChecks, mcpCheckKey } = await load()
    const reqs = ['a', 'b', 'c', 'd', 'e'].map(user)
    let done = false
    const all = useMcpChecks
      .getState()
      .checkAll(reqs)
      .then(() => {
        done = true
      })
    await tick()
    expect(api.checkServer).toHaveBeenCalledTimes(2)

    // Settle the oldest call each round; each one frees a slot for the next request.
    let settled = 0
    while (api.pending.length > 0) {
      expect(done).toBe(false)
      const call = api.pending.shift()
      if (!call) break
      call.resolve(connected(call.req.name))
      settled++
      await tick()
      expect(api.checkServer).toHaveBeenCalledTimes(Math.min(5, settled + 2))
    }
    await all
    expect(done).toBe(true)
    expect(settled).toBe(5)
    expect(api.checkServer).toHaveBeenCalledTimes(5)
    expect(api.maxActive()).toBe(2)
    const { results, checking } = useMcpChecks.getState()
    for (const r of reqs) expect(results[mcpCheckKey(r)]).toEqual(connected(r.name))
    expect(checking).toEqual({})
  })

  it('does not start a second check for a key already in flight', async () => {
    const api = installApi()
    const { useMcpChecks } = await load()
    const req: McpCheckRequest = { source: 'project', name: 'fs', cwd: '/p' }
    const first = useMcpChecks.getState().check(req)
    const second = useMcpChecks.getState().check({ ...req })
    const all = useMcpChecks.getState().checkAll([req, { ...req }])
    await tick()
    expect(api.checkServer).toHaveBeenCalledTimes(1)

    const r = connected('fs')
    take(api.pending, 0).resolve(r)
    expect(await first).toBe(r)
    expect(await second).toBe(r)
    await all
    expect(api.checkServer).toHaveBeenCalledTimes(1)

    // Once settled, the next check for that key runs again.
    const again = useMcpChecks.getState().check(req)
    expect(api.checkServer).toHaveBeenCalledTimes(2)
    const r2 = connected('fs2')
    take(api.pending, 1).resolve(r2)
    expect(await again).toBe(r2)
    expect(useMcpChecks.getState().results['project:/p:fs']).toBe(r2)
  })

  it('stores a rejected check as failed, shows it with toast.error, and checkAll carries on', async () => {
    const api = installApi()
    const { useMcpChecks, mcpCheckKey, errSpy } = await load()
    const reqs = ['a', 'b', 'c'].map(user)
    const all = useMcpChecks.getState().checkAll(reqs)
    await tick()
    take(api.pending, 0).reject(new Error('unparseable ~/.claude.json'))
    await tick()
    // a's slot went to c.
    expect(api.checkServer).toHaveBeenCalledTimes(3)
    take(api.pending, 1).resolve(connected('b'))
    take(api.pending, 2).resolve(connected('c'))
    await all

    const { results, checking } = useMcpChecks.getState()
    expect(results[mcpCheckKey(reqs[0])]).toEqual({
      ok: false,
      status: 'failed',
      error: 'unparseable ~/.claude.json',
      checkedAt: expect.any(Number),
    })
    expect(results[mcpCheckKey(reqs[1])]).toEqual(connected('b'))
    expect(results[mcpCheckKey(reqs[2])]).toEqual(connected('c'))
    expect(checking).toEqual({})
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('unparseable ~/.claude.json'))
  })

  it('stores a synchronous throw as failed and leaves the key free to check again', async () => {
    const api = installApi()
    const { useMcpChecks, mcpCheckKey, errSpy } = await load()
    api.checkServer.mockImplementationOnce(() => {
      throw new Error('denied')
    })
    const req = user('x')
    const r = await useMcpChecks.getState().check(req)
    expect(r).toMatchObject({ ok: false, status: 'failed', error: 'denied' })
    expect(useMcpChecks.getState().results[mcpCheckKey(req)]).toBe(r)
    expect(useMcpChecks.getState().checking).toEqual({})
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('denied'))

    const again = useMcpChecks.getState().check(req)
    expect(api.checkServer).toHaveBeenCalledTimes(2)
    const ok = connected('x')
    take(api.pending, 0).resolve(ok)
    expect(await again).toBe(ok)
  })
})
