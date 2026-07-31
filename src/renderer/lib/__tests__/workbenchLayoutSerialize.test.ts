import { describe, expect, it } from 'vitest'
import {
  buildLayoutEnvelope,
  CURRENT_LAYOUT_VERSION,
  parsePersistedLayout,
  pruneUnknownPanels,
} from '../workbenchLayoutSerialize'
import type { SerializedDockview } from 'dockview-react'

/** Two side-by-side groups: 'overview' | 'terminal'. */
function twoGroupLayout(): SerializedDockview {
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          {
            type: 'leaf',
            data: { id: 'group-1', views: ['overview'], activeView: 'overview' },
            size: 50,
          },
          {
            type: 'leaf',
            data: { id: 'group-2', views: ['terminal'], activeView: 'terminal' },
            size: 50,
          },
        ],
        size: 100,
      },
      width: 100,
      height: 100,
      orientation: 'HORIZONTAL' as never,
    },
    panels: {
      overview: { id: 'overview', contentComponent: 'screen', params: { id: 'overview' } },
      terminal: { id: 'terminal', contentComponent: 'screen', params: { id: 'terminal' } },
    },
    activeGroup: 'group-2',
  } as unknown as SerializedDockview
}

describe('workbenchLayoutSerialize', () => {
  it('round-trips a two-group layout: build envelope then parse it back', () => {
    const dockview = twoGroupLayout()
    const envelope = buildLayoutEnvelope(dockview)
    expect(envelope).not.toBeNull()
    expect(envelope!.version).toBe(CURRENT_LAYOUT_VERSION)
    expect(envelope!.panels.sort()).toEqual(['overview', 'terminal'])

    const knownIds = new Set(['overview', 'terminal', 'settings'])
    const restored = parsePersistedLayout(envelope, knownIds)
    expect(restored).not.toBeNull()
    expect(Object.keys(restored!.panels).sort()).toEqual(['overview', 'terminal'])
    expect((restored!.grid.root as { data: unknown[] }).data).toHaveLength(2)
  })

  it('falls back to null (DEFAULT_LAYOUT) on corrupt/unparseable input', () => {
    expect(parsePersistedLayout(null, new Set(['overview']))).toBeNull()
    expect(parsePersistedLayout(undefined, new Set(['overview']))).toBeNull()
    expect(parsePersistedLayout('not an object', new Set(['overview']))).toBeNull()
    expect(parsePersistedLayout({ version: 1 }, new Set(['overview']))).toBeNull()
    expect(parsePersistedLayout({ version: 1, panels: [], dockview: {} }, new Set(['overview']))).toBeNull()
    expect(
      parsePersistedLayout({ version: 1, panels: ['overview'], dockview: { panels: {} } }, new Set(['overview'])),
    ).toBeNull()
  })

  it('drops a panel id no longer in the registry, keeps the rest', () => {
    const dockview = twoGroupLayout()
    // 'terminal' has been renamed/removed from the registry.
    const pruned = pruneUnknownPanels(dockview, new Set(['overview']))
    expect(pruned).not.toBeNull()
    expect(Object.keys(pruned!.panels)).toEqual(['overview'])
    const groups = (pruned!.grid.root as { data: { data: { views: string[] } }[] }).data
    expect(groups).toHaveLength(1)
    expect(groups[0].data.views).toEqual(['overview'])
  })

  it('falls back to null when every panel id is unknown (nothing valid remains)', () => {
    const dockview = twoGroupLayout()
    const pruned = pruneUnknownPanels(dockview, new Set(['settings']))
    expect(pruned).toBeNull()
  })

  it('refuses to build an envelope for a zero-panel layout', () => {
    const empty = { ...twoGroupLayout(), panels: {} }
    expect(buildLayoutEnvelope(empty)).toBeNull()
  })
})
