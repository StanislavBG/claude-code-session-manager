import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../estimateTokens'

describe('estimateTokens', () => {
  it('EDGE: empty string estimates 0 tokens', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('CORE: estimates ceil(chars / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})
