import { describe, expect, it } from 'vitest'
import { computeBilkoHostReadiness, computeProjectPageLensStatus, deriveBilkoSlug } from './bilkoHost'

describe('computeBilkoHostReadiness', () => {
  it('blocks when there is no Marketing page yet', () => {
    expect(
      computeBilkoHostReadiness({ hasMarketingPage: false, packagePrivate: false, packageHomepage: null }),
    ).toEqual({ kind: 'no-marketing-page' })
  })

  it('requires confirmation for a private package with no homepage', () => {
    expect(
      computeBilkoHostReadiness({ hasMarketingPage: true, packagePrivate: true, packageHomepage: null }),
    ).toEqual({ kind: 'private-needs-confirm' })
  })

  it('is ready for a private package that already has a public homepage', () => {
    expect(
      computeBilkoHostReadiness({ hasMarketingPage: true, packagePrivate: true, packageHomepage: 'https://example.com' }),
    ).toEqual({ kind: 'ready' })
  })

  it('is ready for a non-private package', () => {
    expect(
      computeBilkoHostReadiness({ hasMarketingPage: true, packagePrivate: false, packageHomepage: null }),
    ).toEqual({ kind: 'ready' })
  })
})

describe('deriveBilkoSlug', () => {
  it('kebab-cases a scoped npm package name', () => {
    expect(deriveBilkoSlug('claude-code-session-manager')).toBe('claude-code-session-manager')
  })

  it('strips non-alphanumeric characters and collapses runs', () => {
    expect(deriveBilkoSlug('My Cool App!! v2')).toBe('my-cool-app-v2')
  })

  it('trims leading/trailing separators', () => {
    expect(deriveBilkoSlug('--Hello--')).toBe('hello')
  })

  it('falls back to "project" for an empty/unusable name', () => {
    expect(deriveBilkoSlug('   ')).toBe('project')
    expect(deriveBilkoSlug('!!!')).toBe('project')
  })
})

describe('computeProjectPageLensStatus', () => {
  it('with no documents at all, marketing is implicitly root and the others are available', () => {
    const result = computeProjectPageLensStatus([])
    expect(result).toEqual([
      { lens: 'home', status: 'available', subpath: 'home', documentId: null },
      { lens: 'marketing', status: 'root', subpath: '', documentId: null },
      { lens: 'feature', status: 'available', subpath: 'feature', documentId: null },
      { lens: 'architecture', status: 'available', subpath: 'architecture', documentId: null },
    ])
  })

  it('reflects an already-seeded root document', () => {
    const documents = [
      { id: 'r1', subpath: '', source: { kind: 'project-page-lens' as const, lens: 'marketing' as const } },
    ]
    const result = computeProjectPageLensStatus(documents)
    expect(result.find((r) => r.lens === 'marketing')).toEqual({ lens: 'marketing', status: 'root', subpath: '', documentId: 'r1' })
    expect(result.find((r) => r.lens === 'home')).toEqual({ lens: 'home', status: 'available', subpath: 'home', documentId: null })
  })

  it('reflects an already-hosted sub-path document', () => {
    const documents = [
      { id: 'r1', subpath: '', source: { kind: 'project-page-lens' as const, lens: 'marketing' as const } },
      { id: 'd2', subpath: 'feature', source: { kind: 'project-page-lens' as const, lens: 'feature' as const } },
    ]
    const result = computeProjectPageLensStatus(documents)
    expect(result.find((r) => r.lens === 'feature')).toEqual({ lens: 'feature', status: 'hosted', subpath: 'feature', documentId: 'd2' })
  })

  it('does not claim marketing is the implicit root once a different lens already took the root slot', () => {
    const documents = [
      { id: 'r1', subpath: '', source: { kind: 'project-page-lens' as const, lens: 'home' as const } },
    ]
    const result = computeProjectPageLensStatus(documents)
    expect(result.find((r) => r.lens === 'home')).toEqual({ lens: 'home', status: 'root', subpath: '', documentId: 'r1' })
    expect(result.find((r) => r.lens === 'marketing')).toEqual({ lens: 'marketing', status: 'available', subpath: 'marketing', documentId: null })
  })

  it('a custom-file root does not get mistaken for a project-page lens', () => {
    const documents = [
      { id: 'r1', subpath: '', source: { kind: 'file' as const, path: 'docs/custom.html' } },
    ]
    const result = computeProjectPageLensStatus(documents)
    expect(result.find((r) => r.lens === 'marketing')).toEqual({ lens: 'marketing', status: 'available', subpath: 'marketing', documentId: null })
  })
})
