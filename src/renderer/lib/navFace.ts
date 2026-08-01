/**
 * NavFace — which sidebar item set to render: 'home' (machine-level) or
 * 'project' (scoped to the active tab's project). Purely additive over the
 * existing NavKey routing; see navGroups.ts's `faces` tag and
 * `getNavItemsForFace`.
 *
 * Derived from the focused panel ALONE. It deliberately does NOT consider
 * whether a session tab is currently selected: `activeTabId === null` is a
 * legitimate, transient state (the Epics workspace renders with it by design
 * — see needsProjectsPanelReconciliation), so folding it in made the face
 * flip to 'home' mid-interaction. The whole nav item set would swap under the
 * user as they clicked — sometimes out from under the very item being clicked
 * — which read as the top-tab selection being lost and the sidebar "not
 * knowing which nav to load". The focused panel is the stable signal; tab
 * selection is mandatory and must never drive nav identity.
 */
export type NavFace = 'home' | 'project'

export function deriveNavFace(focusedPanelId: string | null): NavFace {
  return focusedPanelId === 'overview' ? 'home' : 'project'
}
