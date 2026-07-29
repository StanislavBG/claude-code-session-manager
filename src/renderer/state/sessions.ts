import { create } from 'zustand'
import type { PersistedTab } from '../../preload/api'
import { shellQuote, findPreset, renderCommand } from '../lib/presets'
import { getRawSessionModel, type RawModel } from '../lib/rawSessionModel'
import { transcriptExists } from '../lib/transcriptExists'
import { useChat } from './chat'
import { toast } from './toast'

export interface SessionTab {
  id: string
  /**
   * UUID used as --session-id when launching claude, by both Chat mode
   * (headless `claude -p --session-id/--resume`) and the raw pty (`claude
   * --session-id/--resume`). Same tab id by default. Toggling between Chat
   * and Raw is purely a presentation choice — both resume the same
   * underlying claude session/transcript.
   */
  sessionId: string
  label: string
  cwd: string
  pid: number | null
  status: 'dormant' | 'spawning' | 'running' | 'exited'
  exitCode: number | null
  /** Command written to the shell after PTY spawn. Null = bare shell or dormant. */
  startupCommand: string | null
  /** Id of the preset that created this tab, for display/debugging. */
  presetId: string | null
  /** Incremented on restart/wake to force Terminal remount via key change. */
  generation: number
}

interface SessionsState {
  tabs: SessionTab[]
  activeTabId: string | null
  hydrated: boolean
  addTab: (opts: {
    id?: string
    cwd: string
    startupCommand: string | null
    presetId?: string | null
    label?: string
  }) => string
  setTabRunning: (id: string, pid: number) => void
  setTabExited: (id: string, exitCode: number) => void
  closeTab: (id: string) => void
  setActive: (id: string) => void
  restartTab: (id: string) => void
  reorderTab: (fromIndex: number, toIndex: number) => void
  restoreTabs: (tabs: SessionTab[], activeTabId: string | null) => void
  /** Transition a dormant tab to spawning, resolving the startup command. */
  wakeTab: (id: string, modelOverride?: RawModel) => Promise<void>
  /** Kill the running PTY and return a tab to dormant/chat mode, preserving the tab row. */
  sleepTab: (id: string) => void
  /** Mint a fresh sessionId for the tab, starting a brand-new session. */
  newSession: (id: string) => void
  /** One-shot command typed into a tab's PTY once it's next confirmed spawned/ready. */
  pendingRawCommand: Record<string, string>
  /** Queue a command to auto-type once this tab's raw PTY is ready (e.g. wakeTab + a slash command). */
  queueRawCommand: (id: string, command: string) => void
  /** Consumes (reads + clears) the pending command for a tab, or null if none queued. */
  consumeRawCommand: (id: string) => string | null
}

function labelFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

/**
 * Resolves whether a tab should resume an existing transcript or start fresh,
 * returning the definitive sessionId and the startup command string.
 *
 * When freshStart=true (first-ever boot or sync'd tabs.json on a new machine):
 *   all tabs skip the resume check and get a new UUID assigned.
 * When freshStart=false (normal case, including wakeTab calls):
 *   checks if the JSONL transcript exists; resumes if it does, starts fresh
 *   with the same sessionId otherwise (no new UUID generated — the id
 *   is already definitive from hydration).
 */
async function resolveStartupCommand(
  p: { cwd: string; sessionId: string },
  freshStart = false,
  model: RawModel = getRawSessionModel(),
): Promise<{ sessionId: string; startupCommand: string }> {
  let useResume = !freshStart
  if (useResume) {
    useResume = await transcriptExists(p.cwd, p.sessionId)
  }
  // Only generate a new UUID on a fresh-start with no JSONL; otherwise the
  // existing sessionId is already authoritative (avoids UUID churn on
  // repeated wakeTab calls for tabs that never had a transcript).
  const sessionId = freshStart && !useResume ? crypto.randomUUID() : p.sessionId
  const startupCommand = useResume
    ? `claude --dangerously-skip-permissions --resume ${shellQuote(sessionId)} --model ${model}`
    : `claude --dangerously-skip-permissions --session-id ${shellQuote(sessionId)} --model ${model}`
  return { sessionId, startupCommand }
}

