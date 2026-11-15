import type { PromptSession } from '../state/promptSessions'
import { epicPrds, type EpicSnapshots } from './epicDerive'

/** The built-in macro whose presses are listed as review runs. */
export const REVIEW_MD_NETWORK_MACRO_ID = 'builtin-review-md-network'

/** A review run's derived status label. */
export type ReviewRunStatus =
  | 'proposed'
  | 'reporting'
  | 'reported'
  | `PRDs queued ${number}/${number} done`
  | 'validated'
  | 'refuted'
  | 'completed'

/** This project's Review MD network Epics (`source.macroId`), newest `createdAt` first. */
export function reviewRuns(sessions: Record<string, PromptSession>, cwd: string | null | undefined): PromptSession[] {
  if (!cwd) return []
  return Object.values(sessions)
    .filter((s) => s.cwd === cwd && s.source?.macroId === REVIEW_MD_NETWORK_MACRO_ID)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/**
 * One review run's status, highest first: `proposed` (not started) → `refuted` (a response event
 * whose validation is 'refuted') → `validated` (validation record files exist) → `completed`
 * (archived Epic) → `PRDs queued n/m done` (the run queued follow-up PRDs; n = completed) →
 * `reporting` (chat running, no PRDs) → `reported` (idle, no PRDs). `validationPaths` are this
 * Epic's validation record paths from the mdReview read.
 */
export function reviewRunStatus(
  epicId: string,
  snapshots: EpicSnapshots,
  validationPaths: readonly string[] | undefined,
): ReviewRunStatus {
  const session = snapshots.sessions[epicId]
  if (session?.status === 'proposed') return 'proposed'
  const events = snapshots.events?.[epicId] ?? []
  if (events.some((e) => e.kind === 'response' && e.validation === 'refuted')) return 'refuted'
  if ((validationPaths?.length ?? 0) > 0) return 'validated'
  if (session?.status === 'completed') return 'completed'
  const prds = epicPrds(epicId, snapshots)
  if (prds.length > 0) {
    const done = prds.filter((p) => p.status === 'completed').length
    return `PRDs queued ${done}/${prds.length} done`
  }
  if (snapshots.chats[epicId]?.running === true) return 'reporting'
  return 'reported'
}
