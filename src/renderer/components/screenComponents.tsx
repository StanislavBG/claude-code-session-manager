import { Suspense, lazy, type ReactNode } from 'react'
import type { NavKey } from '../lib/navKey'
import { Home } from './tabs/Home'
import { ProjectHome } from './tabs/projecthome/ProjectHome'
import { EditorView } from './tabs/EditorView'
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
const History = lazy(() => import('./tabs/History').then((m) => ({ default: m.History })))
const Scheduler = lazy(() => import('./tabs/Scheduler').then((m) => ({ default: m.Scheduler })))
const Settings = lazy(() => import('./tabs/Settings').then((m) => ({ default: m.Settings })))
const SystemPrompt = lazy(() => import('./tabs/SystemPrompt').then((m) => ({ default: m.SystemPrompt })))
const ProjectClaudeConfig = lazy(() => import('./tabs/ProjectClaudeConfig').then((m) => ({ default: m.ProjectClaudeConfig })))
const Extensions = lazy(() => import('./tabs/Extensions').then((m) => ({ default: m.Extensions })))
const AppSettings = lazy(() => import('./tabs/AppSettings').then((m) => ({ default: m.AppSettings })))
const AgentLibrary = lazy(() => import('./tabs/AgentLibrary').then((m) => ({ default: m.AgentLibrary })))

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
  /** SectionFrame renders no h1 for this page (Extensions 3a — the sidebar already names it). */
  hideTitle?: boolean
}

const PAGE_META: Partial<Record<NavKey, PageConfig>> = {
  'history':       { title: 'Spend, tokens and time',    intro: 'Estimated spend, tokens, prompts and active time across every project — by project, model and day. Export any range to CSV.' },
  // 'scheduler' intentionally omitted: Scheduler owns its own full-bleed editorial header
  // (eyebrow + serif h1 + intro paragraph). Adding it here would double-render the heading.
  'memory':        { title: 'Claude config',             intro: 'This project\'s own Claude Code files — its memory folder, CLAUDE.md and CLAUDE.local.md, .claude/settings.json and settings.local.json, .mcp.json and .claude/skills/. Each tab edits the real file the claude CLI reads when a session starts here; ~/.claude is edited from Home.' },
  // 'projects' intentionally omitted: ProjectsWorkspace renders bare (no SectionFrame chrome)
  'system-prompt': { title: 'System prompt',             intro: 'The personality and behavior contract for this app. Edits here apply to every new session you spawn.' },
  'settings':      { title: 'Settings',                  intro: 'Claude Code\'s settings.json — permissions, hooks, env and every other key, per scope, with schema validation.' },
  'extensions':    { title: 'Extensions',                intro: 'Skills, MCP servers and plugins — each tab edits the real file Claude Code reads.', hideTitle: true },
  'app-settings':  { title: 'App Settings',              intro: 'Session Manager\'s own preferences — voice, appearance, telemetry, phone remote, updates and the storage map.' },
  'agent-library': { title: 'Agents',                 intro: 'Agents are the ACTOR of the AIM framework every session opens with — "you are acting as …". Global personas live in ~/.claude/agents, and any open project, picked in a persona’s project override, can get its own model or effort. Create, edit, duplicate, or delete a persona; each change writes the matching file on disk.' },
}

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
        <Home onNavigate={ctx.onNavigate} />
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
      case 'history':       return <LazyScreen><History /></LazyScreen>
      case 'scheduler':     return <LazyScreen><Scheduler navigate={ctx.onNavigate} /></LazyScreen>
      case 'memory':        return <LazyScreen><ProjectClaudeConfig /></LazyScreen>
      case 'system-prompt': return <LazyScreen><SystemPrompt /></LazyScreen>
      case 'settings':      return <LazyScreen><Settings scope="user" /></LazyScreen>
      case 'extensions':    return <LazyScreen><Extensions /></LazyScreen>
      case 'app-settings':  return <LazyScreen><AppSettings /></LazyScreen>
      case 'agent-library': return <LazyScreen><AgentLibrary /></LazyScreen>
      default: return null
    }
  })()
  if (!body) return null
  const eyebrow = NAV_GROUP_BY_KEY[active]
  return meta && eyebrow
    ? <SectionFrame eyebrow={eyebrow} title={meta.title} intro={meta.intro} hideTitle={meta.hideTitle} learnKey={active}>{body}</SectionFrame>
    : body
}
