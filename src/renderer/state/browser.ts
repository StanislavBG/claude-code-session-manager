/**
 * Browser tab state — an island store (no cross-store subscription, per
 * project convention). Owns the sub-tab strip's tabs plus the active tab,
 * and folds `browser:nav-state:<viewId>` broadcasts into per-tab nav state.
 *
 * viewId = tab id, mirroring the "Tab ID = sessionId" convention:
 * one crypto.randomUUID() generated per sub-tab is used both as the store's
 * `id` and as the main-process WebContentsView key.
 */
import { create } from 'zustand'
import type { RecordStep, BrowserHistoryEntry, BrowserBookmark, FindResult } from '../../preload/api'

export interface BrowserTab {
  id: string
  viewId: string
  title: string
  url: string
  color: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  isSecure: boolean
  zoomFactor: number
}

// PRD 402: history + bookmarks persistence, both under config.cjs's WRITE_PREFIXES
// allowlist and read/written via the existing config:read-json/config:write-json
// IPC path (window.api.config.*) — no dedicated browser:* channel needed.
const HISTORY_FILE = '~/.claude/session-manager/browser/history.json'
const BOOKMARKS_FILE = '~/.claude/session-manager/browser/bookmarks.json'
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 0.1

/** Contextual mode driving the right-side panel slot + webview chrome. */
export type BrowserMode = 'browse' | 'capture' | 'record' | 'observe'
export type CaptureMode = 'agent' | 'html' | 'a11y' | 'selector' | 'shot'

export interface CapturedPayload {
  mode: CaptureMode
  url: string
  title: string
  text?: string
  dataUrl?: string
  /** Set for text modes captured via the selection-scoped pipeline (PRD 404) — filter/prune/summarize/chunk stats for 'agent' mode. */
  meta?: { chunks?: number; tokens?: number }
  /** The picker selectors the capture was taken from (absent for 'shot', which screenshots the whole view). */
  selectors?: string[]
  at: number
}

interface BrowserState {
  tabs: BrowserTab[]
  activeTabId: string | null
  openTab: (opts?: { url?: string; color?: string }) => string
  closeTab: (id: string) => void
  setActive: (id: string) => void
  navigate: (id: string, url: string) => void
  back: (id: string) => void
  forward: (id: string) => void
  reload: (id: string) => void
  stop: (id: string) => void
  mode: BrowserMode
  captureMode: CaptureMode
  setMode: (mode: BrowserMode) => void
  /** Mode-radio change in CapturePanel — also clears stale `captured` output (design: `setCaptured(false)` on mode change). */
  setCaptureMode: (mode: CaptureMode) => void
  /** Verb-button click handler — mirrors the design's `onVerb`: toggles the
   * matching mode off if already active, and routes the `shot` verb into
   * capture mode preset to screenshot. */
  onVerb: (verb: 'capture' | 'record' | 'observe' | 'shot') => void

  // ── Capture (PRD 404/406/407) ───────────────────────────────────────
  captured: CapturedPayload | null
  /** Grabs the current selection's content per `captureMode` (or the whole
   * view for 'shot') and stores it in `captured`. `selectors` come from the
   * picker (PRD 403) — required for every mode except 'shot'. Throws on
   * failure so the caller (CapturePanel) can toast — stores don't import
   * toast per project convention. */
  capture: (selectors?: string[]) => Promise<void>

  // ── Recorder (PRD 408 engine → PRD 409 panel) ─────────────────────
  /** True once `recordStart` has been called and not yet stopped. */
  recorderActive: boolean
  /** True = actively capturing + elapsed timer running; false = paused
   * (session still open — mirrors the design's single `recording` flag). */
  recording: boolean
  recorderElapsedSec: number
  recorderSteps: RecordStep[]
  /** Entering record mode: starts the engine session for `viewId`. */
  startRecording: (viewId: string) => void
  /** Leaving record mode / Stop button: ends the engine session. */
  stopRecording: (viewId: string) => void
  /** Record/Pause transport button — toggles capture without ending the session. */
  toggleRecordingPause: () => void
  /** "parameterize as {{var}}" checkbox — flips a step's `variable` flag. */
  toggleStepVariable: (n: number) => void

  // ── Bookmarks (PRD 402) ─────────────────────────────────────────────
  bookmarks: BrowserBookmark[]
  bookmarksHydrated: boolean
  hydrateBookmarks: () => Promise<void>
  /** Star toggle in the address bar — adds/removes the tab's current URL. */
  toggleBookmark: (id: string) => void

  // ── History autocomplete (PRD 402) ──────────────────────────────────
  historyEntries: BrowserHistoryEntry[]
  /** Re-reads history.json — call when the address bar gains focus so
   * suggestions include navigations from other sub-tabs. */
  refreshHistory: () => Promise<void>

  // ── Zoom (PRD 402) ───────────────────────────────────────────────────
  setZoom: (id: string, factor: number) => void
  zoomIn: (id: string) => void
  zoomOut: (id: string) => void
  zoomReset: (id: string) => void

