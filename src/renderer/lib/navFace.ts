/**
 * NavFace — which sidebar item set to render: 'home' (machine-level, no tab
 * focused) or 'project' (scoped to the active tab's project). Purely additive
 * over the existing NavKey routing; see navGroups.ts's `faces` tag and
 * `getNavItemsForFace`.
 */
export type NavFace = 'home' | 'project'

export function deriveNavFace(focusedPanelId: string | null, hasActiveTab: boolean): NavFace {
  if (focusedPanelId === 'overview' || !hasActiveTab) return 'home'
  return 'project'
}
