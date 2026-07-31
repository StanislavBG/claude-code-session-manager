import type { SerializedDockview } from 'dockview-react'
import type { LayoutEnvelope } from '../../preload/api'

/**
 * Pure (no DockviewApi, no IPC) helpers for the Workbench layout persistence
 * link — kept separate from Workbench.tsx so serialize/prune/validate logic
 * is unit-testable without mounting real dockview. Workbench.tsx is the only
 * caller that touches a live `DockviewApi`; everything here operates on
 * plain JSON.
 */

export const CURRENT_LAYOUT_VERSION = 1

type SerializedGridLeaf = { type: 'leaf'; data: { views: string[]; activeView?: string; id: string } & Record<string, unknown>; size?: number; visible?: boolean }
type SerializedGridBranch = { type: 'branch'; data: SerializedGridNode[]; size?: number; visible?: boolean }
type SerializedGridNode = SerializedGridLeaf | SerializedGridBranch

/** Builds a save-able envelope from a live `api.toJSON()` blob. Returns null
 * (refusing the save) when the layout has zero panels — a system default
 * that's never persisted is preferable to bricking the next boot with an
 * empty grid. */
export function buildLayoutEnvelope(dockview: SerializedDockview): LayoutEnvelope | null {
  const panels = Object.keys(dockview.panels ?? {})
  if (panels.length === 0) return null
  return {
    version: CURRENT_LAYOUT_VERSION,
    panels,
    dockview: dockview as unknown as Record<string, unknown>,
  }
}

function pruneGroupViews<T extends { views: string[]; activeView?: string }>(
  data: T,
  validIds: Set<string>,
): T | null {
  const views = data.views.filter((id) => validIds.has(id))
  if (views.length === 0) return null
  const activeView = data.activeView && views.includes(data.activeView) ? data.activeView : views[0]
  return { ...data, views, activeView }
}

function pruneGridNode(node: SerializedGridNode, validIds: Set<string>): SerializedGridNode | null {
  if (node.type === 'leaf') {
    const data = pruneGroupViews(node.data, validIds)
    if (!data) return null
    return { ...node, data }
  }
  const children = node.data.map((child) => pruneGridNode(child, validIds)).filter((c): c is SerializedGridNode => c !== null)
  if (children.length === 0) return null
  return { ...node, data: children }
}

/**
 * Drops any panel id not present in `knownIds` (e.g. a future screen
 * rename) from the dockview blob — from the top-level `panels` map, every
 * group's `views` list, and floating/popout groups — then re-derives the
 * grid tree, collapsing any group left with zero views. Returns null if
 * nothing valid remains (caller falls back to DEFAULT_LAYOUT).
 */
export function pruneUnknownPanels(dockview: SerializedDockview, knownIds: Set<string>): SerializedDockview | null {
  const allIds = Object.keys(dockview.panels ?? {})
  const validIds = new Set(allIds.filter((id) => knownIds.has(id)))
  if (validIds.size === 0) return null

  const root = pruneGridNode(dockview.grid.root as unknown as SerializedGridNode, validIds)
  if (!root) return null

  const prunedPanels: SerializedDockview['panels'] = {}
  for (const id of validIds) prunedPanels[id] = dockview.panels[id]

  const floatingGroups = (dockview.floatingGroups ?? [])
    .map((fg) => {
      const data = pruneGroupViews(fg.data as unknown as { views: string[]; activeView?: string }, validIds)
      return data ? { ...fg, data: data as typeof fg.data } : null
    })
    .filter((fg): fg is NonNullable<typeof fg> => fg !== null)

  const popoutGroups = (dockview.popoutGroups ?? [])
    .map((pg) => {
      const data = pruneGroupViews(pg.data as unknown as { views: string[]; activeView?: string }, validIds)
      return data ? { ...pg, data: data as typeof pg.data } : null
    })
    .filter((pg): pg is NonNullable<typeof pg> => pg !== null)

  return {
    ...dockview,
    grid: { ...dockview.grid, root: root as unknown as SerializedDockview['grid']['root'] },
    panels: prunedPanels,
    floatingGroups,
    popoutGroups,
    activeGroup: dockview.activeGroup,
  }
}

/**
 * Validates + prunes a persisted envelope against the live screen registry.
 * Returns the ready-to-`fromJSON` dockview blob, or null when the envelope
 * is malformed / nothing valid survives pruning (caller falls back to
 * DEFAULT_LAYOUT).
 */
export function parsePersistedLayout(envelope: unknown, knownIds: Set<string>): SerializedDockview | null {
  if (!envelope || typeof envelope !== 'object') return null
  const e = envelope as Partial<LayoutEnvelope>
  if (!Array.isArray(e.panels) || !e.dockview || typeof e.dockview !== 'object') return null
  const dockview = e.dockview as unknown as SerializedDockview
  if (!dockview.grid || !dockview.panels) return null
  try {
    return pruneUnknownPanels(dockview, knownIds)
  } catch (err) {
    console.warn('[workbenchLayoutSerialize] prune failed, falling back to default:', err)
    return null
  }
}
