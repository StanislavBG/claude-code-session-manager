/**
 * epicOrigin.test.ts — the read side of an Epic's cross-project provenance
 * (lib/epicOrigin.ts). Guards the one thing the chip must never do: claim a
 * locally-created Epic came from somewhere else.
 *
 * Run: timeout 120 npx vitest run src/renderer/lib/__tests__/epicOrigin.test.ts
 */
import { describe, it, expect } from 'vitest'
import { inboundFeedbackOrigin, inboundSeriesSiblings } from '../epicOrigin'

const FULL_PROPOSAL = {
  motivation: 'Need X',
  originAsk: 'wiring the relay',
  plan: ['a', 'b'],
  acceptanceCriteria: ['c'],
  outOfScope: ['d'],
  series: { key: 'd2d', title: 'Desktop-to-desktop remote', index: 5, total: 7 },
}
const fromOther = (proposal?: unknown) => ({
  source: { producer: 'cross-project-feedback' as const, fromCwd: '/p/a', ...(proposal !== undefined ? { proposal } : {}) },
}) as any

describe('inboundFeedbackOrigin proposal', () => {
  it('is null for a legacy Epic with no proposal', () => {
    const o = inboundFeedbackOrigin(fromOther())
    expect(o?.proposal).toBeNull()
    expect(o?.seriesLabel).toBeNull()
  })

  it('returns a full proposal, series label and originAsk in the title', () => {
    const o = inboundFeedbackOrigin(fromOther(FULL_PROPOSAL))
    expect(o?.proposal).toEqual(FULL_PROPOSAL)
    expect(o?.seriesLabel).toBe('Part 5 of 7 · Desktop-to-desktop remote')
    expect(o?.title).toContain('raised while working on: wiring the relay')
  })

  it('treats a null series as no label', () => {
    const o = inboundFeedbackOrigin(fromOther({ ...FULL_PROPOSAL, series: null, originAsk: null }))
    expect(o?.proposal?.series).toBeNull()
    expect(o?.seriesLabel).toBeNull()
    expect(o?.title).not.toContain('raised while working on')
  })

  it('rejects malformed proposals', () => {
    expect(inboundFeedbackOrigin(fromOther('x'))?.proposal).toBeNull()
    expect(inboundFeedbackOrigin(fromOther({ ...FULL_PROPOSAL, plan: 'nope' }))?.proposal).toBeNull()
    expect(inboundFeedbackOrigin(fromOther({ ...FULL_PROPOSAL, motivation: 3 }))?.proposal).toBeNull()
    expect(inboundFeedbackOrigin(fromOther({ ...FULL_PROPOSAL, outOfScope: {} }))?.proposal).toBeNull()
  })

  it('drops a series with non-integer index/total but keeps the proposal', () => {
    const o = inboundFeedbackOrigin(fromOther({ ...FULL_PROPOSAL, series: { key: 'k', title: 't', index: 1.5, total: 7 } }))
    expect(o?.proposal).not.toBeNull()
    expect(o?.proposal?.series).toBeNull()
    expect(o?.seriesLabel).toBeNull()
  })
})

describe('inboundSeriesSiblings', () => {
  const mk = (id: string, index: number, key = 'd2d', status = 'proposed') => ({
    id, status, goalText: `goal ${id}`, cwd: '/x',
    source: { producer: 'cross-project-feedback', fromCwd: '/p/a', proposal: { ...FULL_PROPOSAL, series: { key, title: 'T', index, total: 7 } } },
  }) as any

  it('returns siblings sharing the series key, sorted by index', () => {
    const a = mk('a', 5)
    const epics = [mk('c', 7), a, mk('b', 2), mk('other', 1, 'zzz'), { id: 'legacy', status: 'active', goalText: 'g' } as any]
    expect(inboundSeriesSiblings(a, epics)).toEqual([
      { id: 'b', index: 2, status: 'proposed', goalText: 'goal b' },
      { id: 'a', index: 5, status: 'proposed', goalText: 'goal a' },
      { id: 'c', index: 7, status: 'proposed', goalText: 'goal c' },
    ])
  })

  it('returns [] when the Epic has no series', () => {
    expect(inboundSeriesSiblings({ id: 'x', source: { producer: 'new-epic-ui' } } as any, [mk('a', 1)])).toEqual([])
    expect(inboundSeriesSiblings(fromOther(), [mk('a', 1)])).toEqual([])
  })
})

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
