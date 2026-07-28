import type { PromptTicket } from '../state/chat'
import type { PrdDisplayStatus } from '../components/tabs/scheduler/sched-primitives'

/**
 * Maps a PromptTicket's lifecycle status onto the Almanac PRD status-pill
 * tones (sched-primitives.tsx's STATUS_TONE/PrdStatusPill) so the chat queue
 * panel reuses the existing status-badge primitive instead of a new one
 * (PRD 750). 'dispatched' is the one PRD-specific tone added there.
 */
export function ticketDisplayStatus(status: PromptTicket['status']): PrdDisplayStatus {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'dispatched-to-prd':
      return 'dispatched'
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
  }
}

/**
 * FIFO order for the chat queue panel: past tickets (oldest first), then the
 * one currently in flight, then anything still waiting behind it.
 */
export function mergeTicketsForDisplay(
  ticketHistory: PromptTicket[],
  activeTicket: PromptTicket | null | undefined,
  queue: PromptTicket[],
): PromptTicket[] {
  return [...ticketHistory, ...(activeTicket ? [activeTicket] : []), ...queue]
}
