import type { NavKey } from './navKey'
import type { AlmanacIconName } from '../components/layout/AlmanacIcon'
import type { NavFace } from './navFace'

/**
 * Single source of truth for the three-way nav taxonomy (Workspace /
 * Claude Code / Session Manager) over `NavKey`. Drives both AlmanacSidebar's grouped
 * rows and MainPane's per-page eyebrow — a `NavKey` can only be assigned to
 * one group here, so the sidebar section and the page eyebrow can never
 * disagree.
 *
 * The grouping is only rendered as section headers on the HOME face — the
 * PROJECT face is a short flat list (six rows), where three headers cost more
 * chrome than they buy. `group` still applies on both faces: it drives the
 * page eyebrow and NAV_ITEMS' ordering, which the flat list preserves.
 *
 * `NavKey`s that render their own chrome and have no sidebar row (`editor`)
 * are intentionally absent. `overview` (the machine-wide Dashboard) IS a
 * sidebar row now, home-face-only, labeled "Dashboard" to stay distinct from
 * `project-home` ("Project Home", the per-project Brief, project-face-only)
 * — the two used to share the label "Home", which was confusing since they
 * are different screens reachable from different tab faces.
 */
export type NavGroupLabel = 'Workspace' | 'Claude Code' | 'Session Manager'

export interface NavGroupItem {
  key: NavKey
  group: NavGroupLabel
  label: string
  icon: AlmanacIconName
  liveKind?: 'scheduler'
  hint?: string
  /** Which sidebar face(s) (home / project) this item appears under. See lib/navFace.ts. */
  faces: NavFace[]
  /**
   * Per-face override of `label`/`hint`, for the rare item whose two faces
   * render genuinely DIFFERENT content (not just a scope filter over the
   * same screen). Resolved by getNavItemsForFace; falls back to the base
   * `label`/`hint` when the current face has no override. Scheduler used to
   * use this (Home: "Scheduler Configs", Project: "Epic's Execution Queue")
   * before the two faces were merged back into one combined screen — kept
   * as a mechanism for a future case, not currently exercised by any item.
   */
  labelByFace?: Partial<Record<NavFace, string>>
  hintByFace?: Partial<Record<NavFace, string>>
}

const HOME: NavFace[] = ['home']
const PROJECT: NavFace[] = ['project']
const BOTH: NavFace[] = ['home', 'project']

export const NAV_ITEMS: NavGroupItem[] = [
  // Workspace
  { key: 'overview',     group: 'Workspace', label: 'Guild Hall', icon: 'home',        hint: 'Your agents at work — every active session on this machine', faces: HOME },
  { key: 'project-home', group: 'Workspace', label: 'Project Home', icon: 'home',     hint: 'Pages, videos and tools for this project', faces: PROJECT },
  { key: 'terminal',   group: 'Workspace', label: 'Sessions',  icon: 'terminal',     hint: 'Independent goal-scoped sessions for this project', faces: PROJECT },
  { key: 'projects',   group: 'Workspace', label: 'File Explorer', icon: 'projects',  hint: 'Browse files + edit — starts at your home folder from Home, the active project from a Tab', faces: BOTH },
  // Scheduler is PROJECT-only: every route and view it renders is scoped to a
  // cwd (PRDs live in `<cwd>/session-manager-operations/scheduler/`, the queue
  // shards are per-project). A Home-face copy could only show the federated
  // all-projects view — cross-project queue monitoring we've deliberately
  // postponed rather than build a federation layer for.
  { key: 'scheduler',  group: 'Workspace', label: 'Scheduler',  icon: 'scheduler',    liveKind: 'scheduler', hint: 'This project\'s live PRD queue + scheduler policy', faces: PROJECT },
  // History is HOME-only: it is the machine-wide analytics/cost surface
  // (lib/historyProjectFold.ts folds every project's days together), so a
  // per-project copy of it was a second door onto the same cross-project
  // screen. Reachable from the Home face only.
  { key: 'history',    group: 'Workspace', label: 'History',    icon: 'history',      hint: 'Spend, tokens and time across every project', faces: HOME },

  // Claude Code — files the claude CLI itself reads
  // Home's Claude config — ONE row over ~/.claude whose page (HomeClaudeConfig)
  // carries six tabs. The four rows it replaced (system-prompt, settings,
  // extensions, agent-library) stay valid NavKeys as deep-link ALIASES — see
  // NAV_KEY_ALIASES below.
  { key: 'claude-config',  group: 'Claude Code', label: 'Claude config',  icon: 'settings',       hint: 'Your ~/.claude — CLAUDE.md, settings, MCP, skills, plugins, agents', faces: HOME },
  { key: 'memory',         group: 'Claude Code', label: 'Claude config',  icon: 'settings',       hint: 'This project\'s own files — CLAUDE.md, CLAUDE.local.md, settings, MCP, skills', faces: PROJECT },

  // Session Manager — this app's own preferences
  { key: 'app-settings', group: 'Session Manager', label: 'App Settings', icon: 'compass', hint: 'Voice, appearance, telemetry, web remote, updates, storage map', faces: HOME },
]

/**
 * Filters NAV_ITEMS by sidebar face, preserving NAV_ITEMS' existing group
 * order, and resolves any `labelByFace`/`hintByFace` override for the
 * current face over the base `label`/`hint`.
 */
