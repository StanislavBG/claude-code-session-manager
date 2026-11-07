import { describe, it, expect } from 'vitest'
import { nextServerName, serialize } from '../McpServers'

describe('nextServerName', () => {
  it('picks server-1 for an empty set', () => {
    expect(nextServerName({})).toBe('server-1')
  })

  it('picks the next unused index by default', () => {
    expect(nextServerName({ 'server-1': {} })).toBe('server-2')
  })

  it('does not collide with an existing key after a deletion', () => {
    // Regression: {server-1, server-2} with server-1 deleted leaves count=1,
    // so a naive `server-${count+1}` recomputes to "server-2" and silently
    // clobbers the surviving entry instead of adding a new one.
    const servers = { 'server-2': {} }
    expect(nextServerName(servers)).not.toBe('server-2')
    expect(nextServerName(servers)).toBe('server-3')
  })

  it('walks past multiple collisions', () => {
    const servers = { 'server-2': {}, 'server-3': {}, 'server-4': {} }
    expect(nextServerName(servers)).toBe('server-5')
  })
})

describe('serialize', () => {
  it('strips a stale enabled key from server entries', () => {
    const out = JSON.parse(
      serialize({ other: 1 }, { a: { command: 'x', enabled: false } as never, b: { url: 'u' } }),
    )
    expect(out.mcpServers.a).toEqual({ command: 'x' })
    expect(out.mcpServers.b).toEqual({ url: 'u' })
    expect(out.other).toBe(1)
  })
})
