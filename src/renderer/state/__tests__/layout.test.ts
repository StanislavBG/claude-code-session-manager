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
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id, focusToken: 0 })
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

describe('layout.ts focusToken (Workbench regression: openPanel-same-id must still re-mount)', () => {
  beforeEach(() => {
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id, focusToken: 0 })
  })

  it('openPanel bumps focusToken even when the id matches the current focusedPanelId', () => {
    useLayout.getState().openPanel('terminal')
    const afterFirst = useLayout.getState().focusToken
    expect(afterFirst).toBeGreaterThan(0)

    // Simulates: user clicks another tab (dockview mirrors via focusPanel,
    // no token bump), then re-opens 'terminal' from the sidebar — this must
    // still bump the token so Workbench's mount effect re-fires, even though
    // focusedPanelId ends up back at 'terminal' either way.
    useLayout.getState().focusPanel('skills')
    useLayout.getState().openPanel('terminal')
    expect(useLayout.getState().focusToken).toBeGreaterThan(afterFirst)
    expect(useLayout.getState().focusedPanelId).toBe('terminal')
  })

  it('openPanel bumps focusToken on consecutive calls with the identical id', () => {
    useLayout.getState().openPanel('terminal')
    const first = useLayout.getState().focusToken
    useLayout.getState().openPanel('terminal')
    expect(useLayout.getState().focusToken).toBeGreaterThan(first)
  })

  it('focusPanel (dockview-mirrored activation) does not bump focusToken', () => {
    const before = useLayout.getState().focusToken
    useLayout.getState().focusPanel('skills')
    expect(useLayout.getState().focusToken).toBe(before)
    expect(useLayout.getState().focusedPanelId).toBe('skills')
  })

  it('openPanel/focusPanel for an unregistered id leaves focusToken unchanged', () => {
    const before = useLayout.getState().focusToken
    useLayout.getState().openPanel('does-not-exist')
    useLayout.getState().focusPanel('does-not-exist')
    expect(useLayout.getState().focusToken).toBe(before)
  })
})

describe('layout.ts panel-focus predicate (backs usePanelFocus)', () => {
  beforeEach(() => {
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: 'terminal', focusToken: 0 })
  })

  it('is true only for the currently focused panel id', () => {
    const isFocused = (id: string) => useLayout.getState().focusedPanelId === id
    expect(isFocused('terminal')).toBe(true)
    expect(isFocused('skills')).toBe(false)
  })

  it('transitions when focusedPanelId changes via openPanel or focusPanel', () => {
    const isFocused = (id: string) => useLayout.getState().focusedPanelId === id
    useLayout.getState().openPanel('skills')
    expect(isFocused('terminal')).toBe(false)
    expect(isFocused('skills')).toBe(true)

    useLayout.getState().focusPanel('editor')
    expect(isFocused('skills')).toBe(false)
    expect(isFocused('editor')).toBe(true)
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
