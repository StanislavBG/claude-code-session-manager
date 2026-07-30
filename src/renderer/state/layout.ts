import { create } from 'zustand'

/**
 * Panel registry entry. `component` is a lookup key (not a component
 * reference) so the store stays serializable and free of React imports —
 * Workbench.tsx owns the id → component mapping for rendering.
 */
export interface PanelDefinition {
  id: string
  title: string
  component: string
}

/**
 * Single-panel default: the whole app shell today is one dockview panel
 * hosting MainPane. Link 2 (screens-as-panels) grows this registry to one
 * entry per SCREEN_KEY.
 */
export const DEFAULT_LAYOUT: PanelDefinition[] = [
  { id: 'main', title: 'Session Manager', component: 'main' },
]

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
