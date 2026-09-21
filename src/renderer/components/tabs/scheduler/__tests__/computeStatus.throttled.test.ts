import { describe, it, expect } from 'vitest'
import { computeStatus } from '../computeStatus'

const NOW = Date.parse('2026-09-21T12:00:00Z')
function snap(over: Record<string, unknown>) {
  return {
    config: { firePolicy: 'when-available', utilizationThreshold: 90, offsetMinutes: 15 },
    jobs: [{ slug: 'a', status: 'pending' }],
    paused: null,
    utilization: 91,
    ...over,
  } as never
}
const run = (over: Record<string, unknown>) =>
  computeStatus({ snap: snap(over), now: NOW, avgDurationMs: 0, runningJobs: [] })

describe('computeStatus auto-throttled', () => {
  it('names the window and marks a multi-day reset as a long hold', () => {
    const r = run({ utilizationWindow: 'weekly_all', nextReset: '2026-09-24T17:00:00Z' })
    expect(r.kind).toBe('auto-throttled')
    expect(r.line1).toBe('Auto · throttled (util 91% ≥ 90%)')
    expect(r.line2).toContain('weekly')
    expect(r.line2).toContain('long hold')
  })
  it('a short hold is not marked long', () => {
    const r = run({ utilizationWindow: 'session', nextReset: '2026-09-21T14:00:00Z' })
    expect(r.line2).toContain('5-hour')
    expect(r.line2).not.toContain('long hold')
  })
  it('unknown reset is treated as long', () => {
    const r = run({ utilizationWindow: 'weekly_all', nextReset: null })
    expect(r.line2).toContain('long hold')
  })
})
