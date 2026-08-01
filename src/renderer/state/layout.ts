import { create } from 'zustand'
import { SCREEN_KEYS, SCREEN_TITLES } from '../lib/screenKeys'

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
   * Register (or focus, if already registered) a panel from an app-driven
   * action (sidebar click, command palette, etc.) — always bumps
   * `focusToken` so Workbench re-mounts/re-activates even for a same-id call.
   */
  openPanel: (id: string) => void
  /**
   * Mirror a dockview-initiated activation (tab click, close, drag) into the
   * store. No-op if the id isn't registered. Does not bump `focusToken` —
   * dockview has already made the panel active, no re-mount is needed.
   */
  focusPanel: (id: string) => void
  /** Reset the workbench to DEFAULT_LAYOUT (CommandPalette "Reset layout"). */
  resetLayout: () => void
}

export const useLayout = create<LayoutState>((set, get) => ({
  panels: [...DEFAULT_LAYOUT],
  focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
  focusToken: 0,
  resetToken: 0,
  openPanel: (id: string) => {
    const exists = get().panels.some((p) => p.id === id)
    if (!exists) return
    set((s) => ({ focusedPanelId: id, focusToken: s.focusToken + 1 }))
  },
  focusPanel: (id: string) => {
    const exists = get().panels.some((p) => p.id === id)
    if (!exists) return
    set({ focusedPanelId: id })
  },
  resetLayout: () => {
    set((s) => ({
      resetToken: s.resetToken + 1,
      focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
      focusToken: s.focusToken + 1,
    }))
  },
}))

export function getPanelDefinition(id: string): PanelDefinition | undefined {
  return useLayout.getState().panels.find((p) => p.id === id)
}

/**
 * 'projects' (File Explorer, ProjectsWorkspace.tsx) renders `useSessions()`'s
 * `activeTab` and dead-ends on a bare "No session selected." with no way
 * back when there is none — reachable whenever the last session tab closes,
 * or App.tsx's explicit `activeTabId: null` resets (navigate('terminal'),
 * handleNewSession) fire while 'projects' is still the focused panel. Pure
 * predicate (no store reads) so App.tsx's reconciliation effect is
 * unit-testable without mounting App. Scoped to 'projects' only — 'terminal'
 * (Epics workspace) intentionally renders with activeTabId === null, and
 * 'browser'/'editor' own independent tab-id state, not session activeTabId.
 */
export function needsProjectsPanelReconciliation(
  focusedPanelId: string | null,
  activeTabId: string | null,
): boolean {
  return focusedPanelId === 'projects' && activeTabId === null
}

/** True when `panelId` is the workbench's currently active panel. */
export function usePanelFocus(panelId: string): boolean {
  return useLayout((s) => s.focusedPanelId === panelId)
}
