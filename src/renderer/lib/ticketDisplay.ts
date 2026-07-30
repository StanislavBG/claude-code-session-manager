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
    case 'needs-input':
      return 'needs_input'
  }
}

/**
 * Tone for a ticket's user-selected Feature/Bug tag (PRD 774) — the same
 * {bg,text,border,label} shape as sched-primitives.tsx's STATUS_TONE, so the
 * chip rendered in the queue panel reuses that tone pattern rather than
 * inventing a separate color system.
 */
const TAG_TONE: Record<'feature' | 'bug', { bg: string; text: string; border: boolean; label: string }> = {
  feature: { bg: 'bg-sage/20', text: 'text-sage', border: true, label: 'Feature' },
  bug: { bg: 'bg-accent/15', text: 'text-accent', border: true, label: 'Bug' },
}

export function ticketTagTone(tag: 'feature' | 'bug') {
  return TAG_TONE[tag]
}

/**
 * FIFO order for the chat queue panel: past tickets (oldest first), then the
 * one currently in flight, then anything still waiting behind it — except
 * any 'needs-input' ticket, which is pinned to the very top so a stalled
 * question can never scroll out of view behind newer queued/history tickets.
 */
export function mergeTicketsForDisplay(
  ticketHistory: PromptTicket[],
  activeTicket: PromptTicket | null | undefined,
  queue: PromptTicket[],
): PromptTicket[] {
  const all = [...ticketHistory, ...(activeTicket ? [activeTicket] : []), ...queue]
  const needsInput = all.filter((t) => t.status === 'needs-input')
  const rest = all.filter((t) => t.status !== 'needs-input')
  return [...needsInput, ...rest]
}
