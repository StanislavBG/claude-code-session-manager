import { useEffect, useState } from 'react'
import type { NavKey } from './LeftNav'
import { Terminal } from './Terminal'
import { BroadcastBar } from './BroadcastBar'
import { LearningPanel } from './LearningPanel'
import { Tooltip } from './ui/Tooltip'
import { Overview } from './tabs/Overview'
import { Settings } from './tabs/Settings'
import { SystemPrompt } from './tabs/SystemPrompt'
import { Keybindings } from './tabs/Keybindings'
import { Permissions } from './tabs/Permissions'
import { Skills } from './tabs/Skills'
import { Plugins } from './tabs/Plugins'
import { McpServers } from './tabs/McpServers'
import { Hooks } from './tabs/Hooks'
import { Subagents } from './tabs/Subagents'
import { Plans } from './tabs/Plans'
import { Tasks } from './tabs/Tasks'
import { Memory } from './tabs/Memory'
import { Projects } from './tabs/Projects'
import { History } from './tabs/History'
import { Usage } from './tabs/Usage'
import { AgentView } from './tabs/AgentView'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { useSessions } from '../state/sessions'
import { useWatchers } from '../state/watchers'
import { WatchersPopover } from './WatchersPopover'
import { LiveTranscript } from './LiveTranscript'

const LABELS: Record<NavKey, string> = {
  'overview': 'Overview',
  'terminal': 'Terminal',
  'system-prompt': 'System Prompt / Personality',
  'settings': 'Settings',
  'permissions': 'Permissions',
  'skills': 'Skills',
  'plugins': 'Plugins',
  'mcp': 'MCP Servers',
  'hooks': 'Hooks',
  'subagents': 'Subagents',
  'plans': 'Plans',
  'tasks': 'Tasks / Todos',
  'memory': 'Memory',
  'projects': 'Projects',
  'history': 'History',
  'keybindings': 'Keybindings',
  'usage': 'Usage',
  'agent-view': 'Agent-View',
}

function renderTab(active: NavKey, onNavigate?: (k: NavKey) => void): React.ReactNode {
  switch (active) {
    case 'overview':
      return <Overview onNavigate={onNavigate} />
    case 'system-prompt':
      return <SystemPrompt />
    case 'settings':
      return <Settings />
    case 'permissions':
      return <Permissions />
    case 'skills':
      return <Skills />
    case 'plugins':
      return <Plugins />
    case 'mcp':
      return <McpServers />
    case 'hooks':
      return <Hooks />
    case 'subagents':
      return <Subagents />
    case 'plans':
      return <Plans />
    case 'tasks':
      return <Tasks />
    case 'memory':
      return <Memory />
    case 'projects':
      return <Projects />
    case 'history':
      return <History />
    case 'keybindings':
      return <Keybindings />
    case 'usage':
      return <Usage />
    case 'agent-view':
      return <AgentView />
    default:
      return null
  }
}

export function MainPane({ active, onNavigate }: { active: NavKey; onNavigate?: (k: NavKey) => void }) {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const restartTab = useSessions((s) => s.restartTab)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [watchersOpen, setWatchersOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const watcherCount = useWatchers((s) =>
    activeTab ? s.watchersForTab(activeTab.id).length : 0,
  )

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
    <main className="flex-1 min-w-0 bg-bg flex flex-col">
      <header className="relative h-9 border-b border-line px-4 flex items-center shrink-0">
        <h1 className="text-xs text-fg-dim uppercase tracking-wider">{LABELS[active]}</h1>
        {activeTab && (
          <span className="ml-4 text-xs text-fg-faint truncate">{activeTab.cwd}</span>
        )}
        <div className="flex-1" />
        {activeTab && active === 'terminal' && (
          <div className="flex items-center gap-2">
            <Tooltip content="Kill claude and start a fresh session in the same directory (picks up config changes).">
              <button
                onClick={() => restartTab(activeTab.id)}
                className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
                title="Kill claude and start a fresh session in the same directory (picks up config changes)"
              >
                Restart Session
              </button>
            </Tooltip>
            <Tooltip content="Kill all sessions, quit the app, and relaunch — all tabs restore automatically.">
              <button
                onClick={() => window.api.app.rebootApp()}
                className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
                title="Kill all sessions, quit the app, and relaunch — all tabs restore automatically"
              >
                Restart App
              </button>
            </Tooltip>
            <Tooltip content="Send the same prompt to multiple selected tabs at once. Useful for shipping the same instruction to several Claude sessions.">
              <button
                onClick={() => setBroadcastOpen((v) => !v)}
                className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
                title="Send the same prompt to multiple tabs at once"
                aria-pressed={broadcastOpen}
                data-testid="broadcast-toggle"
              >
                Broadcast
              </button>
            </Tooltip>
            <Tooltip content="Attach a long-running shell command (e.g. npm test --watch, tail -f) to this tab. Each line of stdout streams back as a toast and is kept in a 200-line ring buffer.">
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setWatchersOpen((v) => !v)}
                className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
                title="Attach a shell command and stream its stdout into this tab"
                aria-pressed={watchersOpen}
                data-testid="watchers-toggle"
              >
                Watchers{watcherCount > 0 ? ` (${watcherCount})` : ''}
              </button>
            </Tooltip>
          </div>
        )}
        {active === 'terminal' && activeTab && watchersOpen && (
          <WatchersPopover
            tabId={activeTab.id}
            cwd={activeTab.cwd}
            onClose={() => setWatchersOpen(false)}
          />
        )}
      </header>
      {active === 'terminal' && broadcastOpen && (
        <BroadcastBar
          onClose={() => setBroadcastOpen(false)}
          onSent={(n) => {
            setBroadcastOpen(false)
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