  // ── Find-in-page (PRD 402) ───────────────────────────────────────────
  findOpen: boolean
  findText: string
  findMatches: FindResult | null
  openFind: (id: string) => void
  closeFind: (id: string) => void
  setFindText: (id: string, text: string) => void
  findNext: (id: string) => void
  findPrev: (id: string) => void
}

const TAB_COLORS = ['#b85c34', '#6f7d52', '#e4b85a', '#5f6f86', '#8a5a6e', '#4f7d72']

let colorIdx = 0
function nextColor(): string {
  const c = TAB_COLORS[colorIdx % TAB_COLORS.length]
  colorIdx += 1
  return c
}

const navUnsubs = new Map<string, () => void>()

function subscribeNavState(viewId: string) {
  if (navUnsubs.has(viewId)) return
  const off = window.api.browser.onNavState(viewId, (state) => {
    useBrowserState.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.viewId === viewId
          ? {
              ...t,
              url: state.url,
              title: state.title || t.title,
              canGoBack: state.canGoBack,
              canGoForward: state.canGoForward,
              loading: state.loading,
              isSecure: state.isSecure,
            }
          : t,
      ),
    }))
  })
  navUnsubs.set(viewId, off)
}

function unsubscribeNavState(viewId: string) {
  const off = navUnsubs.get(viewId)
  if (off) {
    off()
    navUnsubs.delete(viewId)
  }
}

const recordStepUnsubs = new Map<string, () => void>()
let recordTimer: ReturnType<typeof setInterval> | null = null

function unsubscribeRecordStep(viewId: string) {
  const off = recordStepUnsubs.get(viewId)
  if (off) {
    off()
    recordStepUnsubs.delete(viewId)
  }
}

function stopRecordTimer() {
  if (recordTimer) {
    clearInterval(recordTimer)
    recordTimer = null
  }
}

const findResultUnsubs = new Map<string, () => void>()

function unsubscribeFindResult(viewId: string) {
  const off = findResultUnsubs.get(viewId)
  if (off) {
    off()
    findResultUnsubs.delete(viewId)
  }
}

