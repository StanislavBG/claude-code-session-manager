import { create } from 'zustand'

/**
 * Dispatch UI store — the single source of truth for the *shared brief* and the
 * currently-selected topology in the Subagents tab's Launch surface.
 *
 * Why this exists: the four ways to fan work out (Hive, Orchestrate, Race,
 * Boss) used to each own a private prompt/plan box, so switching between them
 * meant re-typing the same brief. This store holds the brief once; every
 * topology form reads it. It survives navigation (it's a module singleton), so
 * a launch can hand off to the Live view without losing the text.
 *
 * It deliberately holds ONLY launch-form input. The running-run state lives in
 * the existing per-topology stores (orchestrator.ts, race.ts, superagent.ts) —
 * this store is cleared/independent of those lifecycles.
 */

export type Topology = 'hive' | 'orchestrate' | 'race' | 'boss'

interface DispatchState {
  /** The shared brief — the one thing the user types, reused by every topology. */
  brief: string
  /** Which fan-out shape the Launch surface is currently configuring. */
  topology: Topology
  setBrief: (s: string) => void
  setTopology: (t: Topology) => void
}

export const useDispatch = create<DispatchState>((set) => ({
  brief: '',
  topology: 'hive',
  setBrief: (brief) => set({ brief }),
  setTopology: (topology) => set({ topology }),
}))
