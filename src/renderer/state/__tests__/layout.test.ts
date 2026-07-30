import { describe, it, expect, beforeEach } from 'vitest'
import { useLayout, DEFAULT_LAYOUT, getPanelDefinition } from '../layout'

/**
 * layout.ts is the panel registry backing the dockview workbench (link 1 of
 * the Workbench chain). Only the store/registry is tested here — dockview's
 * DockviewReact itself needs ResizeObserver, which jsdom doesn't provide.
 */

describe('layout.ts DEFAULT_LAYOUT', () => {
  it('contains exactly one panel: main', () => {
    expect(DEFAULT_LAYOUT).toHaveLength(1)
    expect(DEFAULT_LAYOUT[0]).toEqual({
      id: 'main',
      title: 'Session Manager',
      component: 'main',
    })
  })
})

describe('layout.ts registry lookup', () => {
  it('getPanelDefinition finds a registered panel by id', () => {
    expect(getPanelDefinition('main')).toEqual(DEFAULT_LAYOUT[0])
  })

  it('getPanelDefinition returns undefined for an unregistered id', () => {
    expect(getPanelDefinition('nope')).toBeUndefined()
  })
})

describe('layout.ts useLayout store', () => {
  beforeEach(() => {
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id })
  })

  it('initializes with the default layout and main focused', () => {
    const state = useLayout.getState()
    expect(state.panels).toEqual(DEFAULT_LAYOUT)
    expect(state.focusedPanelId).toBe('main')
  })

  it('focusPanel focuses a registered panel', () => {
    useLayout.setState({ focusedPanelId: null })
    useLayout.getState().focusPanel('main')
    expect(useLayout.getState().focusedPanelId).toBe('main')
  })

  it('focusPanel is a no-op for an unregistered id', () => {
    useLayout.getState().focusPanel('does-not-exist')
    expect(useLayout.getState().focusedPanelId).toBe('main')
  })

  it('openPanel focuses an already-registered panel', () => {
    useLayout.setState({ focusedPanelId: null })
    useLayout.getState().openPanel('main')
    expect(useLayout.getState().focusedPanelId).toBe('main')
  })

  it('openPanel is a no-op for an unregistered id', () => {
    useLayout.getState().openPanel('does-not-exist')
    expect(useLayout.getState().focusedPanelId).toBe('main')
  })
})
