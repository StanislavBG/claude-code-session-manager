import { create } from 'zustand'

/**
 * Pending high-effort macro cost prompt. A macro launch awaits `ask(req)` for the
 * human's choice: cancel, run at the agent's effort (`effort: null`), or run at a
 * lower effort. The dialog host calls `setHostMounted(true)` while it is mounted;
 * with no host, `ask` falls back to window.confirm so a launch never hangs.
 * One request at a time — a second ask while one is open is cancelled at once.
 */

export type MacroCostRequest = {
  cwd: string
  macroLabel: string
  agentName: string
  model: string | null
  effort: string
  message: string
}

export type MacroCostChoice = { proceed: false } | { proceed: true; effort: string | null }

interface MacroCostPromptState {
  request: MacroCostRequest | null
  hostMounted: boolean
  setHostMounted: (mounted: boolean) => void
  ask: (req: MacroCostRequest) => Promise<MacroCostChoice>
  answer: (choice: MacroCostChoice) => void
}

// Resolver for the open request — outside the store so it never re-renders anything.
let pending: ((c: MacroCostChoice) => void) | null = null

export const useMacroCostPrompt = create<MacroCostPromptState>((set, get) => ({
  request: null,
  hostMounted: false,
  setHostMounted: (mounted) => {
    set({ hostMounted: mounted })
    if (!mounted && get().request) get().answer({ proceed: false })
  },
  ask: (req) => {
    if (!get().hostMounted) {
      return Promise.resolve<MacroCostChoice>(
        window.confirm(`${req.message} Continue?`) ? { proceed: true, effort: null } : { proceed: false },
      )
    }
    if (get().request) return Promise.resolve<MacroCostChoice>({ proceed: false })
    set({ request: req })
    return new Promise<MacroCostChoice>((resolve) => {
      pending = resolve
    })
  },
  answer: (choice) => {
    const r = pending
    pending = null
    set({ request: null })
    r?.(choice)
  },
}))
