import { describe, it, expect } from 'vitest'
import { buildEpicHandoff, summarizePrdOutcomes, HANDOFF_MAX_CHARS } from '../epicHandoff'
import type { PromptSessionEvent } from '../../state/promptSessions'

let n = 0
function makeEvent(overrides: Partial<PromptSessionEvent> = {}): PromptSessionEvent {
  n += 1
  return {
    id: `ev-${n}`,
    promptSessionId: 'epic-1',
    kind: 'response',
    causedByEventId: null,
    at: `2026-11-21T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    ...overrides,
  }
}

const EMPTY = { verified: [], refuted: [], unvalidated: [] }

describe('summarizePrdOutcomes', () => {
  it('lets the newest validation win: verified then refuted is refuted', () => {
    const out = summarizePrdOutcomes([
      makeEvent({ prdSlug: '100-a', validation: 'verified', outcome: 'completed' }),
      makeEvent({ prdSlug: '100-a', text: 'no validation here' }),
      makeEvent({ prdSlug: '100-a', validation: 'refuted' }),
    ])
    expect(out).toEqual({ verified: [], refuted: ['a'], unvalidated: [] })
  })

  it('counts an unvalidated completed PRD, but not an unvalidated failed one', () => {
    const out = summarizePrdOutcomes([
      makeEvent({ prdSlug: '200-b', validation: 'unvalidated', outcome: 'completed' }),
      makeEvent({ prdSlug: '201-c', validation: 'unvalidated', outcome: 'failed' }),
      makeEvent({ prdSlug: '202-d', validation: 'verified' }),
    ])
    expect(out).toEqual({ verified: ['d'], refuted: [], unvalidated: ['b'] })
  })

  // Shapes copied from real active-index.json events (PRD 3455).
  const finish = (slug: string, agentType = 'dev-lead') =>
    makeEvent({
      text: `PRD ${slug} finished: completed. Check Scheduler for details.`,
      prdSlug: slug,
      outcome: 'completed',
      validation: 'unvalidated',
      ...({ agentType } as object),
    })
  const verdict = (bare: string, v: 'verified' | 'refuted') =>
    makeEvent({ text: `Validation ${v.toUpperCase()}: ${bare}`, prdSlug: bare, outcome: 'completed', validation: v })

  it('merges a numbered finish event and its bare verdict event into one verified PRD', () => {
    const out = summarizePrdOutcomes([finish('3309-external-ref-schema'), verdict('external-ref-schema', 'verified')])
    expect(out).toEqual({ verified: ['external-ref-schema'], refuted: [], unvalidated: [] })
  })

  it('lists a finished PRD with no verdict once, as unvalidated, by bare slug', () => {
    const out = summarizePrdOutcomes([finish('3309-external-ref-schema')])
    expect(out).toEqual({ verified: [], refuted: [], unvalidated: ['external-ref-schema'] })
  })

  it('a refuted verdict after a numbered finish event is one refuted PRD', () => {
    const out = summarizePrdOutcomes([finish('3310-foo-bar'), verdict('foo-bar', 'refuted')])
    expect(out).toEqual({ verified: [], refuted: ['foo-bar'], unvalidated: [] })
  })

  it('ignores validate PRDs: by validate- bare slug and by validator agentType', () => {
    const out = summarizePrdOutcomes([
      finish('3309-external-ref-schema'),
      verdict('external-ref-schema', 'verified'),
      finish('3441-validate-continue-in-fresh-session', 'validator'),
      finish('3442-validate-other'),
      finish('3443-odd-name', 'validator'),
    ])
    expect(out).toEqual({ verified: ['external-ref-schema'], refuted: [], unvalidated: [] })
  })

  it('returns empty lists for no events and for malformed input', () => {
    expect(summarizePrdOutcomes([])).toEqual(EMPTY)
    expect(summarizePrdOutcomes(undefined as never)).toEqual(EMPTY)
    expect(summarizePrdOutcomes(null as never)).toEqual(EMPTY)
    expect(summarizePrdOutcomes([null, 5, { prdSlug: 3, validation: 'verified' }] as never)).toEqual(EMPTY)
  })
})

describe('buildEpicHandoff', () => {
  const outcomes = { verified: ['1-x', '2-y'], refuted: ['3-z'], unvalidated: ['4-w'] }

  it('puts header, stop block, PRD line and closing line in order', () => {
    const text = buildEpicHandoff({ fromEpicId: 'epic-9', title: 'Ship it', lastAssistantText: 'Done with step 3.', outcomes })
    const lines = text.split('\n')
    expect(lines[0]).toContain('Continued from session')
    expect(lines[0]).toContain('epic-9')
    expect(lines[0]).toContain('Ship it')
    const iStop = text.indexOf('Where it stopped')
    const iAnswer = text.indexOf('Done with step 3.')
    const iPrds = text.indexOf('2 verified, 1 refuted, 1 unvalidated')
    const iClose = text.indexOf('earlier history is not loaded')
    expect(iStop).toBeGreaterThan(0)
    expect(iAnswer).toBeGreaterThan(iStop)
    expect(iPrds).toBeGreaterThan(iAnswer)
    expect(text.indexOf('3-z')).toBeGreaterThan(iPrds)
    expect(text.indexOf('4-w')).toBeGreaterThan(iPrds)
    expect(iClose).toBeGreaterThan(iPrds)
    expect(lines[lines.length - 1]).toContain('not loaded')
    expect(lines[lines.length - 1]).toMatch(/ask/i)
    expect(lines[lines.length - 1]).toMatch(/next instruction/)
    expect(text).not.toMatch(/was cut/)
  })

  it('cuts a long answer to 4000 characters and says so', () => {
    const long = 'a'.repeat(9000)
    const text = buildEpicHandoff({ fromEpicId: 'e', title: 't', lastAssistantText: long, outcomes: EMPTY })
    expect(text).toContain('a'.repeat(4000))
    expect(text).not.toContain('a'.repeat(4001))
    expect(text).toMatch(/was cut/)
  })

  it('says no earlier answer was found for an empty or missing answer', () => {
    for (const a of ['', '   ', undefined, null]) {
      const text = buildEpicHandoff({ fromEpicId: 'e', title: 't', lastAssistantText: a as never, outcomes: EMPTY })
      expect(text).toContain('No earlier answer was found.')
      expect(text).toContain('0 verified, 0 refuted, 0 unvalidated')
    }
  })

  it('never exceeds 6000 characters and never throws on garbage', () => {
    expect(HANDOFF_MAX_CHARS).toBe(6000)
    const many = Array.from({ length: 100 }, (_, i) => `${i}-${'s'.repeat(200)}`)
    const text = buildEpicHandoff({
      fromEpicId: 'e'.repeat(5000),
      title: 'T'.repeat(5000),
      lastAssistantText: 'x'.repeat(50000),
      outcomes: { verified: many, refuted: many, unvalidated: many },
    })
    expect(text.length).toBeLessThanOrEqual(6000)
    expect(text).toContain('not loaded')
    expect(text).toContain('100 verified, 100 refuted, 100 unvalidated')
    expect(() => buildEpicHandoff(undefined as never)).not.toThrow()
    expect(() => buildEpicHandoff({ outcomes: { refuted: 'nope' } } as never)).not.toThrow()
    expect(buildEpicHandoff(null as never)).toContain('Continued from session')
  })

  it('lists at most 20 slugs of each kind', () => {
    const many = Array.from({ length: 25 }, (_, i) => `r${i}`)
    const text = buildEpicHandoff({ fromEpicId: 'e', title: 't', lastAssistantText: 'ok', outcomes: { verified: [], refuted: many, unvalidated: [] } })
    expect(text).toContain('r19')
    expect(text).not.toContain('r20')
    expect(text).toContain('5 more')
  })
})