export const useBrowserState = create<BrowserState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (opts) => {
    const id = crypto.randomUUID()
    const viewId = id
    const tab: BrowserTab = {
      id,
      viewId,
      title: 'New Tab',
      url: opts?.url ?? 'about:blank',
      color: opts?.color ?? nextColor(),
      canGoBack: false,
      canGoForward: false,
      loading: false,
      isSecure: false,
      zoomFactor: 1,
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    subscribeNavState(viewId)
    window.api.browser.create({ viewId, partition: 'persist:browser' }).then(() => {
      if (opts?.url) {
        window.api.browser.navigate({ viewId, url: opts.url }).catch(() => {})
      }
    }).catch((err: unknown) => {
      // Store convention: don't import toast here (see capture()'s comment) —
      // log so a failed create isn't silently swallowed, leaving an unbacked tab.
      const msg = err instanceof Error ? err.message : String(err)
      window.api?.logs?.write('browser', 'error', `browser:create failed for viewId ${viewId}: ${msg}`)
    })
    return id
  },

  closeTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    unsubscribeNavState(tab.viewId)
    unsubscribeFindResult(tab.viewId)
    window.api.browser.destroy(tab.viewId).catch(() => {})
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs.length ? tabs[tabs.length - 1].id : null) : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActive: (id) => {
    set({ activeTabId: id })
  },

  navigate: (id, url) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    window.api.browser.navigate({ viewId: tab.viewId, url }).catch(() => {})
  },

  back: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    window.api.browser.back(tab.viewId).catch(() => {})
  },

  forward: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    window.api.browser.forward(tab.viewId).catch(() => {})
  },

  reload: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    window.api.browser.reload(tab.viewId).catch(() => {})
  },

  stop: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    window.api.browser.stop(tab.viewId).catch(() => {})
  },

  mode: 'browse',
  captureMode: 'agent',

  setMode: (mode) => set((s) => ({ mode, captured: mode === 'capture' ? s.captured : null })),

  setCaptureMode: (captureMode) => set({ captureMode, captured: null }),

  onVerb: (verb) => {
    const { mode } = get()
    if (verb === 'shot') {
      set({ mode: 'capture', captureMode: 'shot', captured: null })
      return
    }
    if (mode === verb) {
      set({ mode: 'browse', captured: verb === 'capture' ? null : get().captured })
      return
    }
    set({
      mode: verb,
      captureMode: verb === 'capture' ? 'agent' : get().captureMode,
      captured: verb === 'capture' ? get().captured : null,
    })
  },

  captured: null,

  capture: async (selectors) => {
    const { activeTabId, tabs, captureMode } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) throw new Error('No active browser tab')
    if (captureMode === 'shot') {
      const result = await window.api.browser.captureShot(tab.viewId)
      if (!result.ok) throw new Error(result.error)
      set({ captured: { mode: captureMode, url: result.url, title: result.title, dataUrl: result.dataUrl, at: Date.now() } })
      return
    }
    if (!selectors || !selectors.length) throw new Error('No element selected')
    const result = await window.api.browser.capture({ viewId: tab.viewId, selectors, mode: captureMode })
    if (!result.ok) throw new Error(result.error)
    set({
      captured: {
        mode: captureMode,
        url: tab.url,
        title: tab.title,
        text: result.text,
        meta: result.meta,
        selectors,
        at: Date.now(),
      },
    })
  },

  recorderActive: false,
  recording: false,
  recorderElapsedSec: 0,
  recorderSteps: [],

  startRecording: (viewId) => {
    if (get().recorderActive) return
    set({ recorderActive: true, recording: true, recorderElapsedSec: 0, recorderSteps: [] })
    window.api.browser.recordStart(viewId).catch(() => {})
    unsubscribeRecordStep(viewId)
    const off = window.api.browser.onRecordStep(viewId, (step) => {
      if (!useBrowserState.getState().recording) return
      useBrowserState.setState((s) => ({ recorderSteps: [...s.recorderSteps, step] }))
    })
    recordStepUnsubs.set(viewId, off)
    stopRecordTimer()
    recordTimer = setInterval(() => {
      if (useBrowserState.getState().recording) {
        useBrowserState.setState((s) => ({ recorderElapsedSec: s.recorderElapsedSec + 1 }))
      }
    }, 1000)
  },

  stopRecording: (viewId) => {
    if (!get().recorderActive) return
    window.api.browser.recordStop(viewId).catch(() => {})
    unsubscribeRecordStep(viewId)
    stopRecordTimer()
    set({ recorderActive: false, recording: false })
  },

  toggleRecordingPause: () => {
    if (!get().recorderActive) return
    set((s) => ({ recording: !s.recording }))
  },

  toggleStepVariable: (n) => {
    set((s) => ({
      recorderSteps: s.recorderSteps.map((step) =>
        step.n === n
          ? { ...step, variable: step.variable ? null : step.variableSuggestion || 'value' }
          : step,
      ),
    }))
  },

  bookmarks: [],
  bookmarksHydrated: false,

  hydrateBookmarks: async () => {
    if (get().bookmarksHydrated) return
    try {
      const r = await window.api.config.readJson(BOOKMARKS_FILE)
      const list = r.exists && Array.isArray(r.data) ? (r.data as BrowserBookmark[]) : []
      set({ bookmarks: list, bookmarksHydrated: true })
    } catch {
      set({ bookmarksHydrated: true })
    }
  },

  toggleBookmark: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || !tab.url || tab.url === 'about:blank') return
    const existing = get().bookmarks
    const alreadyBookmarked = existing.some((b) => b.url === tab.url)
    const next = alreadyBookmarked
      ? existing.filter((b) => b.url !== tab.url)
      : [{ url: tab.url, title: tab.title, ts: Date.now() }, ...existing]
    set({ bookmarks: next })
    window.api.config.writeJson(BOOKMARKS_FILE, next).catch(() => {})
  },

  historyEntries: [],

  refreshHistory: async () => {
    try {
      const r = await window.api.config.readJson(HISTORY_FILE)
      const list = r.exists && Array.isArray(r.data) ? (r.data as BrowserHistoryEntry[]) : []
      set({ historyEntries: list })
    } catch {
      // keep the last-known list on read failure
    }
  },

  setZoom: (id, factor) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor))
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, zoomFactor: clamped } : t)) }))
    window.api.browser.setZoom({ viewId: tab.viewId, factor: clamped }).catch(() => {})
  },

  zoomIn: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab) get().setZoom(id, tab.zoomFactor + ZOOM_STEP)
  },

  zoomOut: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab) get().setZoom(id, tab.zoomFactor - ZOOM_STEP)
  },

  zoomReset: (id) => get().setZoom(id, 1),

  findOpen: false,
  findText: '',
  findMatches: null,

  openFind: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    set({ findOpen: true, findText: '', findMatches: null })
    unsubscribeFindResult(tab.viewId)
    const off = window.api.browser.onFindResult(tab.viewId, (result) => {
      useBrowserState.setState({ findMatches: result })
    })
    findResultUnsubs.set(tab.viewId, off)
  },

  closeFind: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    set({ findOpen: false, findText: '', findMatches: null })
    if (!tab) return
    unsubscribeFindResult(tab.viewId)
    window.api.browser.stopFind(tab.viewId).catch(() => {})
  },

  setFindText: (id, text) => {
    const tab = get().tabs.find((t) => t.id === id)
    set({ findText: text })
    if (!tab) return
    if (!text) {
      window.api.browser.find({ viewId: tab.viewId, text: '' }).catch(() => {})
      return
    }
    window.api.browser.find({ viewId: tab.viewId, text, forward: true }).catch(() => {})
  },

  findNext: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    const { findText } = get()
    if (!tab || !findText) return
    window.api.browser.find({ viewId: tab.viewId, text: findText, forward: true }).catch(() => {})
  },

  findPrev: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    const { findText } = get()
    if (!tab || !findText) return
    window.api.browser.find({ viewId: tab.viewId, text: findText, forward: false }).catch(() => {})
  },
}))
