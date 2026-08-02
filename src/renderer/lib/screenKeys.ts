import type { NavKey } from '../components/LeftNav'
import { NAV_ITEMS } from './navGroups'

/**
 * Every NavKey MainPane can render as a full screen. Single source of truth
 * for App.tsx's navigation guard, layout.ts's panel registry, and the
 * screenComponents map — was three independently-maintained lists before
 * the Workbench per-screen-panel link; keep them merged.
 *
 * Adding a NavKey: append the literal to the NavKey union (LeftNav.tsx),
 * append it here, add a title to TITLE_OVERRIDES if it has no NAV_ITEMS
 * sidebar row, then handle it in screenComponents.tsx.
 */
export const SCREEN_KEYS: NavKey[] = [
  // Workspace
  'overview',
  'project-home',
  'terminal',
  'browser',
  'scheduler',
  'history',
  // Configure
  'skills',
  'plugins',
  'mcp',
  'hooks',
  'keybindings',
  'memory',
  'projects',
  'system-prompt',
  'permissions',
  'settings',
  'remote',
  'agent-library',
  'tag-library',
  // Tools (promoted from modal in v0.13.1)
  'voice',
  'repoviz',
  'search',
  // In-app file editor (Files sidebar / terminal links route here).
  'editor',
]

// NavKeys with no AlmanacSidebar row (per navGroups.ts's own comment) have
// no label in NAV_ITEMS — supply a panel title for those explicitly.
const TITLE_OVERRIDES: Partial<Record<NavKey, string>> = {
  editor: 'Editor',
}

const NAV_ITEM_TITLE_BY_KEY: Partial<Record<NavKey, string>> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.label]),
)

export const SCREEN_TITLES: Record<NavKey, string> = Object.fromEntries(
  SCREEN_KEYS.map((key) => [key, TITLE_OVERRIDES[key] ?? NAV_ITEM_TITLE_BY_KEY[key] ?? key]),
) as Record<NavKey, string>
