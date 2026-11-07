import { describe, it, expect } from 'vitest'
import { nextServerName, serialize, diffServerPatches } from '../McpServers'
import { buildInstallEntry, mcpPatchTarget } from '../Library'

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

describe('diffServerPatches', () => {
  it('add: patches only the new key', () => {
    expect(diffServerPatches({ a: { command: 'x' } }, { a: { command: 'x' }, b: { type: 'stdio', command: '' } }))
      .toEqual([{ name: 'b', value: { type: 'stdio', command: '' } }])
  })
  it('rename: new name first, then old name to undefined', () => {
    const p = diffServerPatches({ old: { command: 'x' } }, { fresh: { command: 'x' } })
    expect(p).toEqual([
      { name: 'fresh', value: { command: 'x' } },
      { name: 'old', value: undefined },
    ])
  })
})

describe('McpLibrary install payload', () => {
  it('writes URL entries with type http', () => {
    expect(buildInstallEntry({ url: 'https://x/mcp', headers: { a: 'b' } })).toEqual({ url: 'https://x/mcp', headers: { a: 'b' }, type: 'http' })
  })
  it('keeps a declared type', () => {
    expect(buildInstallEntry({ url: 'https://x/sse', type: 'sse' } as never).type).toBe('sse')
  })
  it('targets the page scope', () => {
    expect(mcpPatchTarget('project', '/p')).toEqual({ fileId: 'mcpJson', scope: 'project', cwd: '/p' })
    expect(mcpPatchTarget('user', '/p')).toEqual({ fileId: 'claudeJson', scope: 'user' })
  })
})
