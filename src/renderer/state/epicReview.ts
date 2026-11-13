import { create } from 'zustand'
import type { ReviewComment } from '../lib/reviewMessage'

/**
 * Per-Epic diff-review drafts (line comments + overall note) held until sent.
 * Store island: subscribes to no other store, writes nothing to disk — drafts
 * live for the app session only, keyed by epicId so switching tabs or Epics
 * keeps each Epic's drafts.
 */

export type ReviewCommentDraft = Omit<ReviewComment, 'id' | 'createdAt'>

export interface EpicReviewDraft {
  comments: ReviewComment[]
  note: string
}

interface EpicReviewState {
  byEpic: Record<string, EpicReviewDraft>
  addComment: (epicId: string, draft: ReviewCommentDraft) => string
  updateComment: (epicId: string, id: string, body: string) => void
  removeComment: (epicId: string, id: string) => void
  setNote: (epicId: string, note: string) => void
  clear: (epicId: string) => void
}

// Module-level stable fallbacks — selectors must never mint a fresh value (React #185).
const EMPTY_COMMENTS: readonly ReviewComment[] = Object.freeze([])
const EMPTY_NOTE = ''

let counter = 0
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  counter += 1
  return `review-${Date.now().toString(36)}-${counter}`
}

function draftOf(byEpic: Record<string, EpicReviewDraft>, epicId: string): EpicReviewDraft {
  return byEpic[epicId] ?? { comments: [], note: EMPTY_NOTE }
}

export const useEpicReview = create<EpicReviewState>((set) => ({
  byEpic: {},
  addComment: (epicId, draft) => {
    const id = newId()
    const comment: ReviewComment = { ...draft, id, createdAt: Date.now() }
    set((s) => {
      const cur = draftOf(s.byEpic, epicId)
      return { byEpic: { ...s.byEpic, [epicId]: { ...cur, comments: [...cur.comments, comment] } } }
    })
    return id
  },
  updateComment: (epicId, id, body) =>
    set((s) => {
      const cur = s.byEpic[epicId]
      if (!cur || !cur.comments.some((c) => c.id === id)) return s
      const comments = cur.comments.map((c) => (c.id === id ? { ...c, body } : c))
      return { byEpic: { ...s.byEpic, [epicId]: { ...cur, comments } } }
    }),
  removeComment: (epicId, id) =>
    set((s) => {
      const cur = s.byEpic[epicId]
      if (!cur || !cur.comments.some((c) => c.id === id)) return s
      const comments = cur.comments.filter((c) => c.id !== id)
      return { byEpic: { ...s.byEpic, [epicId]: { ...cur, comments } } }
    }),
  setNote: (epicId, note) =>
    set((s) => {
      const cur = draftOf(s.byEpic, epicId)
      if (cur.note === note && s.byEpic[epicId]) return s
      return { byEpic: { ...s.byEpic, [epicId]: { ...cur, note } } }
    }),
  clear: (epicId) =>
    set((s) => {
      if (!(epicId in s.byEpic)) return s
      const next = { ...s.byEpic }
      delete next[epicId]
      return { byEpic: next }
    }),
}))

/** Stored comments for an Epic, or the frozen EMPTY_COMMENTS constant. */
export const selectEpicComments =
  (epicId: string) =>
  (s: EpicReviewState): readonly ReviewComment[] =>
    s.byEpic[epicId]?.comments ?? EMPTY_COMMENTS

/** Stored note for an Epic, or ''. */
export const selectEpicNote =
  (epicId: string) =>
  (s: EpicReviewState): string =>
    s.byEpic[epicId]?.note ?? EMPTY_NOTE
