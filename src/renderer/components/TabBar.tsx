import { useEffect, useState } from 'react'
import { useSessions } from '../state/sessions'
import { useWatchers } from '../state/watchers'
import { useBrowserState } from '../state/browser'
import { useLayout } from '../state/layout'
import { AlmanacIcon } from './layout/AlmanacIcon'
import { useTabDragReorder } from './useTabDragReorder'

const ACTIVITY_WINDOW_MS = 30_000

interface TabBarProps {
  onToggleSplitView?: () => void
  splitViewActive?: boolean
}

export function TabBar({ onToggleSplitView, splitViewActive }: TabBarProps = {}) {
  // Subscribe per-slice. A bare `useSessions()` returns a fresh object every
  // tick (no shallow-equality selector), which trips React #185 (Maximum
  // update depth) under any external setState — manifesting as a blank app
  // post-render with all e2e selectors timing out.
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const closeTab = useSessions((s) => s.closeTab)
  const setActive = useSessions((s) => s.setActive)
  const reorderTab = useSessions((s) => s.reorderTab)
  const watchersById = useWatchers((s) => s.watchers)
  const hasBrowserTabs = useBrowserState((s) => s.tabs.length > 0)
  const canSplitView = activeTabId != null && hasBrowserTabs
  const focusedPanelId = useLayout((s) => s.focusedPanelId)
  const openPanel = useLayout((s) => s.openPanel)
  const setEpicsWorkspaceOpen = useLayout((s) => s.setEpicsWorkspaceOpen)
  const machineHomeActive = focusedPanelId === 'overview'

  // Re-render the badge layer once a second so the 30s activity window can
  // expire on its own — lastLineAt itself doesn't change when no new line
  // Note: tour-tabbar testid is on the root container below.
  // arrives, so without a tick the dot would never clear.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const activeTabIds = (tabId: string): boolean => {
    for (const w of Object.values(watchersById)) {
      if (w.tabId !== tabId) continue
      if (w.lastLineAt && now - w.lastLineAt < ACTIVITY_WINDOW_MS) return true
    }
    return false
  }

  const { getTabDragProps, isDragging, containerRef } = useTabDragReorder({
    tabCount: tabs.length,
    onReorder: reorderTab,
    onActivate: (index) => {
      const tab = tabs[index]
      if (!tab) return
      setActive(tab.id)
      // Clicking a top tab means "show me this session", so drop the Epics
      // workspace overlay. Selection itself is never cleared anywhere — the
      // workspace is a display mode now, not the absence of a selection.
      setEpicsWorkspaceOpen(false)
      openPanel('terminal')
    },
  })

  // Project-dot color rotates by tab index — gives each project a small,
  // recognizable accent without needing the user to assign one.
  const DOT_PALETTE = ['#6f7d52', '#b85c34', '#a39079', '#7a8466', '#5b4a36']

  return (
    <div
      className="h-11 bg-bg-elev border-b border-line flex items-end px-3 gap-0 shrink-0 relative"
      data-testid="tour-tabbar"
    >
      <button
        onClick={() => openPanel('overview')}
        title="This machine — home"
        aria-current={machineHomeActive ? 'true' : undefined}
        data-testid="tabbar-machine-home"
        className={`flex items-center gap-2 px-3.5 pt-1.5 pb-2 rounded-t-[10px] text-[13px] shrink-0 transition-colors ${
          machineHomeActive
            ? 'bg-bg text-fg font-medium relative z-10 -mb-px shadow-[inset_0_2px_0_theme(colors.accent.DEFAULT)]'
            : 'text-fg-dim hover:text-fg hover:bg-bg-hi/40'
        }`}
      >
        <AlmanacIcon name="home" className="w-[15px] h-[15px]" />
        <span>Home</span>
      </button>
      <span className="w-px self-stretch my-1.5 bg-line" />
      <div
        ref={containerRef}
        className={`flex items-end gap-0.5 overflow-x-auto min-w-0 flex-1 select-none ${isDragging ? 'cursor-grabbing' : ''}`}
      >
        {tabs.map((t, index) => {
          const active = t.id === activeTabId
          const dragProps = getTabDragProps(index)
          const dot = DOT_PALETTE[index % DOT_PALETTE.length]
          return (
            <div
              key={t.id}
              {...dragProps}
              style={dragProps.style}
              className={`group flex items-center gap-2 px-3.5 pt-1.5 pb-2 rounded-t-[10px] text-[13px] shrink-0 transition-colors ${
                isDragging ? '' : 'cursor-grab'
              } ${
                active
                  ? 'bg-bg text-fg font-medium relative z-10 -mb-px border border-b-0 border-line'
                  : 'text-fg-dim hover:text-fg hover:bg-bg-hi/40'
              }`}
              title={t.cwd}
              aria-current={active ? 'true' : undefined}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  background: dot,
                  boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.15)',
                  opacity: t.status === 'spawning' ? 0.55 : 1,
                }}
              />
              <span className="truncate max-w-[200px]">{t.label}</span>
              {t.status === 'spawning' && (
                <span className="w-1.5 h-1.5 rounded-full bg-butter animate-pulse" title="spawning" />
              )}
              {activeTabIds(t.id) && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
                  title="watcher emitted a line in the last 30s"
                  data-testid="tab-watcher-dot"
                />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                className="text-fg-faint opacity-0 group-hover:opacity-100 hover:text-fg ml-1 leading-none"
                title="Close session"
                aria-label={`Close ${t.label}`}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-2 pb-2 pl-3 text-[12px] text-fg-faint shrink-0">
        {canSplitView && onToggleSplitView && (
          <button
            onClick={onToggleSplitView}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-line hover:bg-bg-hi/40 ${
              splitViewActive ? 'text-accent border-accent' : 'text-fg-faint hover:text-fg'
            }`}
            title="Split view: agent terminal + browser"
            aria-pressed={splitViewActive ?? false}
          >
            <span aria-hidden="true">⇄</span>
            <span>Split view</span>
          </button>
        )}
        <span className="font-semibold text-fg-dim">Claude Session Manager</span>
        <span className="font-mono text-[11px] text-fg-faint">v{__APP_VERSION__}</span>
      </div>
    </div>
  )
}
