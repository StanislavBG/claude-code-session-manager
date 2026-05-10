import { create } from 'zustand'
import type { PersistedTab } from '../../preload/api'
import { shellQuote, findPreset, renderCommand } from '../lib/presets'

export interface SessionTab {
  id: string
  /** UUID used as --session-id when launching claude; same as tab id by default. */
  claudeSessionId: string
  label: string
  cwd: string
  pid: number | null
  status: 'spawning' | 'running' | 'exited'
  exitCode: number | null
  /** Command written to the shell after PTY spawn. Null = bare shell. */
  startupCommand: string | null
  /** Id of the preset that created this tab, for display/debugging. */
  presetId: string | null
  /** Incremented on restart to force Terminal remount via key change. */
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
}

function labelFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
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
}))

/**
 * Hydrate the store from disk on boot, then wire up autosave. Persists only
 * the durable fields (id, claudeSessionId, cwd, label, presetId) — pid,
 * status, startupCommand, exitCode are runtime-only.
 *
 * On restore, each tab's startupCommand is set to `claude --resume <id>` so
 * the Terminal component re-spawns claude resumed to the same transcript.
 */
export async function hydrateSessions(): Promise<void> {
  if (useSessions.getState().hydrated) return
  try {
    const { tabs: persisted, activeTabId, freshStart } = await window.api.sessions.load()
    if (persisted.length > 0) {
      // For each tab, check whether the JSONL transcript file exists on disk.
      // If it doesn't (e.g. fresh machine, synced tabs.json), fall back to a
      // fresh session instead of --resume which would fail.
      const restored: SessionTab[] = await Promise.all(
        persisted.map(async (p: PersistedTab) => {
          let useResume = !freshStart
          if (useResume) {
            const jsonlPath = await window.api.transcripts.pathFor(p.cwd, p.claudeSessionId)
            const fileExists = await window.api.config.exists(jsonlPath)
            useResume = fileExists
          }
          const claudeSessionId = useResume ? p.claudeSessionId : crypto.randomUUID()
          return {
            id: p.id,
            claudeSessionId,
            cwd: p.cwd,
            label: p.label,
            presetId: p.presetId,
            pid: null,
            status: 'spawning' as const,
            exitCode: null,
            startupCommand: useResume
              ? `claude --dangerously-skip-permissions --resume ${shellQuote(claudeSessionId)}`
              : `claude --dangerously-skip-permissions --session-id ${shellQuote(claudeSessionId)}`,
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
