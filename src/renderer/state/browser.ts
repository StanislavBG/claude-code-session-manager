/**
 * Browser tab state — an island store (no cross-store subscription, per
 * project convention). Owns the sub-tab strip's tabs plus the active tab,
 * and folds `browser:nav-state:<viewId>` broadcasts into per-tab nav state.
 *
 * viewId = tab id, mirroring the "Tab ID = claudeSessionId" convention:
 * one crypto.randomUUID() generated per sub-tab is used both as the store's
 * `id` and as the main-process WebContentsView key.
 */
import { create } from 'zustand'
import type { RecordStep } from '../../preload/api'

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
}

/** Contextual mode driving the right-side panel slot + webview chrome. */
export type BrowserMode = 'browse' | 'capture' | 'record' | 'observe'
export type CaptureMode = 'agent' | 'html' | 'a11y' | 'selector' | 'shot'

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
  /** Verb-button click handler — mirrors the design's `onVerb`: toggles the
   * matching mode off if already active, and routes the `shot` verb into
   * capture mode preset to screenshot. */
  onVerb: (verb: 'capture' | 'record' | 'observe' | 'shot') => void

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
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    subscribeNavState(viewId)
    window.api.browser.create({ viewId, partition: `browser-${viewId}` }).then(() => {
      if (opts?.url) {
        window.api.browser.navigate({ viewId, url: opts.url }).catch(() => {})
      }
    }).catch(() => {})
    return id
  },

  closeTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    unsubscribeNavState(tab.viewId)
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

  setMode: (mode) => set({ mode }),

  onVerb: (verb) => {
    const { mode } = get()
    if (verb === 'shot') {
      set({ mode: 'capture', captureMode: 'shot' })
      return
    }
    if (mode === verb) {
      set({ mode: 'browse' })
      return
    }
    set({ mode: verb, captureMode: verb === 'capture' ? 'agent' : get().captureMode })
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
}))
