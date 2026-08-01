/**
 * Unit tests for health.cjs's evaluateTickLiveness — specifically that a
 * 'manual' firePolicy is not reported as a stall.
 *
 * Under a manual policy the scheduler is not supposed to pick jobs up on its
 * own, so pending work sitting with free capacity is the configured behaviour.
 * Reporting it RED made `npm run health` permanently red for anyone running
 * manual, which drowns out real stalls.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const health = require('../../src/main/health.cjs') as {
  evaluateTickLiveness: (
    queueState: Record<string, unknown>,
    heartbeat: Record<string, unknown> | null,
    now: number,
    runningCount?: number,
  ) => { stalled: boolean; reason: string }
  TICK_STALL_THRESHOLD_MS: number
}

const NOW = 1_785_000_000_000

/** A queue with pending work, free capacity, and a long-stale lastRunAt. */
function stalledLookingQueue(config: Record<string, unknown>) {
  return {
    jobs: [{ slug: 'some-prd', status: 'pending' }],
    paused: null,
    lastRunAt: new Date(NOW - health.TICK_STALL_THRESHOLD_MS - 60_000).toISOString(),
    config: { concurrencyCap: 3, enabled: true, ...config },
  }
}

describe('evaluateTickLiveness', () => {
  it("does not flag a stall when firePolicy is 'manual'", () => {
    const r = health.evaluateTickLiveness(stalledLookingQueue({ firePolicy: 'manual' }), null, NOW, 0)
    expect(r.stalled).toBe(false)
    expect(r.reason).toBe('manual-fire-policy')
  })

  it('still flags a genuine stall under a non-manual policy', () => {
    const r = health.evaluateTickLiveness(
      stalledLookingQueue({ firePolicy: 'on-reset' }),
      null,
      NOW,
      0,
    )
    expect(r.stalled).toBe(true)
  })

  it('reports no-pending-jobs ahead of the policy check', () => {
    const q = stalledLookingQueue({ firePolicy: 'manual' })
    q.jobs = []
    const r = health.evaluateTickLiveness(q, null, NOW, 0)
    expect(r.reason).toBe('no-pending-jobs')
  })

  it('reports paused ahead of the policy check', () => {
    const q = stalledLookingQueue({ firePolicy: 'manual' })
    q.paused = { reason: 'rate-limit' } as never
    const r = health.evaluateTickLiveness(q, null, NOW, 0)
    expect(r.reason).toBe('paused')
  })
})
