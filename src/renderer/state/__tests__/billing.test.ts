import { describe, it, expect } from 'vitest'
import type { BillingFetchResult } from '../../../preload/api'
import { computeNextPollDelayMs } from '../billing'

/**
 * On a 429 (or any non-ok result) the poller must back off — not accelerate —
 * doubling from a 60s baseline to a 300s cap with jitter, and resetting to
 * baseline on the next ok. computeNextPollDelayMs is the pure function tick()
 * uses to pick its next setTimeout delay, so driving it through the same
 * ok -> 429x4 -> ok sequence tick() would see is a direct test of the store's
 * actual backoff behavior.
 */

const BASE_DELAY_MS = 60_000
const MAX_DELAY_MS = 300_000
const JITTER_FRACTION = 0.25

function okResult(): BillingFetchResult {
  return {
    kind: 'ok',
    data: {
      usage: {
        five_hour: { utilization: 1, resets_at: null },
        seven_day: { utilization: 1, resets_at: null },
        seven_day_sonnet: null,
        seven_day_opus: null,
        seven_day_oauth_apps: null,
        extra_usage: null,
      },
      subscriptionType: null,
      rateLimitTier: null,
      credentialsExpiresAt: null,
      fetchedAt: Date.now(),
    },
  }
}

function rateLimitedResult(retryAfterMs?: number | null): BillingFetchResult {
  return { kind: 'meter_rate_limited', message: 'rate limited', httpStatus: 429, retryAfterMs }
}

function expectWithinJitter(delayMs: number, centerMs: number) {
  const spread = centerMs * JITTER_FRACTION
  expect(delayMs).toBeGreaterThanOrEqual(centerMs - spread)
  expect(delayMs).toBeLessThanOrEqual(centerMs + spread)
}

describe('billing.ts computeNextPollDelayMs', () => {
  it('doubles from baseline to a 300s cap across ok -> 429x4 -> ok, resetting on ok', () => {
    let backoffMs = BASE_DELAY_MS
    const delays: number[] = []
    const sequence = [okResult(), rateLimitedResult(), rateLimitedResult(), rateLimitedResult(), rateLimitedResult(), okResult()]

    for (const result of sequence) {
      const { delayMs, nextBackoffMs } = computeNextPollDelayMs(result, backoffMs)
      delays.push(delayMs)
      backoffMs = nextBackoffMs
    }

    expect(delays[0]).toBe(BASE_DELAY_MS) // ok
    expectWithinJitter(delays[1], 120_000) // 429 #1: 60s doubled
    expectWithinJitter(delays[2], 240_000) // 429 #2: 120s doubled
    expectWithinJitter(delays[3], MAX_DELAY_MS) // 429 #3: 240s doubled, capped at 300s
    expectWithinJitter(delays[4], MAX_DELAY_MS) // 429 #4: still capped at 300s
    expect(delays[5]).toBe(BASE_DELAY_MS) // ok resets to baseline
  })

  it('never accelerates below the 60s baseline on a rate-limited result', () => {
    const { delayMs } = computeNextPollDelayMs(rateLimitedResult(), BASE_DELAY_MS)
    expect(delayMs).toBeGreaterThan(BASE_DELAY_MS * 0.75)
  })

  it('floors the delay at retryAfterMs when the server names a longer wait', () => {
    const { delayMs } = computeNextPollDelayMs(rateLimitedResult(600_000), BASE_DELAY_MS)
    expect(delayMs).toBeGreaterThanOrEqual(600_000)
  })

  it('ignores a retryAfterMs shorter than the computed backoff', () => {
    const { delayMs } = computeNextPollDelayMs(rateLimitedResult(1_000), BASE_DELAY_MS)
    expectWithinJitter(delayMs, 120_000)
  })
})
