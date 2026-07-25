import { describe, it, expect } from 'vitest'
import { usd, tok, int, min, pct } from '../analyticsFormat'

describe('usd', () => {
  it('uses 4 decimals under $1, 2 decimals at/above $1', () => {
    expect(usd(0)).toBe('$0.0000')
    expect(usd(0.1234)).toBe('$0.1234')
    expect(usd(0.99999)).toBe('$1.0000')
    expect(usd(1)).toBe('$1.00')
    expect(usd(42.5)).toBe('$42.50')
  })
})

describe('tok', () => {
  it('applies k/M/B thresholds', () => {
    expect(tok(0)).toBe('0')
    expect(tok(999)).toBe('999')
    expect(tok(1_000)).toBe('1.0K')
    expect(tok(1_500)).toBe('1.5K')
    expect(tok(999_999)).toBe('1000.0K')
    expect(tok(1_000_000)).toBe('1.0M')
    expect(tok(999_999_999)).toBe('1000.0M')
    expect(tok(1_000_000_000)).toBe('1.0B')
  })
})

describe('int', () => {
  it('adds thousands separators', () => {
    expect(int(0)).toBe('0')
    expect(int(999)).toBe('999')
    expect(int(1000)).toBe('1,000')
    expect(int(1234567)).toBe('1,234,567')
  })
})

describe('min', () => {
  it('formats minutes, hours+minutes', () => {
    expect(min(0)).toBe('0m')
    expect(min(45)).toBe('45m')
    expect(min(60)).toBe('1h')
    expect(min(90)).toBe('1h 30m')
    expect(min(125)).toBe('2h 5m')
  })
})

describe('pct', () => {
  it('special-cases the <1% band and rounds to 1 decimal otherwise', () => {
    expect(pct(0)).toBe('0.0%')
    expect(pct(0.4)).toBe('<1%')
    expect(pct(0.99)).toBe('<1%')
    expect(pct(1)).toBe('1.0%')
    expect(pct(12.34)).toBe('12.3%')
    expect(pct(100)).toBe('100.0%')
  })
})
