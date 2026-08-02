/**
 * NavKey union — the routing alphabet for every Workspace + Configure tab.
 *
 * Lives in its own file (formerly the LeftNav component too) so every
 * consumer can import `type NavKey` without dragging in the React tree. The
 * old LeftNav React component was removed in the Almanac re-skin — its
 * responsibilities moved into `components/layout/AlmanacSidebar.tsx`.
 *
 * Adding a NavKey: append the literal below, add it to `SCREEN_KEYS` in
 * lib/screenKeys.ts, then handle it in screenComponents.tsx's
 * renderScreenComponent switch.
 */
export type NavKey =
  | 'overview'
  | 'project-home'
  | 'terminal'
  | 'browser'
  | 'system-prompt'
  | 'settings'
  | 'permissions'
  | 'skills'
  | 'plugins'
  | 'mcp'
  | 'hooks'
  | 'memory'
  | 'projects'
  | 'history'
  | 'keybindings'
  // Two faces, genuinely different content (see lib/navGroups.ts's
  // labelByFace): Home shows global scheduler policy + session-pool
  // controls ("Scheduler Configs" — formerly the standalone 'sm-config'
  // key, folded in here); Project shows this project's live PRD queue
  // ("Epic's Execution Queue").
  | 'scheduler'
  // In-app file editor scene. Launched from the Files sidebar + terminal links
  // (no left-nav row of its own — Files is the launch point).
  | 'editor'
  // v0.13.1 — pop-ups promoted to full pages. Every former Tools-group modal
  // also gets a NavKey + MainPane screen. Screens render the same modal
  // components with variant="page" so the body content is unchanged.
  | 'voice'
  | 'repoviz'
  | 'search'
  | 'remote'
  // Read-only directory of global + per-project agent personas (Home face only).
  | 'agent-library'
  // Read-only directory of the Epic intent-tag taxonomy (Home face only).
  | 'tag-library'
