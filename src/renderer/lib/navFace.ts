/**
 * NavFace — which sidebar item set + scope default to render: 'home'
 * (machine-level) or 'project' (scoped to the active tab's project). Purely
 * additive over the existing NavKey routing; see navGroups.ts's `faces` tag
 * and `getNavItemsForFace`.
 *
 * This is real state, not derived per-render — see `state/layout.ts`'s
 * `navFace` field for why. (It used to be `focusedPanelId === 'overview' ?
 * 'home' : 'project'`, which looked stable but wasn't: most screens —
 * Scheduler, Hooks, Skills, System Prompt, etc. — are shared by both faces,
 * so browsing a Home-face row for one of those flipped the face the instant
 * you clicked it, because its `focusedPanelId` isn't 'overview' either. User
 * report: Home-tab sections "all redirect towards an open Project" the
 * moment you click into one.) Read `useLayout((s) => s.navFace)` directly
 * instead of deriving it.
 */
export type NavFace = 'home' | 'project'
