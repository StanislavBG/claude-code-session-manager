import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../src/main/webRemote.cjs') as {
  __test: Record<string, unknown> & { setWs: (ws: unknown) => void }
}

// Relay protocol pings do not traverse the bilko.run proxy, so the desktop must
// never run a watchdog that terminates the socket on their absence.
describe('no relay protocol-ping watchdog', () => {
  it('does not export the removed watchdog surface', () => {
    expect(__test.checkRelayLiveness).toBeUndefined()
    expect(__test.RELAY_PING_SILENCE_MS).toBeUndefined()
    expect(__test.setLastRelayPingAt).toBeUndefined()
  })

  it('never terminates an OPEN socket from the exported surface', () => {
    const ws = { readyState: 1, terminate: vi.fn(), send: vi.fn() }
    __test.setWs(ws)
    for (const fn of Object.values(__test)) {
      if (typeof fn === 'function' && fn.length === 0 && /^(check|liveness)/i.test(fn.name)) fn()
    }
    expect(ws.terminate).not.toHaveBeenCalled()
    __test.setWs(null)
  })
})
