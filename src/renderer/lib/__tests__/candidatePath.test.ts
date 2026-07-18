import { describe, it, expect } from 'vitest'
import { candidatePath } from '../useKnownProjects'

describe('candidatePath', () => {
  it('decodes an encoded ~/.claude/projects dir name to an absolute path', () => {
    expect(candidatePath('-home-bilko-Projects-session-manager')).toBe(
      '/home/bilko/Projects/session/manager',
    )
  })

  it('produces the same result Home.tsx used to derive inline (resume() consolidation)', () => {
    const encoded = '-home-bilko-Projects-foo'
    const legacyInline = '/' + encoded.replace(/^-/, '').replace(/-/g, '/')
    expect(candidatePath(encoded)).toBe(legacyInline)
  })

  it('last path segment matches the old decodeProject() dash-split behavior', () => {
    const encoded = '-home-bilko-Projects-session-manager'
    const legacyLastSegment = encoded.replace(/^-/, '').split('-').pop()
    const viaCandidatePath = candidatePath(encoded).split('/').filter(Boolean).pop()
    expect(viaCandidatePath).toBe(legacyLastSegment)
  })
})
