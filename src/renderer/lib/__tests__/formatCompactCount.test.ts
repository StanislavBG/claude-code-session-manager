import { describe, it, expect } from 'vitest'
import { formatCompactCount } from '../formatCompactCount'

describe('formatCompactCount', () => {
  it('matches Usage-tab defaults (lower k, 0 decimals)', () => {
    expect(formatCompactCount(0)).toBe('0')
    expect(formatCompactCount(999)).toBe('999')
    expect(formatCompactCount(1_000)).toBe('1k')
    expect(formatCompactCount(1_500)).toBe('2k')
    expect(formatCompactCount(999_999)).toBe('1000k')
    expect(formatCompactCount(1_200_000)).toBe('1.2M')
    expect(formatCompactCount(50_000_000)).toBe('50.0M')
  })

  it('matches HistoryDashboard options (upper K, 1 decimal)', () => {
    const opts = { suffixCase: 'upper' as const, kDecimals: 1 }
    expect(formatCompactCount(0, opts)).toBe('0')
    expect(formatCompactCount(999, opts)).toBe('999')
    expect(formatCompactCount(1_000, opts)).toBe('1.0K')
    expect(formatCompactCount(1_500, opts)).toBe('1.5K')
    expect(formatCompactCount(999_999, opts)).toBe('1000.0K')
    expect(formatCompactCount(1_200_000, opts)).toBe('1.2M')
    expect(formatCompactCount(50_000_000, opts)).toBe('50.0M')
  })
})
