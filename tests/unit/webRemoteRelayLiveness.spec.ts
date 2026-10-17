import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../src/main/webRemote.cjs') as {
  __test: {
    setWs: (ws: unknown) => void
    checkRelayLiveness: (now?: number) => boolean
    setLastRelayPingAt: (ts: number) => void
    RELAY_PING_SILENCE_MS: number
  }
}

describe('relay protocol-ping liveness watchdog', () => {
  let ws: { readyState: number; terminate: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
  const T0 = 1_000_000

  beforeEach(() => {
    ws = { readyState: 1, terminate: vi.fn(), send: vi.fn() }
    __test.setWs(ws)
  })

  it('terminates when relay pings are silent past the window (app pongs irrelevant)', () => {
    __test.setLastRelayPingAt(T0)
    expect(__test.checkRelayLiveness(T0 + __test.RELAY_PING_SILENCE_MS + 1)).toBe(true)
    expect(ws.terminate).toHaveBeenCalledTimes(1)
  })

  it('does not terminate when a ping arrived within the window', () => {
    __test.setLastRelayPingAt(T0)
    expect(__test.checkRelayLiveness(T0 + __test.RELAY_PING_SILENCE_MS)).toBe(false)
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('does not terminate a freshly opened socket (clock just reset)', () => {
    const now = Date.now()
    __test.setLastRelayPingAt(now)
    expect(__test.checkRelayLiveness(now + 1_000)).toBe(false)
    __test.setLastRelayPingAt(0)
    expect(__test.checkRelayLiveness(now + 10 * __test.RELAY_PING_SILENCE_MS)).toBe(false)
    expect(ws.terminate).not.toHaveBeenCalled()
  })
})
