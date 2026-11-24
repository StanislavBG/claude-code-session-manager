import { describe, it, expect } from 'vitest'
import { computeStatus } from './computeStatus'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../../../preload/api.d'

const NOW = Date.parse('2026-11-23T12:00:00Z')

function snap(o: Partial<ScheduleStateSnapshot>): ScheduleStateSnapshot {
  return {
    config: { firePolicy: 'when-available', utilizationThreshold: 90 },
    jobs: [{ status: 'pending', slug: 'a', title: 'A' } as unknown as ScheduleJob],
    paused: null,
    nextReset: null,
    utilization: 50,
    utilizationWindow: 'weekly_all',
    utilizationHold: null,
    effectiveConcurrency: { cap: 5, free: 5, source: 'pool' },
    ...o,
  } as unknown as ScheduleStateSnapshot
}

const run = (s: ScheduleStateSnapshot) => computeStatus({ snap: s, now: NOW, avgDurationMs: 0, runningJobs: [] })

describe('computeStatus — utilization hold', () => {
  it('a hold present gives auto-throttled with the hold percent', () => {
    const r = run(snap({
      utilization: 50,
      utilizationHold: { window: 'five_hour', percent: 93, threshold: 90, resetsAt: new Date(NOW + 60 * 60_000).toISOString() },
    }))
    expect(r.kind).toBe('auto-throttled')
    expect(r.line1).toBe('Auto · throttled (util 93% ≥ 90%)')
    expect(r.line2).toMatch(/^5-hour window next resets /)
    expect(r.line2).not.toContain('long hold')
  })
  it('utilization 96 >= 90 with no hold is not throttled', () => {
    const r = run(snap({ utilization: 96, utilizationHold: null }))
    expect(r.kind).toBe('auto-soon')
  })
  it('a hold resetting over 5 h away uses the long-hold wording', () => {
    const r = run(snap({
      utilizationHold: { window: 'weekly_all', percent: 96, threshold: 90, resetsAt: new Date(NOW + 30 * 60 * 60_000).toISOString() },
    }))
    expect(r.kind).toBe('auto-throttled')
    expect(r.line1).toBe('Auto · throttled (util 96% ≥ 90%)')
    expect(r.line2).toMatch(/^weekly window — long hold, resets /)
  })
})
