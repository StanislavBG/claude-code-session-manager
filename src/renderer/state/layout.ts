import { create } from 'zustand'
import { SCREEN_KEYS, SCREEN_TITLES } from '../lib/screenKeys'
import { readAppPrefs } from '../lib/appPrefs'
import type { NavFace } from '../lib/navFace'
import { isHomeOnlyNavKey, isProjectOnlyNavKey } from '../lib/navGroups'
import type { NavKey } from '../components/LeftNav'

/**
 * Panel registry entry. `component` is a lookup key (not a component
 * reference) so the store stays serializable and free of React imports —
 * Workbench.tsx owns the id → component mapping for rendering. `screenKeys`
 * is the same React-free module App.tsx and screenComponents.tsx build on,
 * so this registry, the nav guard, and the render map can never drift apart.
 */
export interface PanelDefinition {
  id: string
  title: string
  component: string
}

/**
 * One entry per NavKey screen (link 2 of the Workbench chain). Since link 3,
 * dockview can show several of these panels at once, side by side — the
 * registry existing per-screen is what lets openPanel/focusPanel address any
 * screen by id regardless of how many are currently visible.
 */
export const DEFAULT_LAYOUT: PanelDefinition[] = SCREEN_KEYS.map((id) => ({
  id,
  title: SCREEN_TITLES[id],
  component: 'screen',
}))

interface LayoutState {
  panels: PanelDefinition[]
  focusedPanelId: string | null
  /**
   * Bumped on every `openPanel` call, including ones that leave
   * `focusedPanelId` unchanged. Workbench.tsx keys its mount effect off this
   * token (not the id) so a sidebar click that re-opens the id the store
   * already holds still re-activates the dockview panel. Without it,
   * `openPanel('terminal')` right after a dockview-initiated activation of
   * another panel (tab click/close/drag, mirrored in via `focusPanel`) could
   * write the same id the store already had — a same-value `set()` triggers
   * no re-render, so the effect never re-runs and the click is a silent
   * no-op.
   */
  focusToken: number
  /**
   * Bumped by `resetLayout` only. Workbench.tsx watches this (skipping the
   * initial mount value) to imperatively clear the live DockviewApi and
   * remount the default panel — a store flag is how the CommandPalette
   * (which has no reference to the live DockviewApi) reaches into Workbench.
   */
  resetToken: number
  /**
   * True when the Epics workspace should be shown in place of the active
   * SessionTab's terminal, on the 'terminal' destination.
   *
   * This exists because "show the Epics workspace" used to be encoded as
   * `activeTabId === null`, so navigating to Epics had to DESELECT the top
   * tab (App.tsx's `useSessions.setState({ activeTabId: null })`). That broke
   * the invariant that a top-tab selection is mandatory: clicking a left-nav
   * item dropped the selection, which in turn made downstream consumers that
   * key off the active tab flip mid-interaction. Making the intent explicit
   * lets nav change what is DISPLAYED without ever mutating what is SELECTED.
   */
  epicsWorkspaceOpen: boolean
  /** Show/hide the Epics workspace over the terminal. Never touches tab selection. */
  setEpicsWorkspaceOpen: (open: boolean) => void
  /**
   * Which sidebar item set + scope default is showing: 'home' (machine-level)
   * or 'project' (scoped to the active tab's project). See lib/navFace.ts.
   *
   * Deliberately NOT derived from `focusedPanelId` per-render (that was the
   * bug: most screens — Scheduler, Hooks, Skills, System Prompt, etc. — are
   * shared by both faces, so "any panel other than overview" is not a valid
   * definition of 'project'; it flipped the face the instant you clicked a
   * Home-face row for one of those shared screens). Instead this is real
   * state, changed only by the two genuine entry points: `openPanel` flips it
   * to 'home' when navigating TO 'overview' (the one screen that is
   * unambiguously home) OR to any other HOME-only NavKey per
   * `lib/navGroups.ts`'s `isHomeOnlyNavKey` (System Prompt, Skills, MCP
   * Servers, Hooks, Permissions, Settings — consolidated onto Home; see
   * that file's top-of-file precedent note) — this covers face-agnostic
   * entry points like CommandPalette's `nav:*` commands, which don't know
   * or assert a face themselves. `openPanel` applies the MIRROR
   * rule for a PROJECT-only NavKey (`isProjectOnlyNavKey`: Project Home,
   * Sessions, Scheduler, Memory, Host on Bilko.run) and flips to 'project' —
   * otherwise a face-agnostic route onto one of those (Home's "Open Scheduler
   * →" buttons, the footer's paused-scheduler pill, `nav:scheduler` in the
   * palette) would render a cwd-scoped screen beside the Home sidebar with no
   * row lit. `openProjectPanel` flips to 'project' unconditionally and is used
   * by the top-tab-selection call sites (TabBar tab click, tab-switch effect,
   * new-session flows). Only a BOTH-face id (File Explorer) leaves the face
   * untouched, so browsing either nav list stays on that face end to end. See
   * navFace.spec.ts's regression coverage.
   */
  navFace: NavFace
  setNavFace: (face: NavFace) => void
  /**
   * Register (or focus, if already registered) a panel from an app-driven
   * action (sidebar click, command palette, etc.) — always bumps
   * `focusToken` so Workbench re-mounts/re-activates even for a same-id call.
   * Sets `navFace: 'home'` when `id === 'overview'` or `id` is a HOME-only
   * NavKey (`isHomeOnlyNavKey`); leaves navFace untouched for every other id
   * (see `navFace` above / `openProjectPanel` below).
   */
  openPanel: (id: string) => void
  /**
   * Like `openPanel`, but also asserts `navFace: 'project'`. Use this at the
   * genuine "the user selected/activated a project tab" sites (TabBar tab
   * click, the pure-tab-switch effect, new-session flows) — never from
   * sidebar/command-palette navigation, which must preserve whichever face
   * the user is currently browsing.
   */
  openProjectPanel: (id: string) => void
  /**
   * Mirror a dockview-initiated activation (tab click, close, drag) into the
   * store. No-op if the id isn't registered. Does not bump `focusToken` —
   * dockview has already made the panel active, no re-mount is needed. Same
   * navFace rule as `openPanel`: 'overview' or a HOME-only NavKey asserts
   * 'home'.
   */
  focusPanel: (id: string) => void
  /** Reset the workbench to DEFAULT_LAYOUT (CommandPalette "Reset layout"). */
  resetLayout: () => void
  /**
   * Boot-time hydration step (called once from App.tsx): reads
   * app-prefs.json and, when `openToHomeOnLaunch` is true, focuses
   * 'overview'. A no-op — leaving `focusedPanelId` at its unmodified
   * default — when the pref is absent or false, when read fails, or when
   * the user has already navigated away from the initial default panel
   * before the (async, IPC-bound) read resolves — never stomps a live
   * navigation.
   */
  hydrateOpenToHomePref: () => Promise<void>
}