export function getNavItemsForFace(face: NavFace): NavGroupItem[] {
  return NAV_ITEMS.filter((item) => item.faces.includes(face)).map((item) => ({
    ...item,
    label: item.labelByFace?.[face] ?? item.label,
    hint: item.hintByFace?.[face] ?? item.hint,
  }))
}

/**
 * The six tabs of Home's Claude config page, in band order. `HomeClaudeConfig`
 * maps each key to the existing page it mounts (CLAUDE.md → SystemPrompt,
 * Settings → Settings, MCP → McpServers, Skills → Skills, Plugins → Plugins,
 * Agents → AgentLibrary), all at user scope (~/.claude).
 */
export type HomeConfigTab = 'claude-md' | 'settings' | 'mcp' | 'skills' | 'plugins' | 'agents'

export const HOME_CLAUDE_CONFIG_TABS: ReadonlyArray<{ key: HomeConfigTab; label: string; icon: AlmanacIconName }> = [
  { key: 'claude-md', label: 'CLAUDE.md', icon: 'system-prompt' },
  { key: 'settings',  label: 'Settings',  icon: 'settings' },
  { key: 'mcp',       label: 'MCP',       icon: 'mcp' },
  { key: 'skills',    label: 'Skills',    icon: 'skills' },
  { key: 'plugins',   label: 'Plugins',   icon: 'plugins' },
  { key: 'agents',    label: 'Agents',    icon: 'book' },
]

export function isHomeConfigTab(t: string): t is HomeConfigTab {
  return HOME_CLAUDE_CONFIG_TABS.some((x) => x.key === t)
}

/**
 * Retired Home rows, still valid NavKeys for deep links (CommandPalette,
 * PluginCard, the footer's settings link, `sm:navigate`, persisted dockview
 * layouts). Each opens 'claude-config' on its tab. `extensions` keeps its old
 * sub-tab hints (skills / mcp / plugins) as the target tab.
 */
export const NAV_KEY_ALIASES: Partial<Record<NavKey, HomeConfigTab>> = {
  'system-prompt': 'claude-md',
  'settings':      'settings',
  'extensions':    'skills',
  'agent-library': 'agents',
}

/**
 * Rewrites a navigation request onto its canonical panel. A non-alias id
 * passes through unchanged. An alias becomes `claude-config` with a tab hint
 * `<tab>` or, for a Settings sub-view (`openPanel('settings', 'hooks')`),
 * `settings:<view>` — HomeClaudeConfig selects the tab and forwards the view
 * to the Settings page's own `settings` hint.
 */
export function resolveNavAlias(id: string, tab?: string): { id: string; tab?: string } {
  const target = NAV_KEY_ALIASES[id as NavKey]
  if (!target) return { id, tab }
  if (id === 'extensions' && tab && isHomeConfigTab(tab)) return { id: 'claude-config', tab }
  if (id === 'settings' && tab) return { id: 'claude-config', tab: `settings:${tab}` }
  return { id: 'claude-config', tab: target }
}

export const NAV_GROUP_BY_KEY: Partial<Record<NavKey, NavGroupLabel>> = {
  ...Object.fromEntries(NAV_ITEMS.map((item) => [item.key, item.group])),
  ...Object.fromEntries(Object.keys(NAV_KEY_ALIASES).map((k) => [k, 'Claude Code' as const])),
}

/**
 * True for a NavKey whose NAV_ITEMS entry is `faces: HOME` only (e.g. the
 * Settings-shaped editors consolidated onto Home, and the aliases folded
 * into Claude config — see this file's
 * top-of-file precedent note). Keys absent from NAV_ITEMS (editor, terminal,
 * etc.) are never home-only by this definition. Used by state/layout.ts's
 * `openPanel`/`focusPanel` to assert `navFace: 'home'` when routing to one
 * of these screens via a path that doesn't already know the face (e.g.
 * CommandPalette's `nav:*` commands, which are face-agnostic) — otherwise a
 * user with a project tab active could land on a Home-only screen while the
 * sidebar still renders the Project face's item list.
 */
export function isHomeOnlyNavKey(key: NavKey): boolean {
  const canonical = NAV_KEY_ALIASES[key] ? 'claude-config' : key
  const item = NAV_ITEMS.find((i) => i.key === canonical)
  return item != null && item.faces.length === 1 && item.faces[0] === 'home'
}

/**
 * Mirror of `isHomeOnlyNavKey` for `faces: PROJECT` entries (Project Home,
 * Sessions, Scheduler, Claude config). Same purpose, opposite
 * face: a face-agnostic route (CommandPalette's `nav:*`, the footer's
 * scheduler pill, Home's "Open Scheduler →" buttons) that lands on one of
 * these screens must assert `navFace: 'project'`, or the user ends up reading
 * a project-scoped screen with the Home sidebar beside it and no row lit.
 */
export function isProjectOnlyNavKey(key: NavKey): boolean {
  const item = NAV_ITEMS.find((i) => i.key === key)
  return item != null && item.faces.length === 1 && item.faces[0] === 'project'
}

export const NAV_GROUP_DESCRIPTIONS: Record<NavGroupLabel, string> = {
  Workspace: 'Where you do the work — sessions, files, and everything currently running.',
  'Claude Code': 'How Claude behaves — changes here apply to every session you start.',
  'Session Manager': 'This app\'s own preferences — voice, appearance, telemetry, updates.',
}
