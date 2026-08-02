import type { PromptSession } from '../state/promptSessions'
import type { TabChat, ChatTurn } from '../state/chat'
import type { ScheduleJob, PrdListItem } from '../../preload/api'
import type { EpicUsage } from '../state/epicUsage'
import { formatCompactCount } from './formatCompactCount'

/**
 * Already-selected store snapshots the Epics workspace joins across —
 * plain data, never a zustand selector itself (selectors that build fresh
 * arrays/objects trip the useSyncExternalStore reference-equality trap; see
 * CLAUDE.md's "Avoid" section). Callers select these slices from
 * usePromptSessions/useChat/useScheduleState once and pass them in.
 */
export interface EpicSnapshots {
  sessions: Record<string, PromptSession>
  /** Keyed by Epic id — useChat's `chats` uses the PromptSession id as its tabId/chat key. */
  chats: Record<string, TabChat>
  jobs: ScheduleJob[]
  prds: PrdListItem[]
  /** Keyed by Epic id — batched from `transcripts:usageFor`, see epicUsage.ts.
   *  Optional: older callers that haven't wired the fetch yet just omit tokens. */
  usage?: Record<string, EpicUsage>
}

export type EpicDisplayStatus = 'running' | 'needs' | 'queued' | 'completed' | 'proposed' | 'active'

/**
 * Derived Epic-level status per the design spec's status vocabulary. Order
 * matters: completed (archived) and needs-you (a stalled question) both take
 * priority over an in-flight run/queue position, since those are the states
 * that most need surfacing to the user.
 */
export function epicDisplayStatus(epicId: string, snapshots: EpicSnapshots): EpicDisplayStatus {
  const session = snapshots.sessions[epicId]
  if (session?.status === 'completed') return 'completed'
  // A proposal has spent nothing and started nothing — it outranks every
  // in-flight signal below because the only meaningful action on it is
  // approve-or-discard.
  if (session?.status === 'proposed') return 'proposed'

  const chat = snapshots.chats[epicId]
  const hasPendingNeedsInput = (chat?.ticketHistory ?? []).some((t) => t.status === 'needs-input')
  if (hasPendingNeedsInput) return 'needs'

  const epicJobs = snapshots.jobs.filter((j) => j.sourcePromptId === epicId)
  const chatQueuedPosition = chat?.queuedPosition ?? 0
  const chatRunning = chat?.running === true && chatQueuedPosition === 0
  const jobRunning = epicJobs.some((j) => j.status === 'running')
  if (chatRunning || jobRunning) return 'running'

  const chatQueued = chat?.running === true && chatQueuedPosition > 0
  const jobQueued = epicJobs.some((j) => j.status === 'pending')
  if (chatQueued || jobQueued) return 'queued'

  // Nothing in flight. The Epic's REAL state is what shows — it is 'active'
  // (started, session alive, just idle right now), never a state that does not
  // exist. This used to return 'draft', a label for a nonexistent Epic state,
  // displayed in place of the true one. `running`/`queued`/`needs` above are
  // SESSION activity shown on the Epic's row, not Epic state; only these last
  // two lines and the completed/proposed checks report actual status.
  // See prompt-sessions/README.md#lifecycle.
  return 'active'
}

/**
 * Human-readable detail for a 'queued' Epic — distinguishes "the chat run is
 * literally waiting on the machine-wide session-slot pool" (chatRunner.cjs's
 * chat:run:queued position) from "a PRD is queued behind the scheduler" so a
 * hover/hidden-when-idle tooltip can say something more specific than the
 * bare 'queued' chip label. Returns undefined for any other status (or when
 * no queue signal is currently present).
 */
export function epicQueuedDetail(epicId: string, snapshots: EpicSnapshots): string | undefined {
  const chat = snapshots.chats[epicId]
  const chatQueuedPosition = chat?.queuedPosition ?? 0
  if (chat?.running === true && chatQueuedPosition > 0) {
    return `queued — waiting on a session slot (position ${chatQueuedPosition})`
  }
  const epicJobs = snapshots.jobs.filter((j) => j.sourcePromptId === epicId)
  if (epicJobs.some((j) => j.status === 'pending')) {
    return 'queued — waiting for the scheduler'
  }
  return undefined
}

export interface EpicPrd {
  slug: string
  title: string
  cwd: string
  mtimeMs: number
  estimateMinutes: number | null
  parallelGroup: number
  /** The joined job's status; 'draft' when no scheduler job row exists yet
   *  AND this PRD isn't archived; the archived PRD's resolved outcome
   *  ('completed'/'failed') when it is — a completed PRD's job row can age
   *  out of queue.json into history.jsonl, so a missing job row does NOT
   *  mean "never ran" once `archived` is true. */
  status: ScheduleJob['status'] | 'draft'
  /** True when this PRD's source .md now lives in `prds-archived/` — its
   *  job already ran to completion (or failure) and the file was moved out
   *  of the live `prds/` dir. See PrdListItem.archived. */
  archived: boolean
  job: ScheduleJob | null
}

/**
 * Joins `window.api.schedule.listPrds()` file entries with schedule jobs on
 * `sourcePromptId === epicId` — the PRDs + Runs tabs' data source. A PRD
 * file with no matching job row reports status 'draft' UNLESS it's archived,
 * in which case the file's own `archivedStatus` (completed/failed) stands in
 * for the missing/aged-out job row — an Epic's real historical PRD count
 * must include these, not just its currently-pending ones.
 */
export function epicPrds(epicId: string, snapshots: EpicSnapshots): EpicPrd[] {
  const jobsBySlug = new Map(snapshots.jobs.filter((j) => j.sourcePromptId === epicId).map((j) => [j.slug, j]))
  return snapshots.prds
    .filter((p) => p.sourcePromptId === epicId)
    .map((p) => {
      const job = jobsBySlug.get(p.slug) ?? null
      const archived = p.archived === true
      const status = job?.status ?? (archived ? (p.archivedStatus ?? 'completed') : 'draft')
      return {
        slug: p.slug,
        title: p.title,
        cwd: p.cwd,
        mtimeMs: p.mtimeMs,
        estimateMinutes: p.estimateMinutes,
        parallelGroup: p.parallelGroup,
        status,
        archived,
        job,
      }
    })
}

export interface EpicStats {
  turns: number
  toolCalls: number
  /** Formatted k/M token total (e.g. "1.2M"), or null when no usage has been
   *  fetched yet for this Epic — callers omit the metric rather than show 0. */
  tokens: string | null
}

/**
 * `{ turns, toolCalls, tokens }` derived from useChat's turns + the batched
 * epicUsage store for this Epic's key — null when the chat hasn't been
 * hydrated yet (never "0, 0", which would misleadingly read as "no activity"
 * rather than "not loaded").
 */
export function epicStats(epicId: string, snapshots: EpicSnapshots): EpicStats | null {
  const chat = snapshots.chats[epicId]
  if (!chat) return null
  const turns: ChatTurn[] = chat.turns
  const toolCalls = turns.reduce((sum, t) => sum + (t.toolUses?.length ?? 0), 0)
  const usage = snapshots.usage?.[epicId]
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0
  const tokens = totalTokens > 0 ? formatCompactCount(totalTokens) : null
  return { turns: turns.length, toolCalls, tokens }
}
