import { useEffect, useState } from 'react'
import type { NavKey } from './LeftNav'
import { Terminal } from './Terminal'
import { TerminalControls } from './TerminalControls'
import { BroadcastBar } from './BroadcastBar'
import { LearningPanel } from './LearningPanel'
import { Home } from './tabs/Home'
import { Skills } from './tabs/Skills'
import { Subagents } from './tabs/Subagents'
import { History } from './tabs/History'
import { Usage } from './tabs/Usage'
import { AgentView } from './tabs/AgentView'
import { SuperAgentModal } from './modals/SuperAgentModal'
import { RaceModal } from './modals/RaceModal'
import { OrchestratorModal } from './modals/OrchestratorModal'
import { HiveManagerModal } from './modals/HiveManagerModal'
import { BackgroundAgentsModal } from './modals/BackgroundAgentsModal'
import { RepoVisualizationModal } from './modals/RepoVisualizationModal'
import { QuickOpenModal } from './modals/QuickOpenModal'
import { GlobalSearchModal } from './modals/GlobalSearchModal'
import { AgentMemoryModal } from './modals/AgentMemoryModal'
import { VoiceModal } from './layout/VoiceModal'
import { Settings } from './tabs/Settings'
import { Permissions } from './tabs/Permissions'
import { SystemPrompt } from './tabs/SystemPrompt'
import { Keybindings } from './tabs/Keybindings'
import { Memory } from './tabs/Memory'
import { Plugins } from './tabs/Plugins'
import { McpServers } from './tabs/McpServers'
import { Hooks } from './tabs/Hooks'
import { Plans } from './tabs/Plans'
import { Tasks } from './tabs/Tasks'
import { Projects } from './tabs/Projects'
import { DocEditor } from './tabs/DocEditor'
import { SchedulePanel } from './SchedulePanel'
import { SectionFrame } from './layout/SectionFrame'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { useSessions } from '../state/sessions'
import { WatchersPopover } from './WatchersPopover'
import { LiveTranscript } from './LiveTranscript'

/**
 * MainPane — Almanac-era full-page router. Every Workspace and Configure
 * nav item renders as a full page here; only Tools and infrastructure-level
 * dialogs (Voice, Quick Open, etc.) remain as modals owned by App.tsx.
 *
 * Terminal still gets the special "always mounted, visibility-toggled"
 * treatment so the PTY-backed xterm doesn't churn on every nav switch.
 *
 * Promoted screens are wrapped in <SectionFrame> by default. A screen can
 * opt out (e.g. Terminal, AgentView, Home) when it draws its own chrome.
 */

interface MainPaneProps {
  active: NavKey
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
  broadcastOpen: boolean
  watchersOpen: boolean
  onCloseBroadcast: () => void
  onCloseWatchers: () => void
}

interface PageConfig {
  eyebrow: string
  title: string
  intro?: string
}

