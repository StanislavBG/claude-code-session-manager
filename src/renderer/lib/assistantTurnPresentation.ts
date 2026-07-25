import type { ChatTurn } from '../state/chat'

export type AssistantTurnPresentation = 'text' | 'working' | 'placeholder' | 'suppress'

/**
 * Decides how an assistant turn's bubble should render when `turn.text` may be
 * empty — e.g. a resumed turn that opens with a thinking block (not rendered)
 * before any visible text arrives. See session-manager-operations/feedback/
 * 2026-07-21-chat-empty-assistant-bubble.md.
 */
export function assistantTurnPresentation(turn: ChatTurn, runActive: boolean): AssistantTurnPresentation {
  if (turn.text.trim().length > 0) return 'text'
  if (runActive) return 'working'
  return turn.toolUses?.length ? 'placeholder' : 'suppress'
}
