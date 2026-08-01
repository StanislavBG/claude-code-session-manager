/**
 * Compact read-only panel making an Epic's chat.ts prompt queue visible:
 * the active ticket (if any), each queued ticket in FIFO order, and a short
 * tail of recent terminal ticketHistory entries. Pure presentation over
 * TabChat — no cancel/remove/reorder (out of scope, see PRD).
 */
import { PrdStatusPill, type PrdDisplayStatus } from '../tabs/scheduler/sched-primitives'
import type { PromptTicket, TabChat } from '../../state/chat'

const HISTORY_TAIL = 5
const PREVIEW_MAX = 80

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Maps a PromptTicket's status to the STATUS_TONE key sched-primitives already styles. */
function ticketDisplayStatus(ticket: PromptTicket): PrdDisplayStatus {
  switch (ticket.status) {
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

interface Props {
  chat: TabChat | undefined
}

export function EpicQueuePanel({ chat }: Props) {
  const activeTicket = chat?.activeTicket
  const queue = chat?.queue ?? []
  const history = chat?.ticketHistory ?? []

  if (!activeTicket && queue.length === 0 && history.length === 0) return null

  // Classification round-trip: chat.ts:476 keeps activeTicket.status 'queued'
  // while classifyPromptTicket is in flight, before dequeueNext dispatches it.
  const activeLabel = activeTicket?.status === 'queued' ? 'classifying' : 'running'
  const recentHistory = [...history].reverse().slice(0, HISTORY_TAIL)

  return (
    <div
      className="grid gap-2 rounded-lg border border-line bg-bg-hi/40 px-3 py-2.5 text-xs"
      data-testid="epic-queue-panel"
    >
      {activeTicket && (
        <div className="flex items-center gap-2" data-testid="epic-queue-panel-active">
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
            {activeLabel}
          </span>
          <span className="truncate text-fg-dim">{truncate(activeTicket.text, PREVIEW_MAX)}</span>
        </div>
      )}

      {queue.length > 0 && (
        <div className="grid gap-1">
          {queue.map((ticket, i) => (
            <div key={ticket.id} className="flex items-center gap-2" data-testid="epic-queue-panel-item">
              <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">#{i + 1}</span>
              <span className="truncate text-fg-dim">{truncate(ticket.text, PREVIEW_MAX)}</span>
            </div>
          ))}
        </div>
      )}

      {recentHistory.length > 0 && (
        <div className="grid gap-1 border-t border-line pt-1.5">
          {recentHistory.map((ticket) => (
            <div key={ticket.id} className="flex items-center gap-2" data-testid="epic-queue-panel-history-item">
              <PrdStatusPill status={ticketDisplayStatus(ticket)} />
              <span className="truncate text-fg-faint">{truncate(ticket.text, PREVIEW_MAX)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
