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
 * `NavKey`s that render their own chrome and have no sidebar row (overview,
 * terminal, browser, projects, editor) are intentionally absent. `overview`
 * (the machine-wide Home) is reached only via the fixed TabBar home chip, not
 * a sidebar row — `project-home` (the per-project Brief) took its row.
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
}

const HOME: NavFace[] = ['home']
const PROJECT: NavFace[] = ['project']
const BOTH: NavFace[] = ['home', 'project']

export const NAV_ITEMS: NavGroupItem[] = [
  // Workspace
  { key: 'project-home', group: 'Workspace', label: 'Home',     icon: 'home',         hint: 'What this project is, and what is in flight', faces: PROJECT },
  { key: 'terminal',   group: 'Workspace', label: 'Epics',      icon: 'terminal',     hint: 'Independent goal-scoped Epics, grouped by project', faces: BOTH },
  { key: 'browser',    group: 'Workspace', label: 'Browser',    icon: 'browser',      hint: 'Embedded dev browser — capture DOM, record click-sequences', faces: HOME },
  { key: 'projects',   group: 'Workspace', label: 'File Explorer', icon: 'projects',  hint: 'Browse files + edit — starts at your home folder from Home, the active project from a Tab', faces: BOTH },
  { key: 'scheduler',  group: 'Workspace', label: 'Scheduler',  icon: 'scheduler',    liveKind: 'scheduler', hint: 'Author PRDs + run them as claude -p jobs', faces: BOTH },
  { key: 'history',    group: 'Workspace', label: 'History',    icon: 'history',      hint: 'Every session, ever — resumable', faces: BOTH },

  // Configure
  { key: 'system-prompt', group: 'Configure', label: 'System Prompt', icon: 'system-prompt', hint: 'Personality and behavior', faces: BOTH },
  { key: 'skills',        group: 'Configure', label: 'Skills',         icon: 'skills',         hint: 'Reusable instructions Claude loads', faces: BOTH },
  { key: 'plugins',       group: 'Configure', label: 'Plugins',        icon: 'plugins',        hint: 'Extensions for Claude Code', faces: HOME },
  { key: 'mcp',            group: 'Configure', label: 'MCP Servers',    icon: 'mcp',            hint: 'External tools and integrations', faces: BOTH },
  { key: 'hooks',          group: 'Configure', label: 'Hooks',          icon: 'hooks',          hint: 'Run scripts on session events', faces: BOTH },
  { key: 'keybindings',    group: 'Configure', label: 'Keybindings',    icon: 'keys',           hint: 'Shortcuts you can override', faces: HOME },
  { key: 'memory',         group: 'Configure', label: 'Memory',         icon: 'memory',         hint: 'Workspace memory store', faces: PROJECT },
  { key: 'permissions',    group: 'Configure', label: 'Permissions',    icon: 'permissions',    hint: 'Allow / deny rules', faces: BOTH },
  { key: 'settings',       group: 'Configure', label: 'Settings',       icon: 'settings',       hint: 'Theme, voice, billing window', faces: BOTH },
  { key: 'remote',         group: 'Configure', label: 'Remote',         icon: 'remote',         hint: 'Web remote control — disabled by default', faces: HOME },
  { key: 'sm-config',      group: 'Configure', label: 'Session-Manager', icon: 'settings',      hint: 'Global session pool, guardrails, scheduler policy', faces: HOME },

  // Tools
  { key: 'voice',    group: 'Tools', label: 'Voice',    icon: 'mic',           hint: 'Whisper transcription + push-to-talk', faces: HOME },
  { key: 'repoviz',  group: 'Tools', label: 'Repo Viz', icon: 'repoviz',       hint: 'Language + directory map', faces: PROJECT },
  { key: 'search',   group: 'Tools', label: 'Search',   icon: 'global-search', hint: '⌘P file · ⌘⇧F content', faces: PROJECT },
]

/** Filters NAV_ITEMS by sidebar face, preserving NAV_ITEMS' existing group order. */
export function getNavItemsForFace(face: NavFace): NavGroupItem[] {
  return NAV_ITEMS.filter((item) => item.faces.includes(face))
}

export const NAV_GROUP_BY_KEY: Partial<Record<NavKey, NavGroupLabel>> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.group]),
)

export const NAV_GROUP_DESCRIPTIONS: Record<NavGroupLabel, string> = {
  Workspace: 'Where you do the work — sessions, files, and everything currently running.',
  Configure: 'How Claude behaves — changes here apply to every session you start.',
  Tools: 'One-off utilities — not configuration, just things you reach for sometimes.',
}
