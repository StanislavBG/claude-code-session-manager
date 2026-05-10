import { create } from 'zustand'
import type { WatcherInfo, WatcherLineEvent } from '../../preload/api'

const RING_SIZE = 200
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g

export interface WatcherLine {
  line: string
  ts: number
}

export interface RendererWatcher {
  watcherId: string
  tabId: string
  label: string
  command: string
  cwd: string
  pid: number | null
  startedAt: number
  lineCount: number
  lines: WatcherLine[]
  /** ms timestamp of the most recent line — null if no lines yet. */
  lastLineAt: number | null
}

interface WatchersState {
  watchers: Record<string, RendererWatcher>
  /** Hook bookkeeping so init() is idempotent across HMR/dev remounts. */
  initialized: boolean
  init: () => void
  add: (payload: { tabId: string; label: string; command: string; cwd?: string | null }) => Promise<RendererWatcher | null>
  remove: (watcherId: string) => Promise<void>
  watchersForTab: (tabId: string) => RendererWatcher[]
  ingestLine: (ev: WatcherLineEvent) => void
  closed: (watcherId: string) => void
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '')
}

function fromInfo(info: WatcherInfo): RendererWatcher {
  return {
    watcherId: info.watcherId,
    tabId: info.tabId,
    label: info.label,
    command: info.command,
    cwd: info.cwd,
    pid: info.pid,
    startedAt: info.startedAt,
    lineCount: info.lineCount,
    lines: [],
    lastLineAt: null,
  }
}

export const useWatchers = create<WatchersState>((set, get) => ({
  watchers: {},
  initialized: false,

  init: () => {
    if (get().initialized) return
    set({ initialized: true })
    window.api.watchers.onLine((ev) => get().ingestLine(ev))
    window.api.watchers.onClosed(({ watcherId }) => get().closed(watcherId))
  },

  add: async ({ tabId, label, command, cwd }) => {
    try {
      const res = await window.api.watchers.add({ tabId, label, command, cwd: cwd ?? null })
      const w: RendererWatcher = {
        watcherId: res.watcherId,
        tabId: res.tabId,
        label: res.label,
        command: res.command,
        cwd: res.cwd,
        pid: res.pid,
        startedAt: res.startedAt,
        lineCount: 0,
        lines: [],
        lastLineAt: null,
      }
      set({ watchers: { ...get().watchers, [w.watcherId]: w } })
      return w
    } catch (e) {
      console.error('[watchers] add failed:', e)
      return null
    }
  },

  remove: async (watcherId) => {
    try {
      await window.api.watchers.remove(watcherId)
    } catch (e) {
      console.error('[watchers] remove failed:', e)
    }
    // Listener-driven removal handles the dictionary cleanup, but force it now
    // so the UI reacts immediately even if the close event is delayed.
    const next = { ...get().watchers }
    delete next[watcherId]
    set({ watchers: next })
  },

  watchersForTab: (tabId) => Object.values(get().watchers).filter((w) => w.tabId === tabId),

  ingestLine: (ev) => {
    const cur = get().watchers[ev.watcherId]
    if (!cur) return
    const cleaned = stripAnsi(ev.line)
    // Ring buffer: append, then trim to RING_SIZE from the head. Keeps
    // memory bounded under high-frequency stdout (e.g. test watchers).
    const lines = cur.lines.length >= RING_SIZE
      ? [...cur.lines.slice(cur.lines.length - RING_SIZE + 1), { line: cleaned, ts: ev.ts }]
      : [...cur.lines, { line: cleaned, ts: ev.ts }]
    set({
      watchers: {
        ...get().watchers,
        [ev.watcherId]: {
          ...cur,
          lines,
          lineCount: cur.lineCount + 1,
          lastLineAt: ev.ts,
        },
      },
    })
  },

  closed: (watcherId) => {
    if (!get().watchers[watcherId]) return
    const next = { ...get().watchers }
    delete next[watcherId]
    set({ watchers: next })
  },
}))
