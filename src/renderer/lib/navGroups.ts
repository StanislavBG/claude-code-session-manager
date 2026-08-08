import type { NavKey } from '../components/LeftNav'
import type { AlmanacIconName } from '../components/layout/AlmanacIcon'
import type { NavFace } from './navFace'

/**
 * Single source of truth for the three-way nav taxonomy (Workspace /
 * Configure / Tools) over `NavKey`. Drives both AlmanacSidebar's grouped
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
export type NavGroupLabel = 'Workspace' | 'Configure' | 'Tools'

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
  { key: 'overview',     group: 'Workspace', label: 'Dashboard', icon: 'home',        hint: 'This machine — every project, every active session', faces: HOME },
  { key: 'project-home', group: 'Workspace', label: 'Project Home', icon: 'home',     hint: 'What this project is, and what is in flight', faces: PROJECT },
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
  { key: 'history',    group: 'Workspace', label: 'History',    icon: 'history',      hint: 'Every session, ever — resumable', faces: HOME },

  // Configure
  { key: 'system-prompt', group: 'Configure', label: 'System Prompt', icon: 'system-prompt', hint: 'Personality and behavior', faces: HOME },
  { key: 'skills',        group: 'Configure', label: 'Skills',         icon: 'skills',         hint: 'Reusable instructions Claude loads', faces: HOME },
  { key: 'plugins',       group: 'Configure', label: 'Plugins',        icon: 'plugins',        hint: 'Extensions for Claude Code', faces: HOME },
  { key: 'mcp',            group: 'Configure', label: 'MCP Servers',    icon: 'mcp',            hint: 'External tools and integrations', faces: HOME },
  { key: 'hooks',          group: 'Configure', label: 'Hooks',          icon: 'hooks',          hint: 'Run scripts on session events', faces: HOME },
  { key: 'memory',         group: 'Configure', label: 'Memory',         icon: 'memory',         hint: 'Workspace memory store', faces: PROJECT },
  { key: 'permissions',    group: 'Configure', label: 'Permissions',    icon: 'permissions',    hint: 'Allow / deny rules', faces: HOME },
  { key: 'settings',       group: 'Configure', label: 'Settings',       icon: 'settings',       hint: 'Theme, voice, billing window — per-session model lives in Agent Library', faces: HOME },
  { key: 'agent-library',  group: 'Configure', label: 'Agent Library',  icon: 'book',           hint: 'Agent personas available to this machine, and which projects override them', faces: HOME },
  { key: 'tag-library',    group: 'Configure', label: 'Tag Library',    icon: 'target',         hint: 'Session intent tags and their /develop behavior', faces: HOME },
  { key: 'bilko-host',     group: 'Configure', label: 'Host on Bilko.run', icon: 'link',        hint: 'Publish this project\'s Marketing page to bilko.run', faces: PROJECT },

  // Tools
  { key: 'voice',    group: 'Tools', label: 'Voice',    icon: 'mic',           hint: 'Whisper transcription + push-to-talk', faces: HOME },
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

export const NAV_GROUP_BY_KEY: Partial<Record<NavKey, NavGroupLabel>> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.group]),
)

/**
 * True for a NavKey whose NAV_ITEMS entry is `faces: HOME` only (e.g. the
 * six Settings-shaped editors consolidated onto Home — see this file's
 * top-of-file precedent note). Keys absent from NAV_ITEMS (editor, terminal,
 * etc.) are never home-only by this definition. Used by state/layout.ts's
 * `openPanel`/`focusPanel` to assert `navFace: 'home'` when routing to one
 * of these screens via a path that doesn't already know the face (e.g.
 * CommandPalette's `nav:*` commands, which are face-agnostic) — otherwise a
 * user with a project tab active could land on a Home-only screen while the
 * sidebar still renders the Project face's item list.
 */
export function isHomeOnlyNavKey(key: NavKey): boolean {
  const item = NAV_ITEMS.find((i) => i.key === key)
  return item != null && item.faces.length === 1 && item.faces[0] === 'home'
}

/**
 * Mirror of `isHomeOnlyNavKey` for `faces: PROJECT` entries (Project Home,
 * Sessions, Scheduler, Memory, Host on Bilko.run). Same purpose, opposite
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
  Configure: 'How Claude behaves — changes here apply to every session you start.',
  Tools: 'One-off utilities — not configuration, just things you reach for sometimes.',
}
