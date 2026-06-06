/**
 * StatusBadge status→tone mapping characterization tests.
 *
 * CLASSES is the single source of truth for which CSS color tokens each status
 * renders with. These tests pin the mapping so a rename or reorder doesn't
 * silently change visual semantics.
 */
import { describe, it, expect } from 'vitest'
import { CLASSES } from '../../src/renderer/components/ui/StatusBadge'
import type { JobStatus } from '../../src/renderer/components/ui/StatusBadge'

const ALL_STATUSES: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'needs_review']

describe('StatusBadge CLASSES — all five statuses are mapped', () => {
  for (const status of ALL_STATUSES) {
    it(`${status} has a non-empty class string`, () => {
      expect(CLASSES[status]).toBeTruthy()
    })
  }
})

describe('StatusBadge CLASSES — color token semantics', () => {
  it('pending uses dim foreground (text-fg-dim)', () => {
    expect(CLASSES.pending).toContain('text-fg-dim')
  })

  it('running uses amber palette', () => {
    expect(CLASSES.running).toContain('amber')
  })

  it('completed uses green palette', () => {
    expect(CLASSES.completed).toContain('green')
  })

  it('failed uses red palette', () => {
    expect(CLASSES.failed).toContain('red')
  })

  it('needs_review uses orange palette', () => {
    expect(CLASSES.needs_review).toContain('orange')
  })
})

describe('StatusBadge CLASSES — statuses are mutually distinct', () => {
  it('no two statuses share the same class string', () => {
    const seen = new Set<string>()
    for (const status of ALL_STATUSES) {
      expect(seen.has(CLASSES[status])).toBe(false)
      seen.add(CLASSES[status])
    }
  })
})
