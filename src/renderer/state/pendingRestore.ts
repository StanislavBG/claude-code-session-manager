import { create } from 'zustand'
import type { RestorableSession } from '../../preload/api'

/**
 * A session the import flow chose to restore, waiting for its project's New
 * Session card. The card takes it once (only for its own cwd) and pre-selects
 * it; the human still creates the Epic by pressing the button (single-creator law).
 */
export type PendingRestorePick = { cwd: string; session: RestorableSession }

interface PendingRestoreState {
  pick: PendingRestorePick | null
  set: (pick: PendingRestorePick | null) => void
  /** Returns and clears the pick only when it was made for `cwd`; otherwise null and the pick stays. */
  take: (cwd: string) => PendingRestorePick | null
}

export const usePendingRestore = create<PendingRestoreState>((set, get) => ({
  pick: null,
  set: (pick) => set({ pick }),
  take: (cwd) => {
    const pick = get().pick
    if (!pick || !cwd || pick.cwd !== cwd) return null
    set({ pick: null })
    return pick
  },
}))
