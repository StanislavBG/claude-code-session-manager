import type { NavKey } from './navKey'
import { NAV_ITEMS } from './navGroups'

/**
 * Every NavKey MainPane can render as a full screen. Single source of truth
 * for App.tsx's navigation guard, layout.ts's panel registry, and the
 * screenComponents map — was three independently-maintained lists before
 * the Workbench per-screen-panel link; keep them merged.
 *
 * Adding a NavKey: append the literal to the NavKey union (lib/navKey.ts),
 * append it here, add a title to TITLE_OVERRIDES if it has no NAV_ITEMS
 * sidebar row, then handle it in screenComponents.tsx.
 */
export const SCREEN_KEYS: NavKey[] = [
  // Workspace
  'overview',
  'project-home',
  'terminal',
  'scheduler',
  'history',
  // Claude Code
  'memory',
  'claude-config',
  'projects',
  'system-prompt',
  'settings',
  'agent-library',
  'extensions',
  'app-settings',
  // In-app file editor (Files sidebar / terminal links route here).
  'editor',
]

// NavKeys with no AlmanacSidebar row (per navGroups.ts's own comment) have
// no label in NAV_ITEMS — supply a panel title for those explicitly.
// The four retired Home rows are aliases of 'claude-config' (see navGroups.ts
// NAV_KEY_ALIASES); their panels only exist for persisted dockview layouts.
const TITLE_OVERRIDES: Partial<Record<NavKey, string>> = {
  editor: 'Editor',
  'system-prompt': 'Claude config',
  settings: 'Claude config',
  extensions: 'Claude config',
  'agent-library': 'Claude config',
}

const NAV_ITEM_TITLE_BY_KEY: Partial<Record<NavKey, string>> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key, item.label]),
)

export const SCREEN_TITLES: Record<NavKey, string> = Object.fromEntries(
  SCREEN_KEYS.map((key) => [key, TITLE_OVERRIDES[key] ?? NAV_ITEM_TITLE_BY_KEY[key] ?? key]),
) as Record<NavKey, string>
