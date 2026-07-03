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
import { EditorView } from './tabs/EditorView'
import { RepoVisualizationModal } from './modals/RepoVisualizationModal'
import { SearchModal, type SearchMode } from './modals/SearchModal'
import { VoiceModal } from './layout/VoiceModal'
import { Settings } from './tabs/Settings'
import { Permissions } from './tabs/Permissions'
import { SystemPrompt } from './tabs/SystemPrompt'
import { Keybindings } from './tabs/Keybindings'
import { Memory } from './tabs/Memory'
import { Plugins } from './tabs/Plugins'
import { McpServers } from './tabs/McpServers'
import { Hooks } from './tabs/Hooks'
import { Prompts } from './tabs/Prompts'
import { ProjectsWorkspace } from './tabs/ProjectsWorkspace'
import { DocEditor } from './tabs/DocEditor'
import { Scheduler } from './tabs/Scheduler'
import { WebRemote } from './tabs/WebRemote'
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
 * opt out (e.g. Terminal, Home) when it draws its own chrome.
 */

interface MainPaneProps {
  active: NavKey
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
  searchMode?: SearchMode
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
  // 'subagents' intentionally omitted: Subagents owns its own full-bleed editorial header
  // ("The hive" h1 + eyebrow + blurb). Adding it here would double-render the heading.
  'history':       { eyebrow: 'Workspace',  title: 'Every session, ever',       intro: 'Resumable transcripts across every project you have opened. Pick a row to reattach Claude to the same conversation.' },
  'usage':         { eyebrow: 'Workspace',  title: 'Usage & limits',            intro: 'The in-app /usage view: your plan\'s rolling-window consumption — 5-hour session and weekly limits — live from the billing API, with a burn-rate projection for the active window.' },
  'prompts':       { eyebrow: 'Workspace',  title: 'Prompts',                   intro: 'Click-to-insert templates for security, QA, performance, code review, debugging, refactoring, docs, and git/PR workflows. Tweak before send.' },
  // 'scheduler' intentionally omitted: Scheduler owns its own full-bleed editorial header
  // (eyebrow + serif h1 + intro paragraph). Adding it here would double-render the heading.
  'plugins':       { eyebrow: 'Configure',  title: 'Plugins',                   intro: 'Extensions for Claude Code. Install, enable, or remove plugins per-scope.' },
  'mcp':           { eyebrow: 'Configure',  title: 'MCP Servers',               intro: 'External tools and integrations the agent can call. Add a new server or test an existing connection.' },
  'hooks':         { eyebrow: 'Configure',  title: 'Hooks',                     intro: 'Run scripts on session events. Tail logs, format files, post to Slack — anything that responds to a shell command.' },
  'keybindings':   { eyebrow: 'Configure',  title: 'Keybindings',               intro: 'Shortcuts you can override. Bindings here apply to Claude Code itself, not the Session Manager chrome.' },
  'doc-editor':    { eyebrow: 'Configure',  title: 'Doc Editor',                intro: 'Edit CLAUDE.md and project documentation with WYSIWYG. Saves are atomic and live-update Claude when present.' },
  'memory':        { eyebrow: 'Configure',  title: 'Memory',                    intro: 'Memories that persist across conversations — Workspace scope (keyed by project) or Subagent scope (keyed by agent). Stored locally, nothing leaves your machine.' },
  // 'projects' intentionally omitted: ProjectsWorkspace renders bare (no SectionFrame chrome)
  'system-prompt': { eyebrow: 'Configure',  title: 'System prompt',             intro: 'The personality and behavior contract for this app. Edits here apply to every new session you spawn.' },
  'permissions':   { eyebrow: 'Configure',  title: 'Permissions',               intro: 'Allow and deny rules per scope. Adjust which tools Claude can call without prompting.' },
  'settings':      { eyebrow: 'Configure',  title: 'Settings',                  intro: 'Theme, voice input, billing window, density. Per-scope JSON with schema validation.' },
  'remote':        { eyebrow: 'Configure',  title: 'Remote Access',              intro: 'Web remote control — disabled by default. Pair your browser, then issue scheduler + terminal commands from any device over a secure relay you self-host.' },
  // Tools — promoted from modals in v0.13.1.
  'voice':            { eyebrow: 'Tools', title: 'Voice & microphone',  intro: 'Whisper transcription, push-to-talk hotkey, device selection, and TTS toggle.' },
  'repoviz':          { eyebrow: 'Tools', title: 'Repo visualization',  intro: 'Language + directory map of the current project, computed locally.' },
  'search':           { eyebrow: 'Tools', title: 'Search',              intro: 'Find by filename (⌘P) or by content (⌘⇧F) across the active cwd. The chosen path is inserted into the active terminal.' },
}

const noop = () => { /* page-mode close handler; nav-away closes implicitly */ }

function renderScreen(active: NavKey, ctx: {
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
  searchMode?: SearchMode
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
    case 'editor':
      return <EditorView />
    case 'projects':
      return <ProjectsWorkspace />
  }

  const meta = PAGE_META[active]
  const body = (() => {
    switch (active) {
      case 'skills':        return <Skills />
      case 'subagents':     return <Subagents />
      case 'history':       return <History />
      case 'usage':         return <Usage />
      case 'prompts':       return <Prompts />
      case 'scheduler':     return <Scheduler />
      case 'plugins':       return <Plugins />
      case 'mcp':           return <McpServers />
      case 'hooks':         return <Hooks />
      case 'keybindings':   return <Keybindings />
      case 'doc-editor':    return <DocEditor />
      case 'memory':        return <Memory />
      case 'system-prompt': return <SystemPrompt />
      case 'permissions':   return <Permissions />
      case 'settings':      return <Settings />
      case 'remote':        return <WebRemote />
      // Former-modal tools rendered with variant="page" so they paint inline
      // with no overlay/portal. Pass a noop onClose since the route owns
      // visibility; the navigate-away action effectively closes them.
      case 'voice':             return <VoiceModal open={true} onClose={noop} variant="page" />
      case 'repoviz':           return <RepoVisualizationModal open={true} onClose={noop} variant="page" />
      case 'search':            return <SearchModal open={true} onClose={noop} variant="page" initialMode={ctx.searchMode ?? 'files'} />
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
  searchMode,
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
                // 'inherit', not 'visible': an explicit `visible` on a child
                // OVERRIDES the outer layer's `hidden` (CSS visibility is
                // per-element), leaving the active tab focusable/"visible"
                // underneath whatever non-terminal screen is painted on top.
                style={{ visibility: t.id === activeTabId ? 'inherit' : 'hidden' }}
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
              {renderScreen(active, { onNavigate, onNewSession, onOpenVoice, onOpenScheduler, searchMode })}
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
