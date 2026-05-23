import { create } from 'zustand'
import type {
  SuperAgentDepth,
  SuperAgentRunState,
  SuperAgentStatus,
} from '../../preload/api'

/**
 * SuperAgent store — per-tab run state. Mirrors main's `superagent.cjs`
 * authoritative map; the renderer keeps a copy so the modal + status bar
 * can render without round-tripping IPC on every paint. Main broadcasts
 * `superagent:state-changed` events keyed by tabId; we reconcile here.
 *
 * Time complexity: O(1) per state mutation (Object.assign over a single key).
 * Memory: bounded by the number of open tabs.
 */

export type { SuperAgentDepth, SuperAgentStatus, SuperAgentRunState }

export interface Specialist {
  /** Name as Claude reports it via `[SUPERAGENT] specialists: a, b, c`. */
  name: string
  /** 'pending' until the matching `progress: <name> done` event arrives. */
  state: 'pending' | 'done'
  at: number
}

export interface SuperAgentTab {
  tabId: string
  /** Mirror of main's RunState. null when no run has ever started on this tab. */
  run: SuperAgentRunState | null
  /** Specialists parsed off transcript text. Renderer-derived — main doesn't
   *  track them. Bounded by the specialistCount the user picked, plus extras
   *  if Claude reports more (we accept them without erroring). */
  specialists: Specialist[]
  /** 0..1 progress, derived from specialists.filter(state === 'done').length /
   *  total. Kept as a stored field so the status bar reads it directly. */
  progress: number
}

interface SuperAgentState {
  tabs: Record<string, SuperAgentTab>

  /** Replace a tab's full run state (called on state-changed broadcast or
   *  immediately after a successful `start`). Resets specialists when the
   *  status flips from idle/done to running. */
  setRun: (tabId: string, run: SuperAgentRunState | null) => void

  /** Merge a single specialist record (start or done). Idempotent — calling
   *  twice with the same (tabId, name, state) is a no-op. */
  recordSpecialist: (tabId: string, name: string, state: Specialist['state']) => void

  /** Forget all state for a tab (e.g. when the tab is closed). */
  clearTab: (tabId: string) => void
}

function recomputeProgress(specialists: Specialist[], expected: number): number {
  if (expected <= 0 && specialists.length === 0) return 0
  const done = specialists.filter((s) => s.state === 'done').length
  // Use max(expected, observed) so reporting more specialists than declared
  // doesn't push progress past 100% — capping at the observed total keeps
  // the bar monotonic and bounded.
  const denom = Math.max(expected, specialists.length, 1)
  return Math.min(1, done / denom)
}

export const useSuperAgent = create<SuperAgentState>((set) => ({
  tabs: {},

  setRun: (tabId, run) =>
    set((state) => {
      const prev = state.tabs[tabId]
      const transitioningToRunning =
        run?.status === 'running' && (!prev?.run || prev.run.status !== 'running')
      const specialists = transitioningToRunning ? [] : prev?.specialists ?? []
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            tabId,
            run,
            specialists,
            progress: recomputeProgress(specialists, run?.specialistCount ?? 0),
          },
        },
      }
    }),

  recordSpecialist: (tabId, name, nextState) =>
    set((state) => {
      const prev = state.tabs[tabId]
      if (!prev || !prev.run) return state
      const existingIdx = prev.specialists.findIndex((s) => s.name === name)
      let specialists: Specialist[]
      if (existingIdx === -1) {
        specialists = [...prev.specialists, { name, state: nextState, at: Date.now() }]
      } else if (prev.specialists[existingIdx].state === nextState) {
        return state
      } else {
        specialists = prev.specialists.slice()
        specialists[existingIdx] = { ...specialists[existingIdx], state: nextState, at: Date.now() }
      }
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...prev,
            specialists,
            progress: recomputeProgress(specialists, prev.run.specialistCount),
          },
        },
      }
    }),

  clearTab: (tabId) =>
    set((state) => {
      if (!state.tabs[tabId]) return state
      const next = { ...state.tabs }
      delete next[tabId]
      return { tabs: next }
    }),
}))

/**
 * Install the global state-changed listener exactly once. Renderer code that
 * needs the store can call `useSuperAgent((s) => …)` directly; this side-
 * effecting install is wired by App.tsx during boot. Idempotent — a second
 * call is a no-op (the returned dispose closes over the single subscription).
 */
let installed = false
let dispose: (() => void) | null = null
export function installSuperAgentListener(): () => void {
  if (installed && dispose) return dispose
  installed = true
  dispose = window.api.superagent.onStateChanged((ev) => {
    useSuperAgent.getState().setRun(ev.tabId, ev.state)
  })
  return dispose
}