export const useSessions = create<SessionsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  hydrated: false,
  pendingRawCommand: {},
  queueRawCommand: (id, command) => {
    set((s) => ({ pendingRawCommand: { ...s.pendingRawCommand, [id]: command } }))
  },
  consumeRawCommand: (id) => {
    const cmd = get().pendingRawCommand[id]
    if (cmd === undefined) return null
    set((s) => {
      const next = { ...s.pendingRawCommand }
      delete next[id]
      return { pendingRawCommand: next }
    })
    return cmd
  },
  addTab: ({ id: providedId, cwd, startupCommand, presetId = null, label }) => {
    const id = providedId ?? crypto.randomUUID()
    // Guard against double-add: callers occasionally retry (HMR remounts, race
    // between auto-spawn + user click). Returning the existing id keeps the
    // caller's flow intact instead of colliding on tab keys + PTY spawns.
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return id
    }
    const tab: SessionTab = {
      id,
      sessionId: id,
      label: label ?? labelFromCwd(cwd),
      cwd,
      pid: null,
      status: 'spawning',
      exitCode: null,
      startupCommand,
      presetId,
      generation: 0,
    }
    set({ tabs: [...get().tabs, tab], activeTabId: id })
    return id
  },
  setTabRunning: (id, pid) =>
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, pid, status: 'running' } : t)),
    }),
  setTabExited: (id, exitCode) =>
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, status: 'exited', exitCode } : t)),
    }),
  closeTab: (id) => {
    window.api.pty.kill(id)
    window.api.watchers.killTab(id).catch(() => {})
    window.api.transcripts.closeTab(id).catch(() => {})
    const remaining = get().tabs.filter((t) => t.id !== id)
    const activeTabId =
      get().activeTabId === id ? (remaining[remaining.length - 1]?.id ?? null) : get().activeTabId
    set({ tabs: remaining, activeTabId })
  },
  setActive: (id) => set({ activeTabId: id }),
  restartTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    window.api.pty.kill(id)
    const newSessionId = crypto.randomUUID()

    // Resolve command from preset if available, else fall back to default
    const applyRestart = (cmd: string | null) => {
      set({
        tabs: get().tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                sessionId: newSessionId,
                pid: null,
                status: 'spawning' as const,
                exitCode: null,
                startupCommand: cmd,
                generation: t.generation + 1,
              }
            : t,
        ),
      })
    }

    if (tab.presetId) {
      findPreset(tab.presetId).then((preset) => {
        if (preset) {
          applyRestart(renderCommand(preset, { sessionId: newSessionId, cwd: tab.cwd }))
        } else {
          applyRestart(`claude --dangerously-skip-permissions --session-id ${shellQuote(newSessionId)}`)
        }
      })
    } else {
      applyRestart(`claude --dangerously-skip-permissions --session-id ${shellQuote(newSessionId)}`)
    }
  },
  reorderTab: (fromIndex, toIndex) => {
    const tabs = [...get().tabs]
    if (fromIndex < 0 || fromIndex >= tabs.length) return
    if (toIndex < 0 || toIndex >= tabs.length) return
    if (fromIndex === toIndex) return
    const [moved] = tabs.splice(fromIndex, 1)
    tabs.splice(toIndex, 0, moved)
    set({ tabs })
  },
  restoreTabs: (tabs, activeTabId) => set({ tabs, activeTabId, hydrated: true }),
  wakeTab: async (id, modelOverride) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.status !== 'dormant') return
    // PRD 718: opening a raw session while a headless chat run is still writing
    // to the same --resume sessionId would spawn a second live `claude
    // --resume` process against the same transcript. Cancel and wait for full
    // teardown first.
    if (useChat.getState().chats[id]?.running) {
      await window.api.chat.cancel(id)
      toast.info('Cancelled the in-progress chat run to open a live session.')
    }
    const { sessionId, startupCommand } = await resolveStartupCommand(
      { cwd: tab.cwd, sessionId: tab.sessionId },
      false,
      modelOverride ?? getRawSessionModel(),
    )
    set({
      tabs: get().tabs.map((t) =>
        t.id === id
          ? { ...t, sessionId, status: 'spawning' as const, startupCommand, generation: t.generation + 1 }
          : t
      ),
    })
  },
  sleepTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.status === 'dormant') return
    window.api.pty.kill(id)
    set({
      tabs: get().tabs.map((t) =>
        t.id === id ? { ...t, pid: null, status: 'dormant' as const } : t
      ),
    })
  },
  newSession: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, sessionId: crypto.randomUUID() } : t)),
    })
  },
}))

