/**
 * Unit tests for the E2E session state machine used by webRemote.
 *
 * AC (2026-06-10): deriveSas-failure path leaves state 'failed' and
 * confirm-sas returns ok:false; a confirmed session returns ok:true.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

type E2eState = { state: string; sessionKey: Buffer | null; pendingSas: string | null }
type ConfirmResult = { ok: boolean; error?: string; next: E2eState }

const { makeState, confirmSas } = require('../../src/main/lib/e2eStateMachine.cjs') as {
  makeState: (state?: string, sessionKey?: Buffer | null, pendingSas?: string | null) => E2eState
  confirmSas: (e2eState: E2eState) => ConfirmResult
}

describe('makeState', () => {
  it('defaults to idle with no key or SAS', () => {
    const s = makeState()
    expect(s.state).toBe('idle')
    expect(s.sessionKey).toBeNull()
    expect(s.pendingSas).toBeNull()
  })

  it('stores provided values', () => {
    const key = Buffer.alloc(32, 0xab)
    const s = makeState('pending_sas', key, '123456')
    expect(s.state).toBe('pending_sas')
    expect(s.sessionKey).toBe(key)
    expect(s.pendingSas).toBe('123456')
  })
})

describe('confirmSas — deriveSas-failure path', () => {
  it('state failed → ok:false with error e2e_failed', () => {
    // Simulate: deriveSessionKey succeeded but deriveSas threw → state set to failed
    const s = makeState('failed', null, null)
    const result = confirmSas(s)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('e2e_failed')
    // State must not change
    expect(result.next.state).toBe('failed')
  })
})

describe('confirmSas — idle / wrong state', () => {
  it('idle → ok:false with error no_e2e_session', () => {
    const result = confirmSas(makeState())
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_e2e_session')
  })

  it('already authenticated → ok:false with error already_authenticated', () => {
    const result = confirmSas(makeState('authenticated', Buffer.alloc(32), null))
    expect(result.ok).toBe(false)
    expect(result.error).toBe('already_authenticated')
  })
})

describe('confirmSas — happy path', () => {
  it('pending_sas → authenticated, returns ok:true', () => {
    const key = Buffer.alloc(32, 0x01)
    const s = makeState('pending_sas', key, '654321')
    const result = confirmSas(s)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.next.state).toBe('authenticated')
    expect(result.next.sessionKey).toBe(key)
    expect(result.next.pendingSas).toBeNull()
  })

  it('authenticated next-state preserves session key', () => {
    const key = Buffer.alloc(32, 0x02)
    const { next } = confirmSas(makeState('pending_sas', key, '000000'))
    expect(next.sessionKey).toBe(key)
  })
})