/**
 * The one place `openPanel`/`focusPanel` decide whether routing to `id` also
 * asserts a sidebar face. Home-only key (or 'overview') → 'home'; project-only
 * key → 'project'; BOTH-face key → no patch, the current face is preserved.
 * Returns a spreadable partial so a `set()` can apply it inline.
 */
function navFacePatch(id: string): { navFace?: NavFace } {
  if (id === 'overview' || isHomeOnlyNavKey(id as NavKey)) return { navFace: 'home' }
  if (isProjectOnlyNavKey(id as NavKey)) return { navFace: 'project' }
  return {}
}

export const useLayout = create<LayoutState>((set, get) => ({
  panels: [...DEFAULT_LAYOUT],
  focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
  focusToken: 0,
  resetToken: 0,
  epicsWorkspaceOpen: false,
  setEpicsWorkspaceOpen: (open: boolean) => set({ epicsWorkspaceOpen: open }),
  navFace: 'home',
  setNavFace: (face: NavFace) => set({ navFace: face }),
  openPanel: (id: string) => {
    const exists = get().panels.some((p) => p.id === id)
    if (!exists) return
    set((s) => ({
      focusedPanelId: id,
      focusToken: s.focusToken + 1,
      ...navFacePatch(id),
    }))
  },
  openProjectPanel: (id: string) => {
    const exists = get().panels.some((p) => p.id === id)
    if (!exists) return
    set((s) => ({ focusedPanelId: id, focusToken: s.focusToken + 1, navFace: 'project' }))
  },
  focusPanel: (id: string) => {
    const exists = get().panels.some((p) => p.id === id)
    if (!exists) return
    set({
      focusedPanelId: id,
      ...navFacePatch(id),
    })
  },
  resetLayout: () => {
    set((s) => ({
      resetToken: s.resetToken + 1,
      focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
      focusToken: s.focusToken + 1,
      navFace: 'home',
    }))
  },
  hydrateOpenToHomePref: async () => {
    const prefs = await readAppPrefs()
    // Only apply if focusedPanelId is still at its unmodified boot default —
    // if the user (or another boot effect) already navigated during this
    // async read, their choice wins; the pref never overrides a live nav.
    if (prefs.openToHomeOnLaunch === true && get().focusedPanelId === (DEFAULT_LAYOUT[0]?.id ?? null)) {
      set({ focusedPanelId: 'overview', navFace: 'home' })
    }
  },
}))

export function getPanelDefinition(id: string): PanelDefinition | undefined {
  return useLayout.getState().panels.find((p) => p.id === id)
}

/**
 * 'projects' (File Explorer, ProjectsWorkspace.tsx) used to dead-end on a
 * bare "No session selected." with no way back whenever `activeTabId` was
 * null — reachable when the last session tab closes, or App.tsx's explicit
 * `activeTabId: null` resets (navigate('terminal'), handleNewSession) fire
 * while 'projects' is still focused. File Explorer is now a BOTH-face
 * screen (see lib/navGroups.ts): on the Home face it roots at the OS home
 * directory and never depends on `activeTab`, so the dead-end can only
 * happen on the Project face — `navFace` scopes the guard accordingly.
 * Pure predicate (no store reads) so App.tsx's reconciliation effect is
 * unit-testable without mounting App. Scoped to 'projects' only — 'terminal'
 * (Epics workspace) intentionally renders with activeTabId === null, and
 * 'editor' owns independent tab-id state, not session activeTabId.
 */
export function needsProjectsPanelReconciliation(
  focusedPanelId: string | null,
  activeTabId: string | null,
  navFace: NavFace = 'project',
): boolean {
  return focusedPanelId === 'projects' && activeTabId === null && navFace === 'project'
}

/** True when `panelId` is the workbench's currently active panel. */
export function usePanelFocus(panelId: string): boolean {
  return useLayout((s) => s.focusedPanelId === panelId)
}
