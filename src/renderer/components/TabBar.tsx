import { useEffect, useState } from 'react'
import { useSessions } from '../state/sessions'
import { useWatchers } from '../state/watchers'
import { createPickedSession } from '../lib/createPickedSession'
import { useTabDragReorder } from './useTabDragReorder'

const ACTIVITY_WINDOW_MS = 30_000

export function TabBar() {
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
  const [error, setError] = useState<string | null>(null)

  // Re-render the badge layer once a second so the 30s activity window can
  // expire on its own — lastLineAt itself doesn't change when no new line
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
      if (tab) setActive(tab.id)
    },
  })

  const onPickedSession = async () => {
    setError(null)
    try {
      await createPickedSession()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      console.error('[TabBar] createPickedSession failed:', e)
    }
  }

  return (
    <div className="h-9 bg-bg-elev border-b border-line flex items-center px-2 gap-1 shrink-0">
      {/* Scrollable tab list — overflow-x-auto must NOT wrap the dropdown */}
      <div
        ref={containerRef}
        className={`flex items-center gap-1 overflow-x-auto min-w-0 flex-1 select-none ${isDragging ? 'cursor-grabbing' : ''}`}
      >
        {tabs.map((t, index) => {
          const active = t.id === activeTabId
          const dragProps = getTabDragProps(index)
          return (
            <div
              key={t.id}
              {...dragProps}
              style={dragProps.style}
              className={`group px-3 py-1 flex items-center gap-2 rounded-t text-xs shrink-0 transition-colors ${
                isDragging ? '' : 'cursor-grab'
              } ${
                active
                  ? 'bg-bg-hi text-fg font-semibold border border-b-0 border-accent border-t-2 -mb-px relative z-10'
                  : 'bg-bg-elev text-fg-dim border border-line hover:text-fg hover:bg-bg'
              }`}
              title={t.cwd}
              aria-current={active ? 'true' : undefined}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  t.status === 'running'
                    ? 'bg-green-500'
                    : t.status === 'spawning'
                    ? 'bg-yellow-500 animate-pulse'
                    : 'bg-fg-faint'
                }`}
              />
              <span>{t.label}</span>
              {activeTabIds(t.id) && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"
                  title="watcher emitted a line in the last 30s"
                  data-testid="tab-watcher-dot"
                />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                className="text-fg-faint opacity-0 group-hover:opacity-100 hover:text-fg ml-1"
                title="Close session"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <div className="shrink-0">
        <button
          onClick={onPickedSession}
          className="px-2 py-1 text-fg-dim hover:text-fg text-xs"
          title="New session — pick a project directory"
        >
          + new
        </button>
      </div>
      {error && <div className="text-red-400 text-xs px-2 shrink-0">{error}</div>}
      <div className="text-fg-faint text-xs px-2 shrink-0">
        Claude Session Manager{' '}
        <span className="font-mono text-fg-dim">v{__APP_VERSION__}</span>
      </div>
    </div>
  )
}
