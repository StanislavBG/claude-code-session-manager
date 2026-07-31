import type { NavKey } from '../components/LeftNav'
import type { AlmanacIconName } from '../components/layout/AlmanacIcon'

/**
 * Single source of truth for the three-way nav taxonomy (Workspace /
 * Configure / Tools) over `NavKey`. Drives both AlmanacSidebar's grouped
 * rows and MainPane's per-page eyebrow — a `NavKey` can only be assigned to
 * one group here, so the sidebar section and the page eyebrow can never
 * disagree.
 *
 * `NavKey`s that render their own chrome and have no sidebar row (overview,
 * terminal, browser, projects, editor) are intentionally absent.
 */
export type NavGroupLabel = 'Workspace' | 'Configure' | 'Tools'

export interface NavGroupItem {
  key: NavKey
  group: NavGroupLabel
  label: string
  icon: AlmanacIconName
  liveKind?: 'scheduler'
  hint?: string
}

export const NAV_ITEMS: NavGroupItem[] = [
  // Workspace
  { key: 'overview',   group: 'Workspace', label: 'Home',       icon: 'home',         hint: "Today's sessions + the 5-hour window" },
  { key: 'terminal',   group: 'Workspace', label: 'Epics',      icon: 'terminal',     hint: 'Independent goal-scoped Epics, grouped by project' },
  { key: 'browser',    group: 'Workspace', label: 'Browser',    icon: 'browser',      hint: 'Embedded dev browser — capture DOM, record click-sequences' },
  { key: 'projects',   group: 'Workspace', label: 'File Explorer', icon: 'projects',  hint: 'Browse files + edit, per project' },
  { key: 'scheduler',  group: 'Workspace', label: 'Scheduler',  icon: 'scheduler',    liveKind: 'scheduler', hint: 'Author PRDs + run them as claude -p jobs' },
  { key: 'history',    group: 'Workspace', label: 'History',    icon: 'history',      hint: 'Every session, ever — resumable' },

  // Configure
  { key: 'system-prompt', group: 'Configure', label: 'System Prompt', icon: 'system-prompt', hint: 'Personality and behavior' },
  { key: 'skills',        group: 'Configure', label: 'Skills',         icon: 'skills',         hint: 'Reusable instructions Claude loads' },
  { key: 'plugins',       group: 'Configure', label: 'Plugins',        icon: 'plugins',        hint: 'Extensions for Claude Code' },
  { key: 'mcp',            group: 'Configure', label: 'MCP Servers',    icon: 'mcp',            hint: 'External tools and integrations' },
  { key: 'hooks',          group: 'Configure', label: 'Hooks',          icon: 'hooks',          hint: 'Run scripts on session events' },
  { key: 'keybindings',    group: 'Configure', label: 'Keybindings',    icon: 'keys',           hint: 'Shortcuts you can override' },
  { key: 'memory',         group: 'Configure', label: 'Memory',         icon: 'memory',         hint: 'Workspace memory store' },
  { key: 'permissions',    group: 'Configure', label: 'Permissions',    icon: 'permissions',    hint: 'Allow / deny rules' },
  { key: 'settings',       group: 'Configure', label: 'Settings',       icon: 'settings',       hint: 'Theme, voice, billing window' },
  { key: 'remote',         group: 'Configure', label: 'Remote',         icon: 'remote',         hint: 'Web remote control — disabled by default' },

  // Tools
  { key: 'voice',    group: 'Tools', label: 'Voice',    icon: 'mic',           hint: 'Whisper transcription + push-to-talk' },
  { key: 'repoviz',  group: 'Tools', label: 'Repo Viz', icon: 'repoviz',       hint: 'Language + directory map' },
  { key: 'search',   group: 'Tools', label: 'Search',   icon: 'global-search', hint: '⌘P file · ⌘⇧F content' },
]

export const NAV_GROUP_BY_KEY: Partial<Record<NavKey, NavGroupLabel>> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.group]),
)

export const NAV_GROUP_DESCRIPTIONS: Record<NavGroupLabel, string> = {
  Workspace: 'Where you do the work — sessions, files, and everything currently running.',
  Configure: 'How Claude behaves — changes here apply to every session you start.',
  Tools: 'One-off utilities — not configuration, just things you reach for sometimes.',
}
