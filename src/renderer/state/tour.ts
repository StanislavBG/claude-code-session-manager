/**
 * First-run guided tour state.
 *
 * Mirrors the MicWizard pattern: a single boolean `open` plus a small set of
 * actions. The "completed" signal is persisted as a localStorage timestamp
 * `sm.tour.completedAt` so it survives across reloads and the renderer can
 * gate auto-open with a synchronous read (no async hydrate dance).
 *
 * Why localStorage (vs. a JSON file on disk like wizard state): the tour is
 * purely a UI nudge — losing the flag means re-showing it once, which is
 * harmless. The async file path used by the mic wizard exists because it
 * mirrors a versioned schema; the tour has no such structure.
 *
 * Complexity: all actions are O(1).
 */

import { create } from 'zustand'

export const TOUR_STORAGE_KEY = 'sm.tour.completedAt'

interface TourState {
  /** Modal-style overlay visibility. */
  open: boolean
  /** Zero-based index into TOUR_STEPS. */
  currentStep: number
  /** Total step count, exposed so consumers don't import TOUR_STEPS. */
  stepCount: number
  setStepCount: (n: number) => void
  start: () => void
  next: () => void
  prev: () => void
  goTo: (i: number) => void
  /** Closes the overlay AND persists completion. Use for "Skip" / "Got it". */
  complete: () => void
  /** Closes without persisting (used for nothing right now; reserved). */
  close: () => void
}

export const useTour = create<TourState>((set, get) => ({
  open: false,
  currentStep: 0,
  stepCount: 0,

  setStepCount: (n) => {
    if (get().stepCount === n) return
    set({ stepCount: n })
  },

  start: () => set({ open: true, currentStep: 0 }),

  next: () => {
    const { currentStep, stepCount } = get()
    if (currentStep >= stepCount - 1) {
      // Past the last step — treat as complete.
      get().complete()
      return
    }
    set({ currentStep: currentStep + 1 })
  },

  prev: () => {
    const { currentStep } = get()
    if (currentStep <= 0) return
    set({ currentStep: currentStep - 1 })
  },

  goTo: (i) => {
    const { stepCount } = get()
    if (i < 0 || i >= stepCount) return
    set({ currentStep: i })
  },

  complete: () => {
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, String(Date.now()))
    } catch {
      /* private mode, quota, etc. — the worst case is we show the tour again. */
    }
    set({ open: false, currentStep: 0 })
  },

  close: () => set({ open: false }),
}))

/** Synchronous check used by App.tsx to gate first-run auto-open. */
export function hasCompletedTour(): boolean {
  try {
    return Boolean(localStorage.getItem(TOUR_STORAGE_KEY))
  } catch {
    return false
  }
}

/** Clears the completion flag. Exposed for the command palette / debug. */
export function resetTour(): void {
  try { localStorage.removeItem(TOUR_STORAGE_KEY) } catch { /* */ }
}
