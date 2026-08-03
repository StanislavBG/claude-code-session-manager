import type { ReactNode } from 'react'
import type { NavKey } from './LeftNav'
import { Home } from './tabs/Home'
import { ProjectHome } from './tabs/projecthome/ProjectHome'
import { Skills } from './tabs/Skills'
import { History } from './tabs/History'
import { EditorView } from './tabs/EditorView'
import { VoiceModal } from './layout/VoiceModal'
import { Settings } from './tabs/Settings'
import { Permissions } from './tabs/Permissions'
import { SystemPrompt } from './tabs/SystemPrompt'
import { Keybindings } from './tabs/Keybindings'
import { Memory } from './tabs/Memory'
import { Plugins } from './tabs/Plugins'
import { McpServers } from './tabs/McpServers'
import { Hooks } from './tabs/Hooks'
import { ProjectsWorkspace } from './tabs/ProjectsWorkspace'
import { Browser } from './tabs/Browser'
import { Scheduler } from './tabs/Scheduler'
import { WebRemote } from './tabs/WebRemote'
import { AgentLibrary } from './tabs/AgentLibrary'
import { TagLibrary } from './tabs/TagLibrary'
import { HostBilko } from './tabs/HostBilko'
import { SectionFrame } from './layout/SectionFrame'
import { NAV_GROUP_BY_KEY } from '../lib/navGroups'

/**
 * screenComponents — single source of truth for "what does NavKey `k` render
 * as a full screen." Consumed by Workbench.tsx (the dockview panel host)
 * and by layout.ts's panel registry (id list only, via screenKeys.ts —
 * that file stays React-free). Do not fork this switch; extend it here.
 */

export interface ScreenRenderCtx {
  onNavigate?: (k: NavKey) => void
  onNewSession?: () => void
  onOpenVoice?: () => void
  onOpenScheduler?: () => void
}

interface PageConfig {
  title: string
  intro?: string
}

const PAGE_META: Partial<Record<NavKey, PageConfig>> = {
  'skills':        { title: 'Reusable instructions',     intro: 'Skills are scoped pieces of context that Claude loads on demand. Add new ones, audit what is live, or disable a skill that is misbehaving.' },
  'history':       { title: 'Every session, ever',       intro: 'Resumable transcripts across every project you have opened. Pick a row to reattach Claude to the same conversation.' },
  // 'scheduler' intentionally omitted: Scheduler owns its own full-bleed editorial header
  // (eyebrow + serif h1 + intro paragraph). Adding it here would double-render the heading.
  'plugins':       { title: 'Plugins',                   intro: 'Extensions for Claude Code. Install, enable, or remove plugins per-scope.' },
  'mcp':           { title: 'MCP Servers',               intro: 'External tools and integrations the agent can call. Add a new server or test an existing connection.' },
  'hooks':         { title: 'Hooks',                     intro: 'Run scripts on session events. Tail logs, format files, post to Slack — anything that responds to a shell command.' },
  'keybindings':   { title: 'Keybindings',               intro: 'Shortcuts you can override. Bindings here apply to Claude Code itself, not the Session Manager chrome.' },
  'memory':        { title: 'Memory',                    intro: 'Memories that persist across conversations — Workspace scope (keyed by project) or Subagent scope (keyed by agent). Stored locally, nothing leaves your machine.' },
  // 'projects' intentionally omitted: ProjectsWorkspace renders bare (no SectionFrame chrome)
  'system-prompt': { title: 'System prompt',             intro: 'The personality and behavior contract for this app. Edits here apply to every new session you spawn.' },
  'permissions':   { title: 'Permissions',               intro: 'Allow and deny rules per scope. Adjust which tools Claude can call without prompting.' },
  'settings':      { title: 'Settings',                  intro: 'Theme, voice input, billing window, density. Per-scope JSON with schema validation.' },
  'agent-library': { title: 'Agent Library',                 intro: 'Every agent persona available on this machine — global definitions in ~/.claude/agents, and which currently-open projects override them locally. Create, edit, duplicate, or delete a persona; each change writes the matching file on disk.' },
  'tag-library':   { title: 'Tag Library',                   intro: 'Every Epic intent tag, its meaning, and its /develop-eagerness default. Assign or remove which agent personas carry each tag.' },
  'bilko-host':    { title: 'Host on Bilko.run',              intro: 'Publish this project\'s generated Marketing page to bilko.run as a static-path listing, via the bilko-host MCP\'s gated publish pipeline.' },
  'remote':        { title: 'Remote Access',              intro: 'Web remote control — disabled by default. Pair your browser, then issue scheduler + terminal commands from any device over a secure relay you self-host.' },
  // Tools — promoted from modals in v0.13.1.
  'voice':            { title: 'Voice & microphone',  intro: 'Whisper transcription, push-to-talk hotkey, device selection, and TTS toggle.' },
}

const noop = () => { /* page-mode close handler; nav-away closes implicitly */ }

/**
 * Renders the screen for NavKey `active`. `active === 'terminal'` is
 * special-cased by callers (Workbench.tsx keeps TerminalStage as an
 * always-mounted singleton) — this function is never called for 'terminal'.
 */
export function renderScreenComponent(active: NavKey, ctx: ScreenRenderCtx): ReactNode {
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
    case 'project-home':
      return <ProjectHome />
    case 'editor':
      return <EditorView />
    case 'projects':
      return <ProjectsWorkspace />
    case 'browser':
      return <Browser />
  }

  const meta = PAGE_META[active]
  const body = (() => {
    switch (active) {
      case 'skills':        return <Skills />
      case 'history':       return <History />
      case 'scheduler':     return <Scheduler navigate={ctx.onNavigate} />
      case 'plugins':       return <Plugins />
      case 'mcp':           return <McpServers />
      case 'hooks':         return <Hooks />
      case 'keybindings':   return <Keybindings />
      case 'memory':        return <Memory />
      case 'system-prompt': return <SystemPrompt />
      case 'permissions':   return <Permissions />
      case 'settings':      return <Settings />
      case 'remote':        return <WebRemote />
      case 'agent-library': return <AgentLibrary />
      case 'tag-library':   return <TagLibrary />
      case 'bilko-host':    return <HostBilko />
      // Former-modal tools rendered with variant="page" so they paint inline
      // with no overlay/portal. Pass a noop onClose since the route owns
      // visibility; the navigate-away action effectively closes them.
      case 'voice':             return <VoiceModal open={true} onClose={noop} variant="page" />
      default: return null
    }
  })()
  if (!body) return null
  const eyebrow = NAV_GROUP_BY_KEY[active]
  return meta && eyebrow
    ? <SectionFrame eyebrow={eyebrow} title={meta.title} intro={meta.intro} learnKey={active}>{body}</SectionFrame>
    : body
}
