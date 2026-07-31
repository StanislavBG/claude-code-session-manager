import type { PromptSession } from '../state/promptSessions'
import type { TabChat } from '../state/chat'
import { epicDisplayStatus, type EpicDisplayStatus, type EpicSnapshots } from './epicDerive'

/**
 * One "What is in flight" card for ProjectHome's live Now block — plain data,
 * never LLM-synthesized. Note line per epicDisplayStatus per the design spec.
 */
export interface InFlightCard {
  epicId: string
  title: string
  status: EpicDisplayStatus
  note: string
}

function noteFor(status: EpicDisplayStatus, epic: PromptSession): string {
  switch (status) {
    case 'running':
      return epic.tag ? `${epic.tag} · ${epic.goalText}` : epic.goalText
    case 'needs':
      return 'waiting on your answer'
    case 'queued':
      return 'ready to run when a slot frees'
    case 'draft':
    default:
      return 'not started'
  }
}

function recencyMs(epic: PromptSession, chat: TabChat | undefined): number {
  const lastTurnAt = chat?.turns.length ? chat.turns[chat.turns.length - 1].at : null
  if (lastTurnAt != null) return lastTurnAt
  const created = Date.parse(epic.createdAt)
  return Number.isNaN(created) ? 0 : created
}

/**
 * Up to 3 active Epics for `cwd`, most-recently-active first. Archived
 * (status !== 'active') Epics never appear — this is the "in flight" block.
 */
export function inFlightCards(cwd: string, snapshots: EpicSnapshots): InFlightCard[] {
  const epics = Object.values(snapshots.sessions).filter((e) => e.cwd === cwd && e.status === 'active')
  const withRecency = epics.map((epic) => ({
    epic,
    recency: recencyMs(epic, snapshots.chats[epic.id]),
  }))
  withRecency.sort((a, b) => b.recency - a.recency)
  return withRecency.slice(0, 3).map(({ epic }) => {
    const status = epicDisplayStatus(epic.id, snapshots)
    return {
      epicId: epic.id,
      title: epic.goalText,
      status,
      note: noteFor(status, epic),
    }
  })
}

/** One pending needs-input question surfaced in ProjectHome's "Waiting on you" block. */
export interface OpenQuestion {
  epicId: string
  epicGoalText: string
  ticketId: string
  question: string
}

/**
 * Pending `needs-input` tickets across `cwd`'s active Epics. Question text is
 * read from the ChatTurn the ticket's `questionTurnId` points at (falls back
 * to the ticket's own prompt text if that turn isn't present).
 */
export function openQuestions(
  cwd: string,
  sessions: Record<string, PromptSession>,
  chats: Record<string, TabChat>,
): OpenQuestion[] {
  const out: OpenQuestion[] = []
  for (const epic of Object.values(sessions)) {
    if (epic.cwd !== cwd || epic.status !== 'active') continue
    const chat = chats[epic.id]
    if (!chat) continue
    for (const ticket of chat.ticketHistory ?? []) {
      if (ticket.status !== 'needs-input') continue
      const turn = ticket.questionTurnId ? chat.turns.find((t) => t.id === ticket.questionTurnId) : undefined
      out.push({
        epicId: epic.id,
        epicGoalText: epic.goalText,
        ticketId: ticket.id,
        question: turn?.text ?? ticket.text,
      })
    }
  }
  return out
}
