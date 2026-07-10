/**
 * Browser — embedded dev browser tab. Renders the chrome (sub-tab strip,
 * address bar, webview column placeholder, bottom action bar) that wraps the
 * native WebContentsView the main process positions on top of this window.
 * The placeholder div itself shows nothing — the native view covers it; a
 * ResizeObserver keeps `browser:set-bounds` in sync with the div's rect.
 *
 * Mode (browse/capture/record/observe) lives on the browser store so the
 * verb buttons, address bar banner, and the contextual side panel all read
 * the same value. Opening a panel adds a 344px flex sibling next to the
 * webview column, so the existing ResizeObserver picks up the narrower rect
 * automatically — no separate bounds-shrink wiring needed here.
 *
 * The native view sits ABOVE this DOM, so mode-specific overlays (recording
 * bar, observe ring) can't be full-cover overlays — they're rendered as
 * chrome siblings around the webview-column placeholder instead (a banner
 * that pushes the column down, a border frame that insets it).
 */
import { useEffect, useRef } from 'react'
import { useBrowserState } from '../../state/browser'
import { SubTabStrip } from './browser/SubTabStrip'
import { AddressBar } from './browser/AddressBar'
import { ActionBar } from './browser/ActionBar'
import { CapturePanel } from './browser/CapturePanel'
import { RecorderPanel } from './browser/RecorderPanel'
import { ObservePanel } from './browser/ObservePanel'

export function Browser() {
  const tabs = useBrowserState((s) => s.tabs)
  const activeTabId = useBrowserState((s) => s.activeTabId)
  const openTab = useBrowserState((s) => s.openTab)
  const mode = useBrowserState((s) => s.mode)
  const columnRef = useRef<HTMLDivElement | null>(null)

  // Stable across nav-state broadcasts (loading/title updates re-create the
  // `tabs` array reference on every event) — only changes on tab
  // open/close/reorder, which is what show/hide + bounds-sync should react to.
  const viewIdsKey = tabs.map((t) => t.viewId).join(',')
  const activeViewId = tabs.find((t) => t.id === activeTabId)?.viewId ?? null

  // Seed one default tab on first mount so the tab is usable immediately.
  useEffect(() => {
    if (useBrowserState.getState().tabs.length === 0) openTab()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Show the active view, hide every other view — the native layer only
  // ever shows one browser sub-tab at a time.
  useEffect(() => {
    for (const t of useBrowserState.getState().tabs) {
      if (t.viewId === activeViewId) window.api.browser.show(t.viewId).catch(() => {})
      else window.api.browser.hide(t.viewId).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewIdsKey, activeViewId])

  // Nav-away / unmount: hide every view so the native layer doesn't float
  // over other Session Manager tabs (it sits above the DOM).
  useEffect(() => {
    return () => {
      for (const t of useBrowserState.getState().tabs) {
        window.api.browser.hide(t.viewId).catch(() => {})
      }
    }
  }, [])

  // Bounds sync: keep the active view positioned over the placeholder div.
  useEffect(() => {
    const el = columnRef.current
    if (!el || !activeViewId) return

    const report = () => {
      const rect = el.getBoundingClientRect()
      window.api.browser
        .setBounds({ viewId: activeViewId, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(() => {})
    }

    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [activeViewId])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <SubTabStrip />
      {activeTab && <AddressBar tab={activeTab} />}
      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${
            mode === 'observe' ? 'border-2 border-accent' : 'border-2 border-transparent'
          }`}
        >
          {mode === 'record' && (
            <div className="flex flex-shrink-0 items-center gap-2 bg-red-600 px-4 py-1.5 font-sans text-[12.5px] font-semibold text-white">
              <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-white" />
              Recording interactions — every click, type &amp; navigation is captured as a step
            </div>
          )}
          <div ref={columnRef} className="relative min-h-0 flex-1" />
          <ActionBar />
        </div>

        {mode === 'capture' && <CapturePanel />}
        {mode === 'record' && <RecorderPanel />}
        {mode === 'observe' && <ObservePanel />}
      </div>
    </div>
  )
}
