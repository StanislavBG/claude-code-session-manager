import type { PromptTicket } from '../state/chat'
import type { PrdDisplayStatus } from '../components/tabs/scheduler/sched-primitives'
import type { EpicTag } from './tagLibrary'

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
 * The tag a user picks in the composer before starting an epic. 'feature' and
 * 'bug' (PRD 774) both describe work to be built, so they stay eligible for
 * the inline-vs-/develop classifier. 'discussion' is the odd one out: it
 * declares up front that the goal is back-and-forth research with the agent,
 * so it must never be routed to PRD authoring — see isDiscussionTag below.
 */
export type TicketTag = EpicTag

/**
 * Tone for a ticket's user-selected tag — the same {bg,text,border,label}
 * shape as sched-primitives.tsx's STATUS_TONE, so the chip rendered in the
 * queue panel reuses that tone pattern rather than inventing a separate
 * color system.
 */
const TAG_TONE: Record<TicketTag, { bg: string; text: string; border: boolean; label: string }> = {
  feature: { bg: 'bg-sage/20', text: 'text-sage', border: true, label: 'Feature' },
  bug: { bg: 'bg-accent/15', text: 'text-accent', border: true, label: 'Bug' },
  discussion: { bg: 'bg-butter/25', text: 'text-fg-dim', border: true, label: 'Discussion' },
  build: { bg: 'bg-hive-teal/20', text: 'text-hive-teal', border: true, label: 'Build' },
  'project-home-builder': { bg: 'bg-honey/20', text: 'text-honey-dark', border: true, label: 'Project Home Builder' },
  'bilko-host-publisher': { bg: 'bg-sage/15', text: 'text-sage-dark', border: true, label: 'Bilko Host Publisher' },
}

export function ticketTagTone(tag: TicketTag) {
  return TAG_TONE[tag]
}

/**
 * A 'discussion' ticket is an explicit statement of intent: the user wants an
 * interactive research conversation, not decomposition into scheduled PRDs.
 * dequeueNext() short-circuits the classifier on this, the same way it does
 * for external-origin tickets — different reason, same guarantee that
 * dispatchToPrd() is unreachable.
 */
export function isDiscussionTag(tag: TicketTag | undefined): boolean {
  return tag === 'discussion'
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
