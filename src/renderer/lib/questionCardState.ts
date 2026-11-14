/**
 * questionCardState.ts — pure derivation of whether each Epic question card
 * is still the live ask.
 *
 * A question card accepts answers only while it is `open`. It closes as
 * `answered` once a HUMAN has replied after it, or as `superseded` once the
 * agent has asked again (a newer question turn exists) with no human reply
 * in between.
 *
 * Why scheduler check-ins don't count as a reply: the app injects them as
 * role 'user' turns, but chatRunner's `SCHEDULER_TURN_INSTRUCTION` tells the
 * agent never to ask — so a check-in landing after a question is not the
 * human's answer, and the card must stay answerable. The same holds for an
 * auto-started turn (`MACHINE_TURN_BLOCK_KEYS`) and for an optimistic turn
 * sent by another project / inbound proposal (`origin` 'external' /
 * 'inbound-proposal') — unless it carries the stop-signal block, which only
 * a chat-composer send (i.e. a human path) prepends.
 */
import type { ChatTurn } from '../state/chat'
import { MACHINE_TURN_BLOCK_KEYS, splitInjectedPreamble } from './promptPreamble'

export type QuestionCardState = 'open' | 'answered' | 'superseded'

/** True when a role 'user' turn was injected by the app, not typed by a human. */
export function isMachineUserTurn(turn: ChatTurn): boolean {
  if (turn.role !== 'user') return false
  const { blockKeys } = splitInjectedPreamble(turn.text)
  if (blockKeys.some((k) => MACHINE_TURN_BLOCK_KEYS.includes(k))) return true
  if (turn.origin === 'external' || turn.origin === 'inbound-proposal') {
    return !blockKeys.includes('stop-signal')
  }
  return false
}

/**
 * State for every role 'question' turn, keyed by turn.id. One backward pass,
 * O(n): a later human reply wins (`answered`), else a later question
 * (`superseded`), else `open`.
 */
export function questionCardStates(turns: ChatTurn[]): Map<string, QuestionCardState> {
  const states = new Map<string, QuestionCardState>()
  let laterHumanReply = false
  let laterQuestion = false
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn.role === 'question') {
      states.set(turn.id, laterHumanReply ? 'answered' : laterQuestion ? 'superseded' : 'open')
      laterQuestion = true
    } else if (turn.role === 'user' && !laterHumanReply && !isMachineUserTurn(turn)) {
      laterHumanReply = true
    }
  }
  return states
}