const PAGE_META: Partial<Record<NavKey, PageConfig>> = {
  'skills':        { eyebrow: 'Workspace',  title: 'Reusable instructions',     intro: 'Skills are scoped pieces of context that Claude loads on demand. Add new ones, audit what is live, or disable a skill that is misbehaving.' },
  'subagents':     { eyebrow: 'Workspace',  title: 'The hive',                  intro: 'Sub-agents working in parallel on the active session. Each row shows what it was asked to do and where it landed.' },
  'history':       { eyebrow: 'Workspace',  title: 'Every session, ever',       intro: 'Resumable transcripts across every project you have opened. Pick a row to reattach Claude to the same conversation.' },
  'usage':         { eyebrow: 'Workspace',  title: 'Tokens, cost, cadence',     intro: 'Daily and per-session usage from the Anthropic billing API. The 5-hour window in the footer is the same source.' },
  'plans':         { eyebrow: 'Workspace',  title: 'Plans & PRDs',              intro: 'PRDs that drive the scheduler. Edit, queue, or peek at the body that will be sent to claude -p.' },
  'tasks':         { eyebrow: 'Workspace',  title: 'Tasks across sessions',     intro: 'Active to-dos pulled from every running Claude session. Use this to see what is in flight without tab-hopping.' },
  'scheduler':     { eyebrow: 'Workspace',  title: 'Scheduler',                 intro: 'Queue claude -p jobs against your 5-hour window. Jobs auto-pause on rate-limit and resume on the next reset.' },
  'plugins':       { eyebrow: 'Configure',  title: 'Plugins',                   intro: 'Extensions for Claude Code. Install, enable, or remove plugins per-scope.' },
  'mcp':           { eyebrow: 'Configure',  title: 'MCP Servers',               intro: 'External tools and integrations the agent can call. Add a new server or test an existing connection.' },
  'hooks':         { eyebrow: 'Configure',  title: 'Hooks',                     intro: 'Run scripts on session events. Tail logs, format files, post to Slack — anything that responds to a shell command.' },
  'keybindings':   { eyebrow: 'Configure',  title: 'Keybindings',               intro: 'Shortcuts you can override. Bindings here apply to Claude Code itself, not the Session Manager chrome.' },
  'doc-editor':    { eyebrow: 'Configure',  title: 'Doc Editor',                intro: 'Edit CLAUDE.md and project documentation with WYSIWYG. Saves are atomic and live-update Claude when present.' },
  'memory':        { eyebrow: 'Configure',  title: 'Workspace memory',          intro: 'Files in ~/.claude that persist across conversations. Stored locally — nothing leaves your machine.' },
  'projects':      { eyebrow: 'Configure',  title: 'Known projects',            intro: 'Every folder Claude has run in. Pin favorites, prune stale entries, or quickly start a session in one.' },
  'system-prompt': { eyebrow: 'Configure',  title: 'System prompt',             intro: 'The personality and behavior contract for this app. Edits here apply to every new session you spawn.' },
  'permissions':   { eyebrow: 'Configure',  title: 'Permissions',               intro: 'Allow and deny rules per scope. Adjust which tools Claude can call without prompting.' },
  'settings':      { eyebrow: 'Configure',  title: 'Settings',                  intro: 'Theme, voice input, billing window, density. Per-scope JSON with schema validation.' },
  // Tools — promoted from modals in v0.13.1.
  'voice':            { eyebrow: 'Tools', title: 'Voice & microphone',  intro: 'Whisper transcription, push-to-talk hotkey, device selection, and TTS toggle.' },
  'superagent':       { eyebrow: 'Tools', title: 'SuperAgent',          intro: 'Claude dispatches a specialist subagent for the task you describe.' },
  'race':             { eyebrow: 'Tools', title: 'Race',                intro: 'Send the same prompt to multiple tabs and watch them compete; the winner is graded against a rubric.' },
  'orchestrator':     { eyebrow: 'Tools', title: 'Orchestrator',        intro: 'Assign different sub-tasks across N tabs in parallel. Useful for coordinated multi-file work.' },
  'hives':            { eyebrow: 'Tools', title: 'Hives',               intro: 'Pre-baked agent swarm templates. Pick a hive and Orchestrator launches its members against your target.' },
  'background-agents':{ eyebrow: 'Tools', title: 'Background agents',   intro: 'Long-running scheduler queue. Run claude -p jobs from PRDs while you keep working.' },
  'repoviz':          { eyebrow: 'Tools', title: 'Repo visualization',  intro: 'Language + directory map of the current project, computed locally.' },
  'quick-open':       { eyebrow: 'Tools', title: 'Quick open',          intro: '⌘P — fuzzy-find any file in the current cwd. Recently-opened files surface first.' },
  'global-search':    { eyebrow: 'Tools', title: 'Search in project',   intro: '⌘⇧F — ripgrep across every file under the active cwd (falls back to fs walk if rg is missing).' },
  'agent-memory':     { eyebrow: 'Tools', title: 'Agent memory',        intro: 'Per-subagent notes — facts about specific agents that persist across projects.' },
}

const noop = () => { /* page-mode close handler; nav-away closes implicitly */ }

