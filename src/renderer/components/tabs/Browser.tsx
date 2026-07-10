/**
 * Browser — embedded dev browser tab. Renders the chrome (sub-tab strip,
 * address bar, webview column placeholder) that wraps the native
 * WebContentsView the main process positions on top of this window. The
 * placeholder div itself shows nothing — the native view covers it; a
 * ResizeObserver keeps `browser:set-bounds` in sync with the div's rect.
 *
 * Bottom action bar + mode state (browse/capture/record/observe) + side
 * panel slot are PRD 402. This PRD ships browse mode only.
 */
import { useEffect, useRef } from 'react'
import { useBrowserState } from '../../state/browser'
import { SubTabStrip } from './browser/SubTabStrip'
import { AddressBar } from './browser/AddressBar'

export function Browser() {
  const tabs = useBrowserState((s) => s.tabs)
  const activeTabId = useBrowserState((s) => s.activeTabId)
  const openTab = useBrowserState((s) => s.openTab)
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={columnRef} className="relative min-h-0 flex-1" />
        </div>
        {/* right side-panel slot arrives in PRD 402 */}
      </div>
    </div>
  )
}
