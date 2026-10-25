'use strict'

/**
 * remoteClientSessions.test.cjs — per-client E2E session registry.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/remoteClientSessions.test.cjs
 */

import { describe, it, expect, vi } from 'vitest'

const { createClientSessions, clientKeyOf, LEGACY_CLIENT_KEY } = require('../lib/feedback-remote/remoteClientSessions.cjs')

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
    const a = s.getOrCreate('a')
    const b = s.getOrCreate('b')
    expect(a).not.toBe(b)
    expect(s.getOrCreate('a')).toBe(a)
    expect(a).not.toHaveProperty('clientId')
    expect(a.e2e).not.toBe(b.e2e)
    expect(a.subscriptions).not.toBe(b.subscriptions)
    expect(a).toMatchObject({ key: 'a', peerPubKey: null, deviceId: null, lastSessionListJson: null })
    expect(a.e2e.state).toBe('idle')
    expect(s.size()).toBe(2)
    expect(s.keys()).toEqual(['a', 'b'])
    expect(s.values()).toHaveLength(2)
  })

  it('authenticated() returns only authenticated records', () => {
    const s = createClientSessions()
    const a = s.getOrCreate('a')
    s.getOrCreate('b', {})
    a.e2e = { ...a.e2e, state: 'authenticated' }
    expect(s.authenticated()).toEqual([a])
  })

  it('teardown of one key leaves the other untouched', () => {
    const s = createClientSessions()
    const a = s.getOrCreate('a')
    const b = s.getOrCreate('b', {})
    a.subscriptions.add('t1')
    b.subscriptions.add('t2')
    expect(s.teardown('a')).toBe(a)
    expect(a.subscriptions.size).toBe(0)
    expect(s.get('a')).toBeNull()
    expect(s.get('b')).toBe(b)
    expect(b.subscriptions.has('t2')).toBe(true)
    expect(s.teardown('missing')).toBeNull()
  })

  it('teardownAll returns the count and empties the registry', () => {
    const s = createClientSessions()
    s.getOrCreate('a').subscriptions.add('t')
    s.getOrCreate('b', {})
    s.getOrCreate('c', {})
    expect(s.teardownAll()).toBe(3)
    expect(s.size()).toBe(0)
    expect(s.teardownAll()).toBe(0)
  })
})
