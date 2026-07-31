import type { ScheduleJob } from '../../preload/api'
import type { PromptTicket } from '../state/chat'
import { SchBadge } from './tabs/scheduler/sched-primitives'
import { TagChip, openPrdSlug } from './TerminalChat'

/**
 * Detailed view for one Prompt Queue ticket (PRD 777) — the original prompt,
 * its Feature/Bug tag, every linked PRD (with its live scheduler status via
 * SchBadge — sourced from scheduleState.ts, not a new poller), and any
 * follow-up prompts chained onto it (PRD 775's chainRootId). Reuses
 * TerminalChat's TagChip/openPrdSlug rather than reimplementing them.
 */

function jobFor(slug: string, jobs: ScheduleJob[]): ScheduleJob | undefined {
  return jobs.find((j) => j.slug === slug)
}

function TicketPrdList({ slugs, jobs }: { slugs: string[]; jobs: ScheduleJob[] }) {
  if (slugs.length === 0) {
    return <div className="text-xs italic text-fg-faint">No PRDs linked yet.</div>
  }
  return (
    <ul className="space-y-1.5" data-testid="ticket-detail-prd-list">
      {slugs.map((slug) => {
        const job = jobFor(slug, jobs)
        return (
          <li key={slug} className="flex items-center gap-2" data-testid="ticket-detail-prd">
            <button
              onClick={() => openPrdSlug(slug)}
              title={`Open PRD "${slug}" in Scheduler`}
              className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-accent hover:bg-hi"
            >
              #{slug}
            </button>
            {job && <SchBadge status={job.status} />}
          </li>
        )
      })}
    </ul>
  )
}

function TicketEntry({ ticket, jobs }: { ticket: PromptTicket; jobs: ScheduleJob[] }) {
  return (
    <div className="rounded-lg border border-line bg-elev px-3 py-2.5" data-testid="ticket-detail-entry">
      {ticket.tag && (
        <div className="mb-1.5">
          <TagChip tag={ticket.tag} />
        </div>
      )}
      <div className="whitespace-pre-wrap text-sm text-fg">{ticket.text}</div>
      <div className="mt-2">
        <TicketPrdList slugs={ticket.prdSlugs ?? []} jobs={jobs} />
      </div>
    </div>
  )
}

// Still reachable: Command Palette new-tab-pick/new-tab-here and the OS menu
// "Ctrl+N" (App.tsx) still create dormant SessionTabs, which Terminal.tsx
// renders through TerminalChat, which renders this alongside QueueTicketPanel.
// Not dead code — only the primary "+ New session" entry point stopped
// creating these tabs.
export function TicketDetailView({
  ticket,
  allTickets,
  jobs,
  onClose,
}: {
  ticket: PromptTicket
  /** The full merged ticket list for this tab (history + active + queue) — used to find follow-ups whose chainRootId points at `ticket`. */
  allTickets: PromptTicket[]
  jobs: ScheduleJob[]
  onClose: () => void
}) {
  // Chains are one level deep (PRD 775): a follow-up's chainRootId always
  // points at the original root ticket, never at an intermediate follow-up.
  const followUps = allTickets.filter((t) => t.chainRootId === ticket.id)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4" data-testid="ticket-detail-view">
      <div className="mb-3">
        <button
          onClick={onClose}
          data-testid="ticket-detail-back"
          className="rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-elev hover:text-fg"
        >
          ← Back to queue
        </button>
      </div>
      <TicketEntry ticket={ticket} jobs={jobs} />
      {followUps.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-line pl-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Follow-ups</div>
          {followUps.map((f) => (
            <TicketEntry key={f.id} ticket={f} jobs={jobs} />
          ))}
        </div>
      )}
    </div>
  )
}
