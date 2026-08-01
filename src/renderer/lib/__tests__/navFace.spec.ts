import { describe, expect, it } from 'vitest'
import { deriveNavFace } from '../navFace'

describe('deriveNavFace', () => {
  it('overview panel -> home', () => {
    expect(deriveNavFace('overview')).toBe('home')
  })

  it('non-overview panel -> project', () => {
    expect(deriveNavFace('scheduler')).toBe('project')
  })

  it('null panel -> project (never flips the nav on a transient null)', () => {
    expect(deriveNavFace(null)).toBe('project')
  })

  // Regression: the face must depend on the focused panel ALONE. It briefly
  // also returned 'home' when no session tab was selected, which made the
  // whole sidebar item set swap mid-click whenever activeTabId went null (a
  // legitimate state — the Epics workspace renders that way), reading as lost
  // top-tab focus and a nav that couldn't decide which version to render.
  it('is stable across panels regardless of tab-selection state', () => {
    for (const panel of ['terminal', 'projects', 'scheduler', 'memory']) {
      expect(deriveNavFace(panel)).toBe('project')
    }
    expect(deriveNavFace('overview')).toBe('home')
  })
})
