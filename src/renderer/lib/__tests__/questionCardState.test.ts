import { describe, expect, it } from 'vitest'
import type { ChatTurn } from '../../state/chat'
import { isMachineUserTurn, questionCardStates } from '../questionCardState'

const SCHEDULER_TEXT =
  'IMPORTANT: This turn was started by the scheduler and nobody is watching. ' +
  'Do not ask questions; decide and act, ' +
  'and end with a short report of what you did.' +
  '\n\nPRD 12 finished: completed.'

const STOP_SIGNAL_TEXT =
  'IMPORTANT: First deliver everything you CAN answer, then flag what you cannot. ' +
  'Otherwise complete the task and end with a concise summary of what you did.' +
  '\n\nyes, go with option B'

let seq = 0
function turn(role: ChatTurn['role'], text: string, extra: Partial<ChatTurn> = {}): ChatTurn {
  seq += 1
  return { id: `t${seq}`, role, text, at: seq, ...extra }
}

describe('isMachineUserTurn', () => {
  it('is true for a scheduler check-in', () => {
    expect(isMachineUserTurn(turn('user', SCHEDULER_TEXT))).toBe(true)
  })
  it('is true for an origin external turn without the stop-signal block', () => {
    expect(isMachineUserTurn(turn('user', 'feedback from Bilko', { origin: 'external' }))).toBe(true)
    expect(isMachineUserTurn(turn('user', 'proposal', { origin: 'inbound-proposal' }))).toBe(true)
  })
  it('is false for an external-origin turn carrying the stop-signal block', () => {
    expect(isMachineUserTurn(turn('user', STOP_SIGNAL_TEXT, { origin: 'external' }))).toBe(false)
  })
  it('is false for human turns and terminal-typed turns', () => {
    expect(isMachineUserTurn(turn('user', 'plain reply', { origin: 'human' }))).toBe(false)
    expect(isMachineUserTurn(turn('user', STOP_SIGNAL_TEXT, { origin: 'human' }))).toBe(false)
    expect(isMachineUserTurn(turn('user', 'typed in terminal'))).toBe(false)
  })
  it('is false for non-user turns', () => {
    expect(isMachineUserTurn(turn('assistant', SCHEDULER_TEXT))).toBe(false)
  })
})

describe('questionCardStates', () => {
  it('the latest question with nothing after it is open', () => {
    const q = turn('question', 'Which one?')
    expect(questionCardStates([turn('user', 'hi'), turn('assistant', 'ok'), q]).get(q.id)).toBe('open')
  })
  it('a question followed by a human reply is answered', () => {
    const q = turn('question', 'Which one?')
    const states = questionCardStates([q, turn('user', STOP_SIGNAL_TEXT, { origin: 'human' })])
    expect(states.get(q.id)).toBe('answered')
  })
  it('a question followed only by a scheduler check-in stays open', () => {
    const q = turn('question', 'Which one?')
    const states = questionCardStates([q, turn('user', SCHEDULER_TEXT), turn('assistant', 'report')])
    expect(states.get(q.id)).toBe('open')
  })
  it('a question followed only by an optimistic external turn stays open', () => {
    const q = turn('question', 'Which one?')
    const states = questionCardStates([q, turn('user', 'cross-project note', { origin: 'external' })])
    expect(states.get(q.id)).toBe('open')
  })
  it('an older question followed by a newer question is superseded', () => {
    const older = turn('question', 'First?')
    const newer = turn('question', 'Second?')
    const states = questionCardStates([older, turn('assistant', 'hm'), newer])
    expect(states.get(older.id)).toBe('superseded')
    expect(states.get(newer.id)).toBe('open')
  })
  it('a human reply after both questions answers both', () => {
    const older = turn('question', 'First?')
    const newer = turn('question', 'Second?')
    const states = questionCardStates([older, newer, turn('user', 'both: A')])
    expect(states.get(older.id)).toBe('answered')
    expect(states.get(newer.id)).toBe('answered')
  })
  it('non-question turns are absent from the map', () => {
    const turns = [turn('user', 'hi'), turn('assistant', 'ok'), turn('question', 'Q?'), turn('notice', 'n')]
    const states = questionCardStates(turns)
    expect(states.size).toBe(1)
    expect(states.has(turns[0].id)).toBe(false)
    expect(states.has(turns[1].id)).toBe(false)
    expect(states.has(turns[3].id)).toBe(false)
  })
})
