import { describe, it, expect } from 'vitest'
import { mergeTicketsForDisplay, ticketDisplayStatus } from '../ticketDisplay'
import type { PromptTicket } from '../../state/chat'

function ticket(overrides: Partial<PromptTicket>): PromptTicket {
  return {
    id: 'id',
    tabId: 't1',
    sessionId: 's1',
    cwd: '/proj',
    text: 'text',
    status: 'queued',
    createdAt: 0,
    ...overrides,
  }
}

describe('ticketDisplayStatus', () => {
  it('maps every PromptTicket status onto its Almanac PRD status-pill tone', () => {
    expect(ticketDisplayStatus('queued')).toBe('queued')
    expect(ticketDisplayStatus('running')).toBe('running')
    expect(ticketDisplayStatus('dispatched-to-prd')).toBe('dispatched')
    expect(ticketDisplayStatus('done')).toBe('completed')
    expect(ticketDisplayStatus('failed')).toBe('failed')
  })
})

describe('mergeTicketsForDisplay', () => {
  it('orders history first, then the active ticket, then the waiting queue', () => {
    const history = [ticket({ id: 'h1', status: 'done' }), ticket({ id: 'h2', status: 'failed' })]
    const active = ticket({ id: 'a1', status: 'running' })
    const queue = [ticket({ id: 'q1', status: 'queued' }), ticket({ id: 'q2', status: 'queued' })]

    expect(mergeTicketsForDisplay(history, active, queue).map((t) => t.id)).toEqual([
      'h1', 'h2', 'a1', 'q1', 'q2',
    ])
  })

  it('omits the active slot entirely when there is no in-flight ticket', () => {
    const queue = [ticket({ id: 'q1' })]
    expect(mergeTicketsForDisplay([], null, queue).map((t) => t.id)).toEqual(['q1'])
    expect(mergeTicketsForDisplay([], undefined, queue).map((t) => t.id)).toEqual(['q1'])
  })

  it('returns an empty list when there is nothing queued, active, or historical', () => {
    expect(mergeTicketsForDisplay([], null, [])).toEqual([])
  })
})
