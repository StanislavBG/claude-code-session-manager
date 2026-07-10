import { create } from 'zustand'
import type { PersistedTab } from '../../preload/api'
import { shellQuote, findPreset, renderCommand } from '../lib/presets'
import { getRawSessionModel, type RawModel } from '../lib/rawSessionModel'
import { transcriptExists } from '../lib/transcriptExists'

export interface SessionTab {
  id: string
  /** UUID used as --session-id when launching claude; same as tab id by default. */
  claudeSessionId: string
  /**
   * UUID chat mode uses as its own --session-id, separate from
   * claudeSessionId. Chat and the raw ("Open raw session") PTY must never
   * share an id: the raw session holds a live process lock on its
   * claudeSessionId, and reusing it for chat's `claude -p --session-id`
   * produced the "Session ID <uuid> is already in use" create-collision
   * (chat.ts's first send after reload, or once the raw session's
   * transcript already exists on disk).
   */
  chatSessionId: string
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
  /** Mint a fresh chatSessionId for the tab, starting a brand-new chat thread. */
  newChatThread: (id: string) => void
}

function labelFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

/**
 * Resolves whether a tab should resume an existing transcript or start fresh,
 * returning the definitive claudeSessionId and the startup command string.
 *
 * When freshStart=true (first-ever boot or sync'd tabs.json on a new machine):
 *   all tabs skip the resume check and get a new UUID assigned.
 * When freshStart=false (normal case, including wakeTab calls):
 *   checks if the JSONL transcript exists; resumes if it does, starts fresh
 *   with the same claudeSessionId otherwise (no new UUID generated — the id
 *   is already definitive from hydration).
 */
async function resolveStartupCommand(
  p: { cwd: string; claudeSessionId: string },
  freshStart = false,
  model: RawModel = getRawSessionModel(),
): Promise<{ claudeSessionId: string; startupCommand: string }> {
  let useResume = !freshStart
  if (useResume) {
    useResume = await transcriptExists(p.cwd, p.claudeSessionId)
  }
  // Only generate a new UUID on a fresh-start with no JSONL; otherwise the
  // existing claudeSessionId is already authoritative (avoids UUID churn on
  // repeated wakeTab calls for tabs that never had a transcript).
  const claudeSessionId = freshStart && !useResume ? crypto.randomUUID() : p.claudeSessionId
  const startupCommand = useResume
    ? `claude --dangerously-skip-permissions --resume ${shellQuote(claudeSessionId)} --model ${model}`
    : `claude --dangerously-skip-permissions --session-id ${shellQuote(claudeSessionId)} --model ${model}`
  return { claudeSessionId, startupCommand }
}

export const useSessions = create<SessionsState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  hydrated: false,
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
      claudeSessionId: id,
      chatSessionId: crypto.randomUUID(),
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
                claudeSessionId: newSessionId,
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
    const { claudeSessionId, startupCommand } = await resolveStartupCommand(
      { cwd: tab.cwd, claudeSessionId: tab.claudeSessionId },
      false,
      modelOverride ?? getRawSessionModel(),
    )
    set({
      tabs: get().tabs.map((t) =>
        t.id === id
          ? { ...t, claudeSessionId, status: 'spawning' as const, startupCommand, generation: t.generation + 1 }
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
  newChatThread: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, chatSessionId: crypto.randomUUID() } : t)),
    })
  },
}))

/**
 * Hydrate the store from disk on boot, then wire up autosave. Persists only
 * the durable fields (id, claudeSessionId, cwd, label, presetId) — pid,
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
      // Resolve the definitive claudeSessionId for each tab (resume vs fresh-UUID).
      // startupCommand is NOT set here — that happens in wakeTab when the user
      // activates the session.
      const restored: SessionTab[] = await Promise.all(
        persisted.map(async (p: PersistedTab) => {
          const { claudeSessionId } = await resolveStartupCommand(p, freshStart)
          return {
            id: p.id,
            claudeSessionId,
            // Backwards-compat: older persisted tabs predate chatSessionId.
            // Mint a fresh one rather than reusing claudeSessionId, which
            // would reintroduce the raw/chat session-lock collision.
            chatSessionId: p.chatSessionId ?? crypto.randomUUID(),
            cwd: p.cwd,
            label: p.label,
            presetId: p.presetId,
            pid: null,
            status: 'dormant' as const,
            exitCode: null,
            startupCommand: null,
            generation: 0,
          }
        }),
      )
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
      claudeSessionId: t.claudeSessionId,
      chatSessionId: t.chatSessionId,
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
