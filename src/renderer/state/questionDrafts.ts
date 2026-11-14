import { create } from 'zustand'
import type { QuestionResolution } from '../lib/questionReply'

/**
 * In-progress answers for Epic question cards, keyed per card (see
 * `questionCardKey`). The card lets the human resolve questions one at a
 * time and may unmount in between (switching Epics), so typed text, committed
 * resolutions and the "reply sent/queued" status live here instead of in
 * component state — otherwise answers are lost or sent twice.
 *
 * - Stores no turn content: only what the human typed/decided, by question index.
 * - In memory only: never persisted.
 * - An island: never subscribes to or reads another store (root CLAUDE.md).
 *
 * CALLERS: select the raw slice and apply defaults OUTSIDE the selector:
 *
 *   const draft = useQuestionDrafts((s) => s.drafts[key])
 *   const text = draft?.text ?? EMPTY
 *
 * Never write `useQuestionDrafts((s) => s.drafts[key] ?? {})` — a fresh
 * object from a selector re-renders forever (React #185, blank app).
 */
export interface QuestionDraft {
  text: Record<number, string>
  resolved: Record<number, QuestionResolution>
  submitted?: 'sent' | 'queued'
}

interface QuestionDraftsState {
  drafts: Record<string, QuestionDraft>
  setText: (key: string, index: number, text: string) => void
  /** No-op once the draft has been submitted. */
  resolve: (key: string, index: number, resolution: QuestionResolution) => void
  /** Un-commits a resolution; keeps the typed text. No-op once submitted. */
  reopen: (key: string, index: number) => void
  markSubmitted: (key: string, how: 'sent' | 'queued') => void
  clear: (key: string) => void
}

function emptyDraft(): QuestionDraft {
  return { text: {}, resolved: {} }
}

export const useQuestionDrafts = create<QuestionDraftsState>((set) => {
  /** Replace only `drafts[key]`; returning null leaves state untouched. */
  const update = (key: string, fn: (d: QuestionDraft) => QuestionDraft | null) =>
    set((s) => {
      const next = fn(s.drafts[key] ?? emptyDraft())
      return next ? { drafts: { ...s.drafts, [key]: next } } : s
    })

  return {
    drafts: {},
    setText: (key, index, text) =>
      update(key, (d) => ({ ...d, text: { ...d.text, [index]: text } })),
    resolve: (key, index, resolution) =>
      update(key, (d) =>
        d.submitted ? null : { ...d, resolved: { ...d.resolved, [index]: resolution } },
      ),
    reopen: (key, index) =>
      update(key, (d) => {
        if (d.submitted || !(index in d.resolved)) return null
        const resolved = { ...d.resolved }
        delete resolved[index]
        return { ...d, resolved }
      }),
    markSubmitted: (key, how) => update(key, (d) => ({ ...d, submitted: how })),
    clear: (key) =>
      set((s) => {
        if (!(key in s.drafts)) return s
        const drafts = { ...s.drafts }
        delete drafts[key]
        return { drafts }
      }),
  }
})

/**
 * Stable key for one question card. Prefers the transcript byte offset (stable
 * across feed re-parses); falls back to the turn id.
 */
export function questionCardKey(
  tabId: string,
  turn: { id: string; ref?: { byteOffset: number } | null },
): string {
  return turn.ref ? `${tabId}:ref:${turn.ref.byteOffset}` : `${tabId}:id:${turn.id}`
}
