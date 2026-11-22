import { describe, expect, it } from 'vitest'
import { epicHasOpenQuestion, parkedJobLine } from '../needsHuman'

const BASE = 'PRD 3589-x is parked and the scheduler is fixing it — nothing is needed from you.'

describe('epicHasOpenQuestion', () => {
  it('is true when the Epic chat has a needs-input ticket', () => {
    const chats = { e1: { ticketHistory: [{ status: 'answered' }, { status: 'needs-input' }] } }
    expect(epicHasOpenQuestion('e1', chats)).toBe(true)
  })

  it('is false when every ticket is answered', () => {
    const chats = { e1: { ticketHistory: [{ status: 'answered' }, { status: 'answered' }] } }
    expect(epicHasOpenQuestion('e1', chats)).toBe(false)
  })

  it('is false when the Epic has no chat or no ticket history', () => {
    expect(epicHasOpenQuestion('missing', {})).toBe(false)
    expect(epicHasOpenQuestion('e1', { e1: {} })).toBe(false)
  })

  it('only looks at the named Epic', () => {
    const chats = { other: { ticketHistory: [{ status: 'needs-input' }] } }
    expect(epicHasOpenQuestion('e1', chats)).toBe(false)
  })
})

describe('parkedJobLine', () => {
  const line = (error?: string | null) => parkedJobLine({ slug: '3589-x', error })

  it('has no cause sentence for a null or missing error', () => {
    expect(line(null)).toBe(BASE)
    expect(line(undefined)).toBe(BASE)
  })

  it('has no cause sentence for an unmapped error', () => {
    expect(line('something else broke')).toBe(BASE)
  })

  it.each([
    ['worktree_integration_failed: conflict', 'Its commit could not be merged yet.'],
    ['Refusing to integrate: dirty tree', 'Its commit could not be merged yet.'],
    ['SENTINEL_FAIL in gate', 'Its checks did not pass.'],
    ['no_verdict', 'It ended without a verdict.'],
    ['Run ended with No Verdict line', 'It ended without a verdict.'],
  ])('maps %s to a cause sentence', (error, cause) => {
    expect(line(error)).toBe(`${BASE} ${cause}`)
  })
})
