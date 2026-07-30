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
 * One entry per NavKey screen (link 2 of the Workbench chain). MainPane
 * still hosts exactly one visible screen at a time — the registry existing
 * per-screen is what lets openPanel/focusPanel address any screen by id;
 * side-by-side/multi-panel rendering is link 3.
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
   * Register (or focus, if already registered) a panel. With only the
   * 'main' panel in the registry this is a no-op beyond focusing — the API
   * surface exists for link 2 to build on.
   */
  openPanel: (id: string) => void
  /** Mark a panel as focused. No-op if the id isn't registered. */
  focusPanel: (id: string) => void
}

export const useLayout = create<LayoutState>((set, get) => ({
  panels: DEFAULT_LAYOUT,
  focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
  openPanel: (id: string) => {
    const exists = get().panels.some((p) => p.id === id)
    if (!exists) return
    set({ focusedPanelId: id })
  },
  focusPanel: (id: string) => {
    const exists = get().panels.some((p) => p.id === id)
    if (!exists) return
    set({ focusedPanelId: id })
  },
}))

export function getPanelDefinition(id: string): PanelDefinition | undefined {
  return DEFAULT_LAYOUT.find((p) => p.id === id)
}
