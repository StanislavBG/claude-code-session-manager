/**
 * epicProvenance — one resolver for "which Epic did this come from", shared by
 * every Scheduler surface (Queue rows, PRDs cards, History rows).
 *
 * Three fields on a job/PRD can point at an Epic, and in live queue.json rows
 * they demonstrably disagree:
 *   - `epicId`        — the PRD's own directory (`scheduler/epics/<id>/prds/`).
 *                       Fact on disk, 1:1 with the Epic by design.
 *   - `sourcePromptId`— frontmatter intent; hand-authorable, can be stale.
 *   - `sourceTabId`   — the chat/tab that queued it; equals the Epic id only
 *                       when the PRD came out of an Epic conversation.
 *
 * Preference order is therefore epicId → sourcePromptId → sourceTabId, and a
 * candidate that actually resolves to a loaded Epic always beats one that
 * doesn't (a stale-but-first id must not shadow a real Epic further down the
 * list). Keeping this in one module is the point: before it, SchedulePanel
 * looked at `sourceTabId` alone while the PRDs/History views showed nothing,
 * so the same PRD could read as three different Epics depending on the tab.
 */
import type { PrdListItem, ScheduleJob } from '../../preload/api'
import type { PromptSession } from '../state/promptSessions'

/** The subset of a job/PRD this module needs — either entity satisfies it. */
export interface EpicLinked {
  epicId?: string | null
  sourcePromptId?: string | null
  sourceTabId?: string | null
}

export interface EpicRef {
  /** Best available Epic id, or null when the row carries no linkage at all. */
  epicId: string | null
  /** The Epic's goalText when it resolved against the loaded store, else null. */
  label: string | null
  /** True when `epicId` matched a loaded Epic (so `label` is real, not an id). */
  known: boolean
}

const UNLINKED: EpicRef = { epicId: null, label: null, known: false }

/** Candidate ids in preference order, deduped, nullish/empty dropped. */
export function epicIdCandidates(row: EpicLinked | null | undefined): string[] {
  if (!row) return []
  const out: string[] = []
  for (const id of [row.epicId, row.sourcePromptId, row.sourceTabId]) {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Resolve a job/PRD to the Epic it originated from.
 *
 * Complexity: O(k) over the (max 3) candidate ids — a plain map lookup each.
 */
export function resolveEpicRef(
  row: EpicLinked | null | undefined,
  sessions: Record<string, PromptSession>,
): EpicRef {
  const candidates = epicIdCandidates(row)
  if (candidates.length === 0) return UNLINKED
  for (const id of candidates) {
    const session = sessions[id]
    if (session) {
      return { epicId: id, label: session.goalText || id, known: true }
    }
  }
  // Linked, but the Epic isn't loaded (archived, or another project's index
  // hasn't been hydrated) — show the id rather than pretending there's no Epic.
  return { epicId: candidates[0], label: null, known: false }
}

/** Short display text for an unresolved Epic id. */
export function shortEpicId(epicId: string): string {
  return epicId.length > 12 ? `${epicId.slice(0, 12)}…` : epicId
}

export type EpicLinkedJob = ScheduleJob & EpicLinked
export type EpicLinkedPrd = PrdListItem & EpicLinked