function renderScreen(active: NavKey, ctx: {
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
}): React.ReactNode {
  // Screens that draw their own chrome — render bare.
  switch (active) {
    case 'overview':
      return (
        <Home
          onNavigate={ctx.onNavigate}
          onNewSession={ctx.onNewSession}
          onOpenVoice={ctx.onOpenVoice}
          onOpenScheduler={ctx.onOpenScheduler}
        />
      )
    case 'agent-view':
      return <AgentView />
  }

  const meta = PAGE_META[active]
  const body = (() => {
    switch (active) {
      case 'skills':        return <Skills />
      case 'subagents':     return <Subagents />
      case 'history':       return <History />
      case 'usage':         return <Usage />
      case 'plans':         return <Plans />
      case 'tasks':         return <Tasks />
      case 'scheduler':     return <SchedulePanel />
      case 'plugins':       return <Plugins />
      case 'mcp':           return <McpServers />
      case 'hooks':         return <Hooks />
      case 'keybindings':   return <Keybindings />
      case 'doc-editor':    return <DocEditor />
      case 'memory':        return <Memory />
      case 'projects':      return <Projects />
      case 'system-prompt': return <SystemPrompt />
      case 'permissions':   return <Permissions />
      case 'settings':      return <Settings />
      // Former-modal tools rendered with variant="page" so they paint inline
      // with no overlay/portal. Pass a noop onClose since the route owns
      // visibility; the navigate-away action effectively closes them.
      case 'voice':             return <VoiceModal open={true} onClose={noop} variant="page" />
      case 'superagent':        return <SuperAgentModal open={true} onClose={noop} variant="page" />
      case 'race':              return <RaceModal open={true} onClose={noop} variant="page" />
      case 'orchestrator':      return <OrchestratorModal open={true} onClose={noop} variant="page" />
      case 'hives':             return <HiveManagerModal open={true} onClose={noop} variant="page" />
      case 'background-agents': return <BackgroundAgentsModal open={true} onClose={noop} variant="page" />
      case 'repoviz':           return <RepoVisualizationModal open={true} onClose={noop} variant="page" />
      case 'quick-open':        return <QuickOpenModal open={true} onClose={noop} variant="page" />
      case 'global-search':     return <GlobalSearchModal open={true} onClose={noop} variant="page" />
      case 'agent-memory':      return <AgentMemoryModal />
      default: return null
    }
  })()
  if (!body) return null
  return meta
    ? <SectionFrame eyebrow={meta.eyebrow} title={meta.title} intro={meta.intro}>{body}</SectionFrame>
    : body
}

export function MainPane({
  active,
  onNavigate,
  onNewSession,
  onOpenVoice,
  onOpenScheduler,
  broadcastOpen,
  watchersOpen,
  onCloseBroadcast,
  onCloseWatchers,
}: MainPaneProps) {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const [toast, setToast] = useState<string | null>(null)

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
    // `relative` so absolute-positioned children (WatchersPopover) anchor to
    // MainPane rather than the viewport. TerminalControls now lives inside the
    // inner terminal-viewport div so its gear can't overlap the TabBar's
    // "v{__APP_VERSION__}" text.
    <main className="relative flex-1 min-w-0 bg-bg flex flex-col">
      {active === 'terminal' && broadcastOpen && (
        <BroadcastBar
          onClose={onCloseBroadcast}
          onSent={(n) => {
            onCloseBroadcast()
            setToast(`Sent to ${n} tab${n === 1 ? '' : 's'}`)
          }}
        />
      )}
      {active === 'terminal' && activeTab && watchersOpen && (
        <div className="absolute top-12 right-4 z-30">
          <WatchersPopover
            tabId={activeTab.id}
            cwd={activeTab.cwd}
            onClose={onCloseWatchers}
          />
        </div>
      )}
      <LearningPanel active={active} />
      <div className="flex-1 min-h-0 relative">
        {/*
         * Terminals stay mounted across nav switches — unmounting them drops
         * the IPC listeners while the PTY keeps running in the main process,
         * so a later remount tries to re-spawn the same tabId and fails with
         * "session already exists." Render them in a persistent layer and
         * toggle visibility only.
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
          {/* Terminal settings overlay — theme + font-size. Anchored to the
           *  terminal viewport (not MainPane) so the gear sits well below the
           *  TabBar's "v{__APP_VERSION__}" text. */}
          {active === 'terminal' && <TerminalControls />}
        </div>
        {active !== 'terminal' && (
          <div className="absolute inset-0 bg-bg overflow-auto">
            <ErrorBoundary>
              {renderScreen(active, { onNavigate, onNewSession, onOpenVoice, onOpenScheduler })}
            </ErrorBoundary>
          </div>
        )}
      </div>
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-10 right-4 z-40 bg-bg-elev border border-line text-fg text-xs px-3 py-1.5 rounded shadow-lg"
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
        <div>click <span className="text-fg-dim">+ new session</span> in the sidebar to start one</div>
      </div>
    </div>
  )
}
