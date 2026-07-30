import { describe, it, expect, beforeEach } from 'vitest'
import { useLayout, DEFAULT_LAYOUT, getPanelDefinition } from '../layout'
import { SCREEN_KEYS } from '../../lib/screenKeys'
import { buildCommands } from '../../components/CommandPalette'

/**
 * layout.ts is the panel registry backing the dockview workbench (link 1 of
 * the Workbench chain). Link 2 grows it to one entry per SCREEN_KEY. Only
 * the store/registry is tested here — dockview's DockviewReact itself needs
 * ResizeObserver, which jsdom doesn't provide.
 */

describe('layout.ts DEFAULT_LAYOUT', () => {
  it('has exactly one entry per SCREEN_KEYS member (set equality)', () => {
    const registryIds = new Set(DEFAULT_LAYOUT.map((p) => p.id))
    const screenIds = new Set(SCREEN_KEYS)
    expect(registryIds).toEqual(screenIds)
    expect(DEFAULT_LAYOUT).toHaveLength(SCREEN_KEYS.length)
  })

  it('every entry has a non-empty title and a component key', () => {
    for (const panel of DEFAULT_LAYOUT) {
      expect(panel.title.length).toBeGreaterThan(0)
      expect(panel.component.length).toBeGreaterThan(0)
    }
  })
})

describe('layout.ts registry lookup', () => {
  it('getPanelDefinition finds a registered panel by id', () => {
    expect(getPanelDefinition('overview')).toEqual(DEFAULT_LAYOUT[0])
  })

  it('getPanelDefinition returns undefined for an unregistered id', () => {
    expect(getPanelDefinition('nope')).toBeUndefined()
  })
})

describe('layout.ts useLayout store', () => {
  beforeEach(() => {
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id })
  })

  it('initializes with the default layout and the first screen focused', () => {
    const state = useLayout.getState()
    expect(state.panels).toEqual(DEFAULT_LAYOUT)
    expect(state.focusedPanelId).toBe(DEFAULT_LAYOUT[0].id)
  })

  it('focusPanel focuses a registered panel', () => {
    useLayout.setState({ focusedPanelId: null })
    useLayout.getState().focusPanel('terminal')
    expect(useLayout.getState().focusedPanelId).toBe('terminal')
  })

  it('focusPanel is a no-op for an unregistered id', () => {
    useLayout.getState().focusPanel('does-not-exist')
    expect(useLayout.getState().focusedPanelId).toBe(DEFAULT_LAYOUT[0].id)
  })

  it('openPanel focuses an already-registered panel', () => {
    useLayout.setState({ focusedPanelId: null })
    useLayout.getState().openPanel('skills')
    expect(useLayout.getState().focusedPanelId).toBe('skills')
  })

  it('openPanel is a no-op for an unregistered id', () => {
    useLayout.getState().openPanel('does-not-exist')
    expect(useLayout.getState().focusedPanelId).toBe(DEFAULT_LAYOUT[0].id)
  })
})

describe('CommandPalette nav:* commands resolve to registered panels', () => {
  it('every nav:<key> command id names a panel in the registry', () => {
    const navCommands = buildCommands().filter((c) => c.id.startsWith('nav:'))
    expect(navCommands.length).toBeGreaterThan(0)
    for (const cmd of navCommands) {
      const key = cmd.id.slice(4)
      expect(getPanelDefinition(key), `nav command "${cmd.id}" has no registered panel`).toBeDefined()
    }
  })
})
