'use strict'

/**
 * remoteClientSessions.test.cjs — per-client E2E session registry.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/remoteClientSessions.test.cjs
 */

import { describe, it, expect, vi } from 'vitest'

const { createClientSessions, clientKeyOf, LEGACY_CLIENT_KEY } = require('../lib/remoteClientSessions.cjs')

describe('clientKeyOf', () => {
  it('uses fromConn when valid', () => {
    expect(clientKeyOf({ fromConn: 'abc' })).toBe('abc')
    expect(clientKeyOf({ fromConn: 'x'.repeat(64) })).toBe('x'.repeat(64))
  })

  it('falls back to legacy for missing / empty / overlong / non-string fromConn', () => {
    expect(LEGACY_CLIENT_KEY).toBe('legacy')
    expect(clientKeyOf({})).toBe('legacy')
    expect(clientKeyOf(null)).toBe('legacy')
    expect(clientKeyOf({ fromConn: '' })).toBe('legacy')
    expect(clientKeyOf({ fromConn: 'x'.repeat(65) })).toBe('legacy')
    expect(clientKeyOf({ fromConn: 42 })).toBe('legacy')
  })
})

describe('createClientSessions', () => {
  it('gives two keys independent records', () => {
    const s = createClientSessions()
    const a = s.getOrCreate('a', { clientId: 'phone' })
    const b = s.getOrCreate('b', { clientId: null })
    expect(a).not.toBe(b)
    expect(s.getOrCreate('a', {})).toBe(a)
    expect(a.clientId).toBe('phone')
    expect(b.clientId).toBeNull()
    expect(a.e2e).not.toBe(b.e2e)
    expect(a.ptyStreams).not.toBe(b.ptyStreams)
    expect(a.subscriptions).not.toBe(b.subscriptions)
    expect(a).toMatchObject({ key: 'a', peerPubKey: null, deviceId: null, lastSessionListJson: null })
    expect(a.e2e.state).toBe('idle')
    expect(s.size()).toBe(2)
    expect(s.keys()).toEqual(['a', 'b'])
    expect(s.values()).toHaveLength(2)
  })

  it('authenticated() returns only authenticated records', () => {
    const s = createClientSessions()
    const a = s.getOrCreate('a', {})
    s.getOrCreate('b', {})
    a.e2e = { ...a.e2e, state: 'authenticated' }
    expect(s.authenticated()).toEqual([a])
  })

  it('teardown of one key leaves the other and its ptyStreams untouched', () => {
    const s = createClientSessions()
    const ua = vi.fn()
    const ub = vi.fn()
    const a = s.getOrCreate('a', {})
    const b = s.getOrCreate('b', {})
    a.ptyStreams.set('t1', ua)
    a.subscriptions.add('t1')
    b.ptyStreams.set('t2', ub)
    b.subscriptions.add('t2')
    expect(s.teardown('a')).toBe(a)
    expect(ua).toHaveBeenCalledTimes(1)
    expect(a.subscriptions.size).toBe(0)
    expect(s.get('a')).toBeNull()
    expect(ub).not.toHaveBeenCalled()
    expect(s.get('b')).toBe(b)
    expect(b.ptyStreams.size).toBe(1)
    expect(b.subscriptions.has('t2')).toBe(true)
    expect(s.teardown('missing')).toBeNull()
  })

  it('teardown unsubscribes all even when one unsub throws', () => {
    const s = createClientSessions()
    const first = vi.fn(() => { throw new Error('boom') })
    const second = vi.fn()
    const a = s.getOrCreate('a', {})
    a.ptyStreams.set('t1', first)
    a.ptyStreams.set('t2', second)
    expect(() => s.teardown('a')).not.toThrow()
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    expect(s.size()).toBe(0)
  })

  it('teardownAll returns the count and empties the registry', () => {
    const s = createClientSessions()
    const u = vi.fn()
    s.getOrCreate('a', {}).ptyStreams.set('t', u)
    s.getOrCreate('b', {})
    s.getOrCreate('c', {})
    expect(s.teardownAll()).toBe(3)
    expect(u).toHaveBeenCalledTimes(1)
    expect(s.size()).toBe(0)
    expect(s.teardownAll()).toBe(0)
  })
})
