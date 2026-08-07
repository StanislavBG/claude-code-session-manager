import { Suspense, lazy, type ReactNode } from 'react'
import type { NavKey } from './LeftNav'
import { Home } from './tabs/Home'
import { ProjectHome } from './tabs/projecthome/ProjectHome'
import { EditorView } from './tabs/EditorView'
import { VoiceModal } from './layout/VoiceModal'
import { ProjectsWorkspace } from './tabs/ProjectsWorkspace'
import { SectionFrame } from './layout/SectionFrame'
import { NAV_GROUP_BY_KEY } from '../lib/navGroups'

// Lazy-loaded so these rarely-first-opened screens (and their heavier
// dependencies — react-force-graph-2d via Plugins -> SkillReferenceGraph,
// the Scheduler cockpit, History's analytics dashboard) are not parsed at
// boot. Each panel is already wrapped in an ErrorBoundary by Workbench.tsx's
// screenNode, so a chunk-load failure here surfaces as a pane error, not a
// blank app. Home / the terminal path / EditorView / VoiceModal stay eager
// (boot destination / privacy-critical recording path / already-lazy Tiptap
// body / recording indicator).
const Skills = lazy(() => import('./tabs/Skills').then((m) => ({ default: m.Skills })))
const History = lazy(() => import('./tabs/History').then((m) => ({ default: m.History })))
const Scheduler = lazy(() => import('./tabs/Scheduler').then((m) => ({ default: m.Scheduler })))
const Settings = lazy(() => import('./tabs/Settings').then((m) => ({ default: m.Settings })))
const Permissions = lazy(() => import('./tabs/Permissions').then((m) => ({ default: m.Permissions })))
const SystemPrompt = lazy(() => import('./tabs/SystemPrompt').then((m) => ({ default: m.SystemPrompt })))
const Memory = lazy(() => import('./tabs/Memory').then((m) => ({ default: m.Memory })))
const Plugins = lazy(() => import('./tabs/Plugins').then((m) => ({ default: m.Plugins })))
const McpServers = lazy(() => import('./tabs/McpServers').then((m) => ({ default: m.McpServers })))
const Hooks = lazy(() => import('./tabs/Hooks').then((m) => ({ default: m.Hooks })))
const AgentLibrary = lazy(() => import('./tabs/AgentLibrary').then((m) => ({ default: m.AgentLibrary })))
const TagLibrary = lazy(() => import('./tabs/TagLibrary').then((m) => ({ default: m.TagLibrary })))
const HostBilko = lazy(() => import('./tabs/HostBilko').then((m) => ({ default: m.HostBilko })))

const SCREEN_LOADING_FALLBACK = <div className="p-6 text-xs text-fg-faint">Loading…</div>

function LazyScreen({ children }: { children: ReactNode }) {
  return <Suspense fallback={SCREEN_LOADING_FALLBACK}>{children}</Suspense>
}

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
  'memory':        { title: 'Memory',                    intro: 'Memories that persist across conversations — Workspace scope (keyed by project) or Subagent scope (keyed by agent). Stored locally, nothing leaves your machine.' },
  // 'projects' intentionally omitted: ProjectsWorkspace renders bare (no SectionFrame chrome)
  'system-prompt': { title: 'System prompt',             intro: 'The personality and behavior contract for this app. Edits here apply to every new session you spawn.' },
  'permissions':   { title: 'Permissions',               intro: 'Allow and deny rules per scope. Adjust which tools Claude can call without prompting.' },
  'settings':      { title: 'Settings',                  intro: 'Theme, voice input, billing window, density. Per-scope JSON with schema validation.' },
  'agent-library': { title: 'Agent Library',                 intro: 'Every agent persona available on this machine — global definitions in ~/.claude/agents, and which currently-open projects override them locally. Create, edit, duplicate, or delete a persona; each change writes the matching file on disk.' },
  'tag-library':   { title: 'Tag Library',                   intro: 'Every Epic intent tag, its meaning, and its /develop-eagerness default. Assign or remove which agent personas carry each tag.' },
  'bilko-host':    { title: 'Host on Bilko.run',              intro: 'Publish this project\'s generated Marketing page to bilko.run as a static-path listing, via the bilko-host MCP\'s gated publish pipeline.' },
  // Tools — promoted from modals in v0.13.1.
  'voice':            { title: 'Voice & microphone',  intro: 'Whisper transcription, push-to-talk hotkey, device selection, and TTS toggle.' },
}

const noop = () => { /* page-mode close handler; nav-away closes implicitly */ }

/**
 * Per-NavKey element cache backing `renderScreenComponent`'s memoization.
 * Keyed on `ctx` reference equality (stable since perf-workbench-ctx-identity
 * landed): calling this function twice in a row for the same `active` with
 * the SAME `ctx` object returns the identical `ReactNode` reference, so
 * React bails out of reconciling that screen's subtree entirely rather than
 * diffing a freshly-built element tree against the previous one every time a
 * panel host re-renders for an unrelated reason. A genuine ctx identity
 * change (a callback in ScreenRenderCtx actually changed) still misses the
 * cache and recomputes, so this never masks a real prop update.
 */
const screenElementCache = new Map<NavKey, { ctx: ScreenRenderCtx; node: ReactNode }>()

/**
 * Renders the screen for NavKey `active`. `active === 'terminal'` is
 * special-cased by callers (Workbench.tsx keeps TerminalStage as an
 * always-mounted singleton) — this function is never called for 'terminal'.
 */
export function renderScreenComponent(active: NavKey, ctx: ScreenRenderCtx): ReactNode {
  const cached = screenElementCache.get(active)
  if (cached && cached.ctx === ctx) return cached.node
  const node = computeScreenComponent(active, ctx)
  screenElementCache.set(active, { ctx, node })
  return node
}

function computeScreenComponent(active: NavKey, ctx: ScreenRenderCtx): ReactNode {
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
  }

  const meta = PAGE_META[active]
  const body = (() => {
    switch (active) {
      case 'skills':        return <LazyScreen><Skills /></LazyScreen>
      case 'history':       return <LazyScreen><History /></LazyScreen>
      case 'scheduler':     return <LazyScreen><Scheduler navigate={ctx.onNavigate} /></LazyScreen>
      case 'plugins':       return <LazyScreen><Plugins /></LazyScreen>
      case 'mcp':           return <LazyScreen><McpServers /></LazyScreen>
      case 'hooks':         return <LazyScreen><Hooks /></LazyScreen>
      case 'memory':        return <LazyScreen><Memory /></LazyScreen>
      case 'system-prompt': return <LazyScreen><SystemPrompt /></LazyScreen>
      case 'permissions':   return <LazyScreen><Permissions /></LazyScreen>
      case 'settings':      return <LazyScreen><Settings /></LazyScreen>
      case 'agent-library': return <LazyScreen><AgentLibrary /></LazyScreen>
      case 'tag-library':   return <LazyScreen><TagLibrary /></LazyScreen>
      case 'bilko-host':    return <LazyScreen><HostBilko /></LazyScreen>
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
