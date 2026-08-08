// Pure row-model for the Global Home "Needs you" section (Home Screen A
// design). Joins four REAL signals that already gate on a human somewhere
// in the app — nothing here is fabricated:
//   - a `proposed` Epic (the human gate that replaced the feedback folder —
//     see EpicApprovalBar.tsx)
//   - a chat ticket in `needs-input` (the composer's stop-signal protocol)
//   - a scheduler job in `failed` / `needs_review` (the queue's own verdict)
//   - a scheduler job `quarantined` (no createdVia provenance — the
//     PRD-authoring lockdown gate; see scheduler.cjs's reconcile())
// Kept dependency-free (plain shapes, no store imports) so it is
// unit-testable without mocking zustand — same shape as homeSessionRows.ts.
import { projectNameFromCwd } from './homeProjectRows'

// Mirrors QUARANTINE_ESCALATE_MS in src/main/lib/schedulerConfig.cjs — that
// side is authoritative for the warn-log escalation
// (scheduler.cjs's findStaleQuarantinedJobs); this only decides when a
// quarantined row's Home tone/label switches from "needs adoption" to
// "stale, needs adoption" so a stranded row reads differently at a glance.
export const QUARANTINE_ESCALATE_MS = 24 * 60 * 60 * 1000

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
  /** Bounded status-transition trail (see ScheduleJobStatusHistoryEntry) —
   *  only the `to === 'quarantined'` entry's `at` is read here, to compute
   *  how long a quarantined row has sat un-adopted. */
  statusHistory?: { to: string; at: string }[]
}

export type NeedsYouKind = 'proposed-epic' | 'needs-input' | 'job-failed' | 'job-quarantined'

export interface NeedsYouRow {
  id: string
  kind: NeedsYouKind
  label: string
  detail: string
  meta: string
  project: string | null
  /** Epic id for 'proposed-epic' / 'needs-input' rows (drives Approve/Open actions). */
  epicId: string | null
  /** Job slug for 'job-failed' / 'job-quarantined' rows (drives Retry / Adopt). */
  jobSlug: string | null
  /** 'job-quarantined' only — true once the row has sat un-adopted past
   *  QUARANTINE_ESCALATE_MS. Drives the row's tone/label on Home. */
  escalated?: boolean
}

/** Finds the recorded quarantine timestamp, if any — see ScheduleJobLite.statusHistory. */
function quarantinedAtMs(job: ScheduleJobLite): number | null {
  const entry = (job.statusHistory ?? []).find((h) => h.to === 'quarantined')
  if (!entry) return null
  const ms = Date.parse(entry.at)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Builds the unified "needs you" list. `sessions` must already be scoped to
 * every hydrated Epic (active + archived merge, same map Home's other cards
 * read) — only `status === 'proposed'` entries surface here since archived
 * Epics are 'completed'. `chats` keys on Epic id (== tabId); only chats
 * whose most recent ticket is 'needs-input' surface. `jobs` is the
 * scheduler snapshot; 'failed' / 'needs_review' / 'quarantined' surface.
 * `now` defaults to Date.now() and only affects a quarantined row's
 * `escalated` flag — pass it explicitly in tests for determinism.
 */
export function buildNeedsYouRows(
  sessions: Record<string, ProposedEpicLite>,
  chats: Record<string, { ticketHistory?: TicketLite[] }>,
  jobs: ScheduleJobLite[],
  now: number = Date.now(),
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
    // Quarantined is deliberately NOT folded into the failed/needs_review
    // branch below: it must never offer Retry (re-running an unstamped PRD
    // is exactly what quarantine exists to prevent) and has its own action
    // — adopt (or archive) from the Scheduler tab.
    if (job.status === 'quarantined') {
      const quarantinedAt = quarantinedAtMs(job)
      const ageMs = quarantinedAt != null ? now - quarantinedAt : null
      const escalated = ageMs != null && ageMs >= QUARANTINE_ESCALATE_MS
      rows.push({
        id: `job:${job.slug}`,
        kind: 'job-quarantined',
        label: escalated ? 'Quarantined PRD — stale, needs adoption' : 'Scheduler PRD quarantined',
        detail: job.title || job.slug,
        meta:
          ageMs != null
            ? `No createdVia provenance for ${Math.round(ageMs / (60 * 60 * 1000))}h — adopt it to run, or archive from the Scheduler tab.`
            : 'No createdVia provenance. Adopt it to run, or archive from the Scheduler tab.',
        project: job.cwd ? projectNameFromCwd(job.cwd) : null,
        epicId: null,
        jobSlug: job.slug,
        escalated,
      })
      continue
    }
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
