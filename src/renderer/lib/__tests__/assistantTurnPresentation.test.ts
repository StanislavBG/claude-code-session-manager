import { describe, expect, it } from 'vitest'
import { assistantTurnPresentation } from '../assistantTurnPresentation'
import type { ChatTurn } from '../../state/chat'

function turn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return { id: 't1', role: 'assistant', text: '', at: 0, ...overrides }
}

describe('assistantTurnPresentation', () => {
  it('renders text when the turn has non-empty text', () => {
    expect(assistantTurnPresentation(turn({ text: 'hello' }), false)).toBe('text')
    expect(assistantTurnPresentation(turn({ text: 'hello' }), true)).toBe('text')
  })

  it('treats whitespace-only text as empty', () => {
    expect(assistantTurnPresentation(turn({ text: '   \n\t' }), false)).toBe('suppress')
  })

  it('shows a working affordance when the run is still active with no text', () => {
    expect(assistantTurnPresentation(turn({ text: '' }), true)).toBe('working')
  })

  it('shows a placeholder when finished, empty, but has tool uses', () => {
    const t = turn({ text: '', toolUses: [{ id: 'u1', kind: 'tool', label: 'Bash' }] })
    expect(assistantTurnPresentation(t, false)).toBe('placeholder')
  })

  it('suppresses the bubble when finished, empty, and no tool uses', () => {
    expect(assistantTurnPresentation(turn({ text: '', toolUses: [] }), false)).toBe('suppress')
    expect(assistantTurnPresentation(turn({ text: '' }), false)).toBe('suppress')
  })
})
