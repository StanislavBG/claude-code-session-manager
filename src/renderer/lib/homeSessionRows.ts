// Pure join helpers for the Global Home "Active sessions" + "Recent sessions"
// sections. Kept dependency-free (plain shapes, no store imports) so they are
// unit-testable without mocking zustand — same shape as homeProjectRows.ts.
import { projectNameFromCwd } from './homeProjectRows'

export interface SlotHolderLite {
  owner: string
  at: string
}

export interface ScheduleJobLite {
  slug: string
  cwd: string | null
  sourcePromptId?: string | null
}

export interface ChatSignalLite {
  running: boolean
}

export interface EpicLite {
  cwd: string
  goalText: string
  claudeSessionId?: string
}

export type ActiveSessionKind = 'scheduler job' | 'chat run' | 'session'
export type ActiveSessionOpenTarget = 'scheduler' | 'terminal' | null

export interface ActiveSessionRow {
  owner: string
  kind: ActiveSessionKind
  at: string
  project: string | null
  epicTitle: string | null
  openTarget: ActiveSessionOpenTarget
  epicId: string | null
}

function unresolvedRow(holder: SlotHolderLite): ActiveSessionRow {
  return {
    owner: holder.owner,
    kind: 'session',
    at: holder.at,
    project: null,
    epicTitle: null,
    openTarget: null,
    epicId: null,
  }
}

/**
 * Joins `sessionSlots().holders` against running scheduler jobs (owner
 * `scheduler:<slug>`) and running chat runs (owner `chat:<epicId>`, keyed by
 * Epic id) to produce display rows for the Active sessions section. A holder
 * whose owner matches neither still renders (owner + started-ago only).
 */
export function activeSessionRows(
  holders: SlotHolderLite[],
  jobs: ScheduleJobLite[],
  chats: Record<string, ChatSignalLite>,
  sessions: Record<string, EpicLite>,
): ActiveSessionRow[] {
  return holders.map((holder) => {
    const owner = holder.owner
    if (owner.startsWith('scheduler:')) {
      const slug = owner.slice('scheduler:'.length)
      const job = jobs.find((j) => j.slug === slug)
      if (!job) return unresolvedRow(holder)
      const epicId = job.sourcePromptId ?? null
      const epic = epicId ? sessions[epicId] : undefined
      return {
        owner,
        kind: 'scheduler job',
        at: holder.at,
        project: job.cwd ? projectNameFromCwd(job.cwd) : null,
        epicTitle: epic?.goalText ?? null,
        openTarget: 'scheduler',
        epicId: null,
      }
    }
    if (owner.startsWith('chat:')) {
      const epicId = owner.slice('chat:'.length)
      const chat = chats[epicId]
      const epic = sessions[epicId]
      if (!chat?.running || !epic) return unresolvedRow(holder)
      return {
        owner,
        kind: 'chat run',
        at: holder.at,
        project: projectNameFromCwd(epic.cwd),
        epicTitle: epic.goalText,
        openTarget: 'terminal',
        epicId,
      }
    }
    return unresolvedRow(holder)
  })
}

/**
 * Resolves the Epic title for a Recent-sessions row by matching the
 * transcript's sessionId against every known PromptSession's
 * claudeSessionId — `sessions` must include both active and archived Epics
 * (usePromptSessions merges both into one map once hydrated). Returns null
 * for plain terminal sessions with no matching Epic.
 */
export function recentSessionEpicTitle(
  sessionId: string,
  sessions: Record<string, EpicLite>,
): string | null {
  for (const epicId of Object.keys(sessions)) {
    if (sessions[epicId].claudeSessionId === sessionId) return sessions[epicId].goalText
  }
  return null
}
