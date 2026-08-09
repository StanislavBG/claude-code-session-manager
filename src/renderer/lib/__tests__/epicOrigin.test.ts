/**
 * epicOrigin.test.ts — the read side of an Epic's cross-project provenance
 * (lib/epicOrigin.ts). Guards the one thing the chip must never do: claim a
 * locally-created Epic came from somewhere else.
 *
 * Run: timeout 120 npx vitest run src/renderer/lib/__tests__/epicOrigin.test.ts
 */
import { describe, it, expect } from 'vitest'
import { inboundFeedbackOrigin } from '../epicOrigin'

describe('inboundFeedbackOrigin', () => {
  it('is null for an Epic with no source stamp at all', () => {
    expect(inboundFeedbackOrigin({})).toBeNull()
  })

  it('is null for every other producer', () => {
    expect(inboundFeedbackOrigin({ source: { producer: 'new-epic-ui' } })).toBeNull()
    expect(inboundFeedbackOrigin({ source: { producer: 'scheduler-dispatch', prdSlug: '12-x' } })).toBeNull()
  })

  it('is null when the producer says cross-project but no origin cwd survived', () => {
    // Defensive: a truncated/hand-edited record must not render a chip with
    // an empty project name.
    expect(inboundFeedbackOrigin({ source: { producer: 'cross-project-feedback' } })).toBeNull()
  })

  it('labels with the sending project folder name, not the whole path', () => {
    const origin = inboundFeedbackOrigin({
      source: { producer: 'cross-project-feedback', fromCwd: '/home/bilko/Projects/Bilko' },
    })
    expect(origin?.label).toBe('Bilko')
    expect(origin?.fromCwd).toBe('/home/bilko/Projects/Bilko')
  })

  it('tolerates a trailing separator rather than labelling with an empty segment', () => {
    expect(inboundFeedbackOrigin({
      source: { producer: 'cross-project-feedback', fromCwd: '/home/bilko/Projects/Bilko/' },
    })?.label).toBe('Bilko')
  })

  it('carries the sending session id into the hover text when it is known', () => {
    const origin = inboundFeedbackOrigin({
      source: { producer: 'cross-project-feedback', fromCwd: '/p/a', fromEpicId: 'epic-123' },
    })
    expect(origin?.fromEpicId).toBe('epic-123')
    expect(origin?.title).toContain('epic-123')
  })

  it('always warns in the hover text that the sender has not read this codebase', () => {
    const origin = inboundFeedbackOrigin({
      source: { producer: 'cross-project-feedback', fromCwd: '/p/a' },
    })
    expect(origin?.title).toMatch(/has not read it/)
  })
})
