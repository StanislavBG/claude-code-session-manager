import { describe, test, expect } from 'vitest'
import { getBillingData } from '../../src/renderer/state/billing'
import type { BillingData, BillingFetchResult } from '../../src/preload/api'

const DATA: BillingData = {
  usage: {
    five_hour: { utilization: 10, resets_at: null },
    seven_day: { utilization: 10, resets_at: null },
    seven_day_sonnet: null,
    seven_day_opus: null,
    seven_day_oauth_apps: null,
    extra_usage: null,
  },
  subscriptionType: null,
  rateLimitTier: null,
  credentialsExpiresAt: null,
  fetchedAt: 0,
}

describe('getBillingData', () => {
  test('returns null for null input', () => {
    expect(getBillingData(null)).toBeNull()
  })

  test('unwraps ok data', () => {
    const r: BillingFetchResult = { kind: 'ok', data: DATA }
    expect(getBillingData(r)).toBe(DATA)
  })

  test('unwraps ok-stale data', () => {
    const r: BillingFetchResult = { kind: 'ok-stale', data: DATA, staleSince: 0, lastError: 'x' }
    expect(getBillingData(r)).toBe(DATA)
  })

  // Regression: the Usage tab went completely blank (no meters, no error
  // banner) when the billing endpoint returned meter_rate_limited, because
  // this kind was missing from the BillingFetchResult type and unhandled
  // here — the switch below silently fell through to null.
  test('unwraps cached data on meter_rate_limited', () => {
    const r: BillingFetchResult = {
      kind: 'meter_rate_limited',
      message: 'rate limited',
      httpStatus: 429,
      cached: DATA,
      staleSince: 0,
    }
    expect(getBillingData(r)).toBe(DATA)
  })

  test('returns null on meter_rate_limited with no cache', () => {
    const r: BillingFetchResult = { kind: 'meter_rate_limited', message: 'rate limited', httpStatus: 429 }
    expect(getBillingData(r)).toBeNull()
  })

  test('unwraps cached data on auth failure', () => {
    const r: BillingFetchResult = { kind: 'auth', message: 'expired', httpStatus: 401, cached: DATA, staleSince: 0 }
    expect(getBillingData(r)).toBe(DATA)
  })

  test('returns null on config error', () => {
    const r: BillingFetchResult = { kind: 'config', message: 'not found' }
    expect(getBillingData(r)).toBeNull()
  })
})