/**
 * Hydrate the store from disk on boot, then wire up autosave. Persists only
 * the durable fields (id, sessionId, cwd, label, presetId) — pid,
 * status, startupCommand, exitCode are runtime-only.
 *
 * Restored tabs hydrate in a dormant state (no PTY, no claude process). The
 * caller must invoke wakeTab(id) to transition a tab to spawning when the user
 * explicitly activates it. This prevents N idle claude processes on boot.
 */
export async function hydrateSessions(): Promise<void> {
  if (useSessions.getState().hydrated) return
  try {
    const { tabs: persisted, activeTabId, freshStart } = await window.api.sessions.load()
    if (persisted.length > 0) {
      // Resolve the definitive sessionId for each tab (resume vs fresh-UUID).
      // startupCommand is NOT set here — that happens in wakeTab when the user
      // activates the session.
      // Isolate each tab's resolution: one malformed persisted row (e.g. a
      // stale pre-unification entry) must not throw away every other tab.
      const settled = await Promise.all(
        persisted.map(async (p: PersistedTab): Promise<SessionTab | null> => {
          try {
            const { sessionId } = await resolveStartupCommand(p, freshStart)
            return {
              id: p.id,
              sessionId,
              cwd: p.cwd,
              label: p.label,
              presetId: p.presetId,
              pid: null,
              status: 'dormant' as const,
              exitCode: null,
              startupCommand: null,
              generation: 0,
            }
          } catch (e) {
            console.warn('[sessions] dropping malformed persisted tab:', p?.id, e)
            return null
          }
        }),
      )
      const restored: SessionTab[] = settled.filter((t): t is SessionTab => t !== null)
      const active = activeTabId && restored.find((t) => t.id === activeTabId)
        ? activeTabId
        : restored[0]?.id ?? null
      useSessions.getState().restoreTabs(restored, active)
    } else {
      useSessions.setState({ hydrated: true })
    }
  } catch (e) {
    console.warn('[sessions] hydrate failed:', e)
    useSessions.setState({ hydrated: true })
  }

  // Autosave on any change to tabs/activeTabId. Debounced so bursts of
  // updates collapse to one write.
  const flushSave = () => {
    const { tabs, activeTabId } = useSessions.getState()
    const persisted: PersistedTab[] = tabs.map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      cwd: t.cwd,
      label: t.label,
      presetId: t.presetId,
    }))
    window.api.sessions.save({ tabs: persisted, activeTabId }).catch((e) => {
      console.warn('[sessions] save failed:', e)
    })
  }
  let saveTimer: number | null = null
  useSessions.subscribe((state, prev) => {
    if (!state.hydrated) return
    if (state.tabs === prev.tabs && state.activeTabId === prev.activeTabId) return
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(flushSave, 200)
  })
  // Initial flush: capture whatever's in memory right now (either restored
  // from disk, or tabs the app just auto-spawned). Ensures the first boot
  // with fresh tabs still writes tabs.json so the NEXT restart can restore.
  flushSave()
}
