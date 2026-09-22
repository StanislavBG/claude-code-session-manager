/**
 * First-run guided tour state.
 *
 * Mirrors the MicWizard pattern: a single boolean `open` plus a small set of
 * actions. The "completed" signal is persisted through `uiChromePrefs`'s
 * `tourCompletedAt` field (disk-backed, see `state/uiChromePrefs.ts`) so it
 * survives across reloads. `hasCompletedTour()` is async because the prefs
 * store hydrates from disk asynchronously — its one call site (App.tsx's
 * first-run effect) is already inside an async IIFE.
 *
 * Complexity: all actions are O(1).
 */

import { create } from 'zustand'
import { useUiChromePrefs } from './uiChromePrefs'

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
    useUiChromePrefs.getState().setTourCompletedAt(Date.now())
    set({ open: false, currentStep: 0 })
  },

  close: () => set({ open: false }),
}))

/** Async check used by App.tsx to gate first-run auto-open — awaits hydration first. */
export async function hasCompletedTour(): Promise<boolean> {
  const prefs = useUiChromePrefs.getState()
  if (!prefs.hydrated) await prefs.hydrate()
  return useUiChromePrefs.getState().tourCompletedAt != null
}

/** Clears the completion flag. Exposed for the command palette / debug. */
export function resetTour(): void {
  useUiChromePrefs.getState().setTourCompletedAt(null)
}
