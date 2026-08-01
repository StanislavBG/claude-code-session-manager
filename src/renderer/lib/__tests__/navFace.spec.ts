import { describe, expect, it } from 'vitest'
import { deriveNavFace } from '../navFace'

describe('deriveNavFace', () => {
  it('overview panel -> home', () => {
    expect(deriveNavFace('overview', true)).toBe('home')
  })

  it('non-overview panel with an active tab -> project', () => {
    expect(deriveNavFace('scheduler', true)).toBe('project')
  })

  it('non-overview panel with no active tab -> home', () => {
    expect(deriveNavFace('scheduler', false)).toBe('home')
  })
})
