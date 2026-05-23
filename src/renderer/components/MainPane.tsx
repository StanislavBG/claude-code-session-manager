import { useCallback, useEffect, useState } from 'react'
import type { NavKey } from './LeftNav'
import { Terminal } from './Terminal'
import { BroadcastBar } from './BroadcastBar'
import { LearningPanel } from './LearningPanel'
import { Overview } from './tabs/Overview'
import { Skills } from './tabs/Skills'
import { Subagents } from './tabs/Subagents'
import { History } from './tabs/History'
import { Usage } from './tabs/Usage'
import { AgentView } from './tabs/AgentView'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { useSessions } from '../state/sessions'
import { WatchersPopover } from './WatchersPopover'
import { LiveTranscript } from './LiveTranscript'
import { FileTree } from './layout/FileTree'

/** MainPane only renders the 7 screen-level NavKeys reachable via the Header
 *  tabs. All other NavKey values open as TabModal overlays handled in
 *  App.tsx — they never reach this switch. */
const LABELS: Partial<Record<NavKey, string>> = {
  'overview': 'Home',
  'terminal': 'Terminal',
  'agent-view': 'Agent-View',
  'skills': 'Skills',
  'subagents': 'Hive — Subagents',
  'history': 'History',
  'usage': 'Usage',
}

function renderTab(active: NavKey, onNavigate?: (k: NavKey) => void): React.ReactNode {
  switch (active) {
    case 'overview':
      return <Overview onNavigate={onNavigate} />
    case 'skills':
      return <Skills />
    case 'subagents':
      return <Subagents />
    case 'history':
      return <History />
    case 'usage':
      return <Usage />
    case 'agent-view':
      return <AgentView />
    default:
      return null
  }
}

interface MainPaneProps {
  active: NavKey
  onNavigate?: (k: NavKey) => void
  broadcastOpen: boolean
  watchersOpen: boolean
  onCloseBroadcast: () => void
  onCloseWatchers: () => void
}

export function MainPane({
  active,
  onNavigate,
  broadcastOpen,
  watchersOpen,
  onCloseBroadcast,
  onCloseWatchers,
}: MainPaneProps) {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const [toast, setToast] = useState<string | null>(null)
  // FileTree sidebar — default visible on terminal screen, Cmd/Ctrl+B toggles.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('sm.fileTree.open') !== '0' } catch { return true }
  })

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      const next = !v
      try { localStorage.setItem('sm.fileTree.open', next ? '1' : '0') } catch { /* */ }
      return next
    })
  }, [])

  // Cmd/Ctrl+B toggles only when terminal screen is active. Skip when typing
  // in inputs/textareas (BroadcastBar's textarea) so we don't steal characters.
  useEffect(() => {
    if (active !== 'terminal') return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'b') return
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      e.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, toggleSidebar])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(t)
  }, [toast])

  // Transient toast on every watcher line for the active tab. Keeps users
  // aware of background activity without making them open the popover.
  useEffect(() => {
    if (!activeTab) return
    const off = window.api.watchers.onLine((ev) => {
      if (ev.tabId !== activeTab.id) return
      const line = ev.line.replace(/\x1b\[[0-9;]*m/g, '')
      if (!line.trim()) return
      setToast(line.length > 100 ? `${line.slice(0, 100)}…` : line)
    })
    return off
  }, [activeTab?.id])

  return (
    <main className="flex-1 min-w-0 bg-bg flex flex-row">
      {active === 'terminal' && sidebarOpen && activeTab && (
        <div className="w-60 shrink-0 border-r border-line overflow-hidden flex flex-col">
          <ErrorBoundary>
            <FileTree cwd={activeTab.cwd} />
          </ErrorBoundary>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
      <header className="relative h-8 border-b border-line px-4 flex items-center shrink-0">
        <h1 className="text-[10px] text-fg-faint uppercase tracking-wider">{LABELS[active] ?? ''}</h1>
        <div className="flex-1" />
        {active === 'terminal' && activeTab && watchersOpen && (
          <WatchersPopover
            tabId={activeTab.id}
            cwd={activeTab.cwd}
            onClose={onCloseWatchers}
          />
        )}
      </header>
      {active === 'terminal' && broadcastOpen && (
        <BroadcastBar
          onClose={onCloseBroadcast}
          onSent={(n) => {
            onCloseBroadcast()
            setToast(`Sent to ${n} tab${n === 1 ? '' : 's'}`)
          }}
        />
      )}
      <LearningPanel active={active} />
      <div className="flex-1 min-h-0 relative">
        {/*
         * Terminals must stay mounted across nav switches — unmounting them
         * drops the IPC listeners while the PTY keeps running in the main
         * process, so a later remount tries to re-spawn the same tabId and
         * fails with "session already exists". Render them in a persistent
         * layer and only hide when another nav pane is active.
         */}
        <div
          className="absolute inset-0"
          style={{ visibility: active === 'terminal' ? 'visible' : 'hidden' }}
        >
          {activeTab ? (
            tabs.map((t) => (
              <div
                key={`${t.id}-${t.generation}`}
                className="absolute inset-0"
                style={{ visibility: t.id === activeTabId ? 'visible' : 'hidden' }}
              >
                <Terminal tabId={t.id} cwd={t.cwd} />
              </div>
            ))
          ) : (
            <NoSession />
          )}
          <LiveTranscript />
        </div>
        {active !== 'terminal' && (
          <div className="absolute inset-0 bg-bg overflow-auto">
            <ErrorBoundary>{renderTab(active, onNavigate)}</ErrorBoundary>
          </div>
        )}
      </div>
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-4 right-4 z-40 bg-bg-elev border border-line text-fg text-xs px-3 py-1.5 rounded shadow-lg"
          data-testid="broadcast-toast"
        >
          {toast}
        </div>
      )}
      </div>
    </main>
  )
}

function NoSession() {
  return (
    <div className="h-full flex items-center justify-center text-fg-faint text-xs">
      <div className="text-center">
        <div className="mb-2">no active session</div>
        <div>click <span className="text-fg-dim">+ new</span> in the tab bar to start one</div>
      </div>
    </div>
  )
}
