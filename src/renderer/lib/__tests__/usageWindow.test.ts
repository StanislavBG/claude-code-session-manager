import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatReset, usageTitle, utilPercent } from '../usageWindow'

// +900ms of slack: formatReset floors, so a few ms of test-execution drift
// between building the timestamp and reading it would otherwise round down.
const at = (msFromNow: number) =>
  new Date(Date.now() + msFromNow + (msFromNow > 0 ? 900 : 0)).toISOString()

afterEach(() => vi.useRealTimers())

describe('utilPercent', () => {
  it('rounds a live window and tolerates a missing one', () => {
    expect(utilPercent({ utilization: 33.4, resets_at: null })).toBe(33)
    expect(utilPercent({ utilization: 99.6, resets_at: null })).toBe(100)
    // Over-100 is a real API value (overage) and must not be clamped away —
    // the footer says "112%" rather than pretending the window is full.
    expect(utilPercent({ utilization: 112, resets_at: null })).toBe(112)
    expect(utilPercent(null)).toBeNull()
    expect(utilPercent(undefined)).toBeNull()
  })

  it('treats a non-numeric utilization as unavailable rather than NaN%', () => {
    expect(utilPercent({ utilization: Number.NaN, resets_at: null })).toBeNull()
  })
})

describe('formatReset', () => {
  it('formats sub-hour, hour and multi-day distances', () => {
    expect(formatReset(at(25 * 60_000))?.rel).toBe('25m')
    expect(formatReset(at(2 * 3_600_000 + 14 * 60_000))?.rel).toBe('2h 14m')
    expect(formatReset(at(4 * 86_400_000 + 3 * 3_600_000))?.rel).toBe('4d 3h')
  })

  it('returns null for absent/garbage input and "now" for the past', () => {
    expect(formatReset(null)).toBeNull()
    expect(formatReset('not-a-date')).toBeNull()
    expect(formatReset(at(-5_000))).toEqual({ rel: 'now', abs: '' })
  })

  it('renders the absolute time in Pacific with an explicit zone suffix', () => {
    const r = formatReset(at(90 * 60_000))
    expect(r?.abs).toMatch(/PT$/)
  })
})

describe('usageTitle', () => {
  it('states window, percent and reset, and invites the click', () => {
    const t = usageTitle('Weekly window (all models)', { utilization: 34.2, resets_at: at(4 * 86_400_000) })
    expect(t).toContain('Weekly window (all models)')
    expect(t).toContain('34% used')
    expect(t).toContain('resets in 4d 0h')
    expect(t).toContain('click to open Home')
  })

  it('degrades to an explicit "unavailable" instead of a bare percent sign', () => {
    expect(usageTitle('Session (5h window)', null)).toBe('Session (5h window) — usage unavailable')
  })

  it('omits the reset clause when the window has no resets_at', () => {
    const t = usageTitle('Session (5h window)', { utilization: 10, resets_at: null })
    expect(t).not.toContain('resets in')
    expect(t).toContain('10% used')
  })
})
