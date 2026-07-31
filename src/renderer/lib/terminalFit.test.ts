import { describe, expect, it } from 'vitest'
import { canFit } from './terminalFit'

describe('canFit', () => {
  it('rejects zero width', () => {
    expect(canFit(0, 400)).toBe(false)
  })

  it('rejects zero height', () => {
    expect(canFit(600, 0)).toBe(false)
  })

  it('rejects zero width and height', () => {
    expect(canFit(0, 0)).toBe(false)
  })

  it('rejects negative dimensions', () => {
    expect(canFit(-1, 400)).toBe(false)
  })

  it('accepts positive dimensions', () => {
    expect(canFit(600, 400)).toBe(true)
  })
})
