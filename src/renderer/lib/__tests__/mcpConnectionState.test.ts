import { describe, it, expect } from 'vitest'
import { deriveMcpConnectionState } from '../mcpConnectionState'
import type { McpStatusResult } from '../../../preload/api'

function probeWith(servers: McpStatusResult['servers']): McpStatusResult {
  return { ok: true, servers, checkedAt: 0 }
}

describe('deriveMcpConnectionState', () => {
  it('is unprobed when probe is null', () => {
    expect(deriveMcpConnectionState('fetch', null)).toEqual({
      state: 'unprobed',
      label: 'Not checked',
      probeStatus: null,
      badgeTone: 'dim',
      dotState: 'offline',
    })
  })

  it('is unprobed when probe errored (ok: false)', () => {
    const probe: McpStatusResult = { ok: false, servers: [], error: 'timeout', checkedAt: 0 }
    expect(deriveMcpConnectionState('fetch', probe).state).toBe('unprobed')
  })

  it('is unprobed when no matching entry by name', () => {
    const probe = probeWith([{ name: 'other', target: 'x', transport: 'stdio', status: 'connected' }])
    expect(deriveMcpConnectionState('fetch', probe).state).toBe('unprobed')
  })

  it('is unprobed when entry status is unknown', () => {
    const probe = probeWith([{ name: 'fetch', target: 'x', transport: 'stdio', status: 'unknown' }])
    expect(deriveMcpConnectionState('fetch', probe).state).toBe('unprobed')
  })

  it('is ready when connected', () => {
    const probe = probeWith([{ name: 'fetch', target: 'x', transport: 'stdio', status: 'connected' }])
    expect(deriveMcpConnectionState('fetch', probe)).toEqual({
      state: 'ready',
      label: 'Ready',
      probeStatus: 'connected',
      badgeTone: 'good',
      dotState: 'live',
    })
  })

  it.each([
    ['failed', 'Failed'],
    ['needs-auth', 'Needs auth'],
    ['pending', 'Pending approval'],
  ] as const)('is not-ready with label for %s', (status, label) => {
    const probe = probeWith([{ name: 'fetch', target: 'x', transport: 'stdio', status }])
    expect(deriveMcpConnectionState('fetch', probe)).toEqual({
      state: 'not-ready',
      label,
      probeStatus: status,
      badgeTone: 'warn',
      dotState: 'attention',
    })
  })
})
