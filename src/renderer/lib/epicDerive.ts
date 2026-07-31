import type { PromptSession } from '../state/promptSessions'
import type { TabChat, ChatTurn } from '../state/chat'
import type { ScheduleJob, PrdListItem } from '../../preload/api'

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
}

export type EpicDisplayStatus = 'running' | 'needs' | 'queued' | 'completed' | 'draft'

/**
 * Derived Epic-level status per the design spec's status vocabulary. Order
 * matters: completed (archived) and needs-you (a stalled question) both take
 * priority over an in-flight run/queue position, since those are the states
 * that most need surfacing to the user.
 */
export function epicDisplayStatus(epicId: string, snapshots: EpicSnapshots): EpicDisplayStatus {
  const session = snapshots.sessions[epicId]
  if (session?.status === 'completed') return 'completed'

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

  return 'draft'
}

export interface EpicPrd {
  slug: string
  title: string
  cwd: string
  mtimeMs: number
  estimateMinutes: number | null
  parallelGroup: number
  /** The joined job's status, or 'draft' when no scheduler job row exists yet for this PRD. */
  status: ScheduleJob['status'] | 'draft'
  job: ScheduleJob | null
}

/**
 * Joins `window.api.schedule.listPrds()` file entries with schedule jobs on
 * `sourcePromptId === epicId` — the PRDs + Runs tabs' data source. A PRD
 * file with no matching job row (not yet accepted into the queue) reports
 * status 'draft'.
 */
export function epicPrds(epicId: string, snapshots: EpicSnapshots): EpicPrd[] {
  const jobsBySlug = new Map(snapshots.jobs.filter((j) => j.sourcePromptId === epicId).map((j) => [j.slug, j]))
  return snapshots.prds
    .filter((p) => p.sourcePromptId === epicId)
    .map((p) => {
      const job = jobsBySlug.get(p.slug) ?? null
      return {
        slug: p.slug,
        title: p.title,
        cwd: p.cwd,
        mtimeMs: p.mtimeMs,
        estimateMinutes: p.estimateMinutes,
        parallelGroup: p.parallelGroup,
        status: job?.status ?? 'draft',
        job,
      }
    })
}

export interface EpicStats {
  turns: number
  toolCalls: number
}

/**
 * `{ turns, toolCalls }` derived from useChat's turns for this Epic's chat
 * key — null when that chat hasn't been hydrated yet (never "0, 0", which
 * would misleadingly read as "no activity" rather than "not loaded").
 */
export function epicStats(epicId: string, snapshots: EpicSnapshots): EpicStats | null {
  const chat = snapshots.chats[epicId]
  if (!chat) return null
  const turns: ChatTurn[] = chat.turns
  const toolCalls = turns.reduce((sum, t) => sum + (t.toolUses?.length ?? 0), 0)
  return { turns: turns.length, toolCalls }
}
