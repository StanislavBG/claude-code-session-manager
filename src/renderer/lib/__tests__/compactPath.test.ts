import { describe, it, expect } from 'vitest'
import { compactPath } from '../compactPath'

describe('compactPath', () => {
  it('compacts under a Linux home', () => {
    expect(compactPath('/home/alice/Projects/x', '/home/alice')).toBe('~/Projects/x')
  })
  it('compacts under a macOS home', () => {
    expect(compactPath('/Users/sam/code/app', '/Users/sam')).toBe('~/code/app')
  })
  it('returns ~ for the exact home', () => {
    expect(compactPath('/home/alice', '/home/alice')).toBe('~')
  })
  it('tolerates a trailing slash on home', () => {
    expect(compactPath('/Users/sam/code', '/Users/sam/')).toBe('~/code')
    expect(compactPath('/Users/sam', '/Users/sam/')).toBe('~')
  })
  it('does not treat a sibling prefix as inside', () => {
    expect(compactPath('/home/alice/x', '/home/al')).toBe('/home/alice/x')
  })
  it('returns the path unchanged for a null home', () => {
    expect(compactPath('/home/alice/x', null)).toBe('/home/alice/x')
  })
  it('returns paths outside home unchanged', () => {
    expect(compactPath('/opt/tools', '/home/alice')).toBe('/opt/tools')
  })
})
