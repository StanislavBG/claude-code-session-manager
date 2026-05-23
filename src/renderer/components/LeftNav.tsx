/**
 * NavKey union — the routing alphabet for every Workspace + Configure tab.
 *
 * Lives in its own file (formerly the LeftNav component too) so every
 * consumer can import `type NavKey` without dragging in the React tree. The
 * old LeftNav React component was removed in the Almanac re-skin — its
 * responsibilities moved into `components/layout/AlmanacSidebar.tsx`.
 *
 * Adding a NavKey: append the literal below, add the screen to
 * `SCREEN_KEYS` in App.tsx, then handle it in MainPane.renderScreen.
 */
export type NavKey =
  | 'overview'
  | 'terminal'
  | 'system-prompt'
  | 'settings'
  | 'permissions'
  | 'skills'
  | 'plugins'
  | 'mcp'
  | 'hooks'
  | 'subagents'
  | 'plans'
  | 'tasks'
  | 'memory'
  | 'projects'
  | 'history'
  | 'keybindings'
  | 'usage'
  | 'agent-view'
  | 'doc-editor'
  | 'agent-memory'
  | 'scheduler'
