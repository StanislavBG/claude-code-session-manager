import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { schemas, SCHEDULE_SLUG_RE } = require('../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
  SCHEDULE_SLUG_RE: RegExp
}

// ──────────────────────────────────────────── schedule:archive-prd
// scheduleArchivePrd: { slugs: array of SCHEDULE_SLUG_RE strings, min 1, max 500 }
// SCHEDULE_SLUG_RE = /^[A-Za-z0-9._-]{1,128}$/

describe('scheduleArchivePrd schema', () => {
  it('accepts a single valid slug', () => {
    expect(schemas.scheduleArchivePrd.safeParse({ slugs: ['01-my-prd.md'] }).success).toBe(true)
  })

  it('accepts multiple valid slugs', () => {
    const slugs = ['01-alpha.md', '02-beta.md', '10-gamma.md']
    expect(schemas.scheduleArchivePrd.safeParse({ slugs }).success).toBe(true)
  })

  it('accepts slugs with dots and hyphens', () => {
    expect(schemas.scheduleArchivePrd.safeParse({ slugs: ['feature.release-2.md'] }).success).toBe(true)
  })

  it('accepts exactly 500 slugs (max cap)', () => {
    const slugs = Array.from({ length: 500 }, (_, i) => `prd-${i}.md`)
    expect(schemas.scheduleArchivePrd.safeParse({ slugs }).success).toBe(true)
  })

  it('rejects empty slugs array (min 1)', () => {
    expect(schemas.scheduleArchivePrd.safeParse({ slugs: [] }).success).toBe(false)
  })

  it('rejects 501 slugs (above max cap)', () => {
    const slugs = Array.from({ length: 501 }, (_, i) => `prd-${i}.md`)
    expect(schemas.scheduleArchivePrd.safeParse({ slugs }).success).toBe(false)
  })

  it('rejects slug with path-traversal (..)', () => {
    expect(schemas.scheduleArchivePrd.safeParse({ slugs: ['../etc/passwd'] }).success).toBe(false)
  })

  it('rejects slug with slash (would escape prds/ dir)', () => {
    expect(schemas.scheduleArchivePrd.safeParse({ slugs: ['prds/../secret'] }).success).toBe(false)
  })

  it('rejects slug with space', () => {
    expect(schemas.scheduleArchivePrd.safeParse({ slugs: ['my prd.md'] }).success).toBe(false)
  })

  it('rejects slug exceeding 128 chars', () => {
    const slug = 'a'.repeat(129)
    expect(schemas.scheduleArchivePrd.safeParse({ slugs: [slug] }).success).toBe(false)
  })

  it('rejects missing slugs field', () => {
    expect(schemas.scheduleArchivePrd.safeParse({}).success).toBe(false)
  })
})

// ──────────────────────────────────────────── schedule:retag-prd
// scheduleRetagPrd: { items: array of retagItem, min 1, max 500 }
// retagItem: { slug, parallelGroup?, estimateMinutes? } — at least one of pg/em required

describe('scheduleRetagPrd schema', () => {
  it('accepts item with parallelGroup only', () => {
    const items = [{ slug: '01-alpha.md', parallelGroup: 2 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(true)
  })

  it('accepts item with estimateMinutes only', () => {
    const items = [{ slug: '01-alpha.md', estimateMinutes: 30 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(true)
  })

  it('accepts item with both parallelGroup and estimateMinutes', () => {
    const items = [{ slug: '01-alpha.md', parallelGroup: 5, estimateMinutes: 60 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(true)
  })

  it('accepts multiple valid items', () => {
    const items = [
      { slug: '01-alpha.md', parallelGroup: 1 },
      { slug: '02-beta.md', estimateMinutes: 45 },
    ]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(true)
  })

  it('rejects item with neither parallelGroup nor estimateMinutes', () => {
    const items = [{ slug: '01-alpha.md' }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects parallelGroup below 0', () => {
    const items = [{ slug: '01-alpha.md', parallelGroup: -1 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects parallelGroup above 999', () => {
    const items = [{ slug: '01-alpha.md', parallelGroup: 1000 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects estimateMinutes below 1', () => {
    const items = [{ slug: '01-alpha.md', estimateMinutes: 0 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects estimateMinutes above 100000', () => {
    const items = [{ slug: '01-alpha.md', estimateMinutes: 100001 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects slug with path traversal', () => {
    const items = [{ slug: '../evil', parallelGroup: 1 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects empty items array (min 1)', () => {
    expect(schemas.scheduleRetagPrd.safeParse({ items: [] }).success).toBe(false)
  })

  it('rejects 501 items (above max cap)', () => {
    const items = Array.from({ length: 501 }, (_, i) => ({ slug: `prd-${i}.md`, parallelGroup: 1 }))
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects non-integer parallelGroup', () => {
    const items = [{ slug: '01-alpha.md', parallelGroup: 1.5 }]
    expect(schemas.scheduleRetagPrd.safeParse({ items }).success).toBe(false)
  })

  it('rejects missing items field', () => {
    expect(schemas.scheduleRetagPrd.safeParse({}).success).toBe(false)
  })
})

// ──────────────────────────────────────────── SCHEDULE_SLUG_RE export
describe('SCHEDULE_SLUG_RE (exported constant)', () => {
  it('matches simple slug', () => {
    expect(SCHEDULE_SLUG_RE.test('01-my-prd.md')).toBe(true)
  })

  it('matches slug with dots', () => {
    expect(SCHEDULE_SLUG_RE.test('feature.release.md')).toBe(true)
  })

  it('does not match path traversal', () => {
    expect(SCHEDULE_SLUG_RE.test('../evil')).toBe(false)
  })

  it('does not match slug with slash', () => {
    expect(SCHEDULE_SLUG_RE.test('prds/evil.md')).toBe(false)
  })

  it('does not match empty string', () => {
    expect(SCHEDULE_SLUG_RE.test('')).toBe(false)
  })
})
