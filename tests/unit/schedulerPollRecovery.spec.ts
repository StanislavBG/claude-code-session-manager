/**
 * Unit tests for pollRecoveryClearSource — the pure helper that decides which
 * clearPause source to emit when a successful billing poll arrives.
 *
 * Regression coverage for the 2026-06-10 incident: an auth pause was never
 * cleared because the r.kind==='ok' branch of pollLoop only cleared 'network'
 * and 'reset_failure' pauses, not 'auth'.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { pollRecoveryClearSource } = require('../../src/main/scheduler.cjs') as {
  pollRecoveryClearSource: (pauseReason: string | null, hasCachedReset: boolean) => string | null
}

describe('pollRecoveryClearSource', () => {
  it('clears auth pause on successful poll (incident fix)', () => {
    expect(pollRecoveryClearSource('auth', false)).toBe('auth-recovered')
  })

  it('clears auth pause even when cachedNextReset is present', () => {
    expect(pollRecoveryClearSource('auth', true)).toBe('auth-recovered')
  })

  it('clears network pause on successful poll', () => {
    expect(pollRecoveryClearSource('network', false)).toBe('network-recovered')
  })

  it('clears reset_failure when cachedNextReset is available', () => {
    expect(pollRecoveryClearSource('reset_failure', true)).toBe('reset-recovered')
  })

  it('does NOT clear reset_failure when no cachedNextReset', () => {
    expect(pollRecoveryClearSource('reset_failure', false)).toBeNull()
  })

  it('returns null when queue is not paused', () => {
    expect(pollRecoveryClearSource(null, false)).toBeNull()
  })

  it('returns null for manual pause (user-initiated, should not auto-clear)', () => {
    expect(pollRecoveryClearSource('manual', false)).toBeNull()
  })

  it('returns null for unknown pause reason', () => {
    expect(pollRecoveryClearSource('rate_limit', false)).toBeNull()
  })
})
