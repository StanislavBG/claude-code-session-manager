// Pure row-model for the Global Home "Needs you" section (Home Screen A
// design). Joins three REAL signals that already gate on a human somewhere
// in the app — nothing here is fabricated:
//   - a `proposed` Epic (the human gate that replaced the feedback folder —
//     see EpicApprovalBar.tsx)
//   - a chat ticket in `needs-input` (the composer's stop-signal protocol)
//   - a scheduler job in `failed` / `needs_review` (the queue's own verdict)
// Kept dependency-free (plain shapes, no store imports) so it is
// unit-testable without mocking zustand — same shape as homeSessionRows.ts.
import { projectNameFromCwd } from './homeProjectRows'

export interface ProposedEpicLite {
  id: string
  cwd: string
  goalText: string
  tag?: string
}

export interface TicketLite {
  id: string
  tabId: string
  cwd: string
  status: string
  text: string
}

export interface ScheduleJobLite {
  slug: string
  title: string
  cwd: string | null
  status: string
  error: string | null
}

export type NeedsYouKind = 'proposed-epic' | 'needs-input' | 'job-failed'

export interface NeedsYouRow {
  id: string
  kind: NeedsYouKind
  label: string
  detail: string
  meta: string
  project: string | null
  /** Epic id for 'proposed-epic' / 'needs-input' rows (drives Approve/Open actions). */
  epicId: string | null
  /** Job slug for 'job-failed' rows (drives Retry). */
  jobSlug: string | null
}

/**
 * Builds the unified "needs you" list. `sessions` must already be scoped to
 * every hydrated Epic (active + archived merge, same map Home's other cards
 * read) — only `status === 'proposed'` entries surface here since archived
 * Epics are 'completed'. `chats` keys on Epic id (== tabId); only chats
 * whose most recent ticket is 'needs-input' surface. `jobs` is the
 * scheduler snapshot; only 'failed' / 'needs_review' surface.
 */
export function buildNeedsYouRows(
  sessions: Record<string, ProposedEpicLite>,
  chats: Record<string, { ticketHistory?: TicketLite[] }>,
  jobs: ScheduleJobLite[],
): NeedsYouRow[] {
  const rows: NeedsYouRow[] = []

  for (const id of Object.keys(sessions)) {
    const s = sessions[id]
    rows.push({
      id: `proposed:${id}`,
      kind: 'proposed-epic',
      label: 'Proposed Epic — awaiting approval',
      detail: s.goalText,
      meta: s.tag ? `tag: ${s.tag}` : 'Filed for you to decide on. Nothing has run.',
      project: projectNameFromCwd(s.cwd),
      epicId: id,
      jobSlug: null,
    })
  }

  for (const epicId of Object.keys(chats)) {
    const history = chats[epicId]?.ticketHistory ?? []
    const last = history[history.length - 1]
    if (!last || last.status !== 'needs-input') continue
    rows.push({
      id: `needs-input:${last.id}`,
      kind: 'needs-input',
      label: 'Session is asking a question',
      detail: last.text,
      meta: 'Stopped mid-run, waiting on your reply.',
      project: projectNameFromCwd(last.cwd),
      epicId,
      jobSlug: null,
    })
  }

  for (const job of jobs) {
    if (job.status !== 'failed' && job.status !== 'needs_review') continue
    rows.push({
      id: `job:${job.slug}`,
      kind: 'job-failed',
      label: job.status === 'failed' ? 'Scheduler job failed' : 'Scheduler job needs review',
      detail: job.title || job.slug,
      meta: job.error ?? 'No error detail recorded.',
      project: job.cwd ? projectNameFromCwd(job.cwd) : null,
      epicId: null,
      jobSlug: job.slug,
    })
  }

  return rows
}
