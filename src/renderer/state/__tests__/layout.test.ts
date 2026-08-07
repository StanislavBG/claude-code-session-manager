import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useLayout, DEFAULT_LAYOUT, getPanelDefinition, needsProjectsPanelReconciliation } from '../layout'
import { SCREEN_KEYS } from '../../lib/screenKeys'
import { buildCommands } from '../../components/CommandPalette'
import { getNavItemsForFace } from '../../lib/navGroups'

// hydrateOpenToHomePref's only IPC dependency — mocked at the module
// boundary rather than via a real window.api, since this suite runs under
// the 'node' vitest environment (no window/jsdom).
const readAppPrefsMock = vi.fn()
vi.mock('../../lib/appPrefs', () => ({ readAppPrefs: () => readAppPrefsMock() }))

const { renderScreenComponent } = await import('../../components/screenComponents')

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
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id, focusToken: 0, navFace: 'home' })
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
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id, focusToken: 0, navFace: 'home' })
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

describe('layout.ts navFace (Two-Face LeftNav — real state, not derived from focusedPanelId)', () => {
  beforeEach(() => {
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id, focusToken: 0, navFace: 'home' })
  })

  it('boots at navFace "home", matching the default overview panel', () => {
    expect(useLayout.getState().navFace).toBe('home')
  })

  // THE regression this suite exists to catch. User report: from the Home
  // tab, clicking any Home-face sidebar row (Scheduler, History, Hooks,
  // Skills, System Prompt, MCP, Permissions, Settings, Epics, ...) "redirects
  // towards an open Project" — i.e. the sidebar's own item set and every
  // scope-aware tab's default scope silently jumped to 'project' the instant
  // you navigated into one of those shared screens, because they aren't
  // 'overview'. Browsing the Home nav list must never leave the Home face.
  it('openPanel to every Home-face NavKey keeps navFace at "home"', () => {
    const homeItems = getNavItemsForFace('home')
    expect(homeItems.length).toBeGreaterThan(0)
    for (const item of homeItems) {
      useLayout.setState({ navFace: 'home' })
      useLayout.getState().openPanel(item.key)
      expect(useLayout.getState().navFace, `openPanel('${item.key}') flipped navFace away from home`).toBe('home')
    }
  })

  it('openPanel("overview") always asserts navFace "home", even from project', () => {
    useLayout.setState({ navFace: 'project' })
    useLayout.getState().openPanel('overview')
    expect(useLayout.getState().navFace).toBe('home')
  })

  it('openPanel to a non-overview BOTH-face id never changes navFace either way (project stays project too)', () => {
    useLayout.setState({ navFace: 'project' })
    useLayout.getState().openPanel('scheduler')
    expect(useLayout.getState().navFace).toBe('project')
  })

  // PRD 963: system-prompt/skills/mcp/hooks/permissions/settings moved to
  // HOME-only. A face-agnostic entry point (CommandPalette's nav:* commands)
  // can still call openPanel for one of these while navFace is 'project' —
  // it must land on the Home face, not leave the Project sidebar showing
  // while a Home-only screen renders.
  it.each(['system-prompt', 'skills', 'mcp', 'hooks', 'permissions', 'settings'])(
    'openPanel("%s") asserts navFace "home" even from "project"',
    (key) => {
      useLayout.setState({ navFace: 'project' })
      useLayout.getState().openPanel(key)
      expect(useLayout.getState().navFace).toBe('home')
    },
  )

  it('openProjectPanel asserts navFace "project" — the only path that should', () => {
    useLayout.getState().openProjectPanel('terminal')
    expect(useLayout.getState().navFace).toBe('project')
    expect(useLayout.getState().focusedPanelId).toBe('terminal')
  })

  it('openProjectPanel is a no-op for an unregistered id (navFace untouched)', () => {
    useLayout.getState().openProjectPanel('does-not-exist')
    expect(useLayout.getState().navFace).toBe('home')
  })

  it('focusPanel mirrors the same rule: "overview" and HOME-only ids assert home, other ids are untouched', () => {
    useLayout.setState({ navFace: 'project' })
    // 'scheduler' is a BOTH-face key — focusing it must leave navFace alone.
    useLayout.getState().focusPanel('scheduler')
    expect(useLayout.getState().navFace).toBe('project')
    useLayout.getState().focusPanel('overview')
    expect(useLayout.getState().navFace).toBe('home')

    // 'skills' is now HOME-only (navGroups.ts, PRD 963) — focusing it must
    // assert navFace: 'home' even from 'project', same as 'overview'.
    useLayout.setState({ navFace: 'project' })
    useLayout.getState().focusPanel('skills')
    expect(useLayout.getState().navFace).toBe('home')
  })

  it('resetLayout resets navFace to "home" alongside the default panel', () => {
    useLayout.setState({ navFace: 'project' })
    useLayout.getState().resetLayout()
    expect(useLayout.getState().navFace).toBe('home')
  })
})

describe('layout.ts panel-focus predicate (backs usePanelFocus)', () => {
  beforeEach(() => {
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: 'terminal', focusToken: 0, navFace: 'project' })
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

describe('screenComponents.renderScreenComponent covers every non-terminal SCREEN_KEY', () => {
  it('renders a non-null result for every SCREEN_KEY except terminal', () => {
    for (const key of SCREEN_KEYS) {
      if (key === 'terminal') continue
      expect(renderScreenComponent(key, {}), `renderScreenComponent(${key}) returned null`).not.toBeNull()
    }
  })
})

describe('needsProjectsPanelReconciliation (File Explorer dead-end guard)', () => {
  it('reconciles when focusedPanelId is projects and activeTabId is null', () => {
    expect(needsProjectsPanelReconciliation('projects', null)).toBe(true)
  })

  it('does not reconcile when projects has an active tab', () => {
    expect(needsProjectsPanelReconciliation('projects', 'tab-1')).toBe(false)
  })

  it('does not reconcile terminal with a null activeTabId (Epics workspace intentionally renders this)', () => {
    expect(needsProjectsPanelReconciliation('terminal', null)).toBe(false)
  })

  it('does not reconcile other panels with a null activeTabId', () => {
    expect(needsProjectsPanelReconciliation('overview', null)).toBe(false)
    expect(needsProjectsPanelReconciliation('browser', null)).toBe(false)
    expect(needsProjectsPanelReconciliation('editor', null)).toBe(false)
  })

  it('does not reconcile when focusedPanelId is null', () => {
    expect(needsProjectsPanelReconciliation(null, null)).toBe(false)
  })

  it('does not reconcile on the Home face — File Explorer roots at the home dir there, no activeTab needed', () => {
    expect(needsProjectsPanelReconciliation('projects', null, 'home')).toBe(false)
  })

  it('still reconciles on the Project face with no active tab (default navFace)', () => {
    expect(needsProjectsPanelReconciliation('projects', null, 'project')).toBe(true)
  })
})

describe('layout.ts hydrateOpenToHomePref (app-prefs.json boot hydration)', () => {
  beforeEach(() => {
    useLayout.setState({ panels: DEFAULT_LAYOUT, focusedPanelId: DEFAULT_LAYOUT[0].id, focusToken: 0, navFace: 'home' })
    readAppPrefsMock.mockReset()
  })

  it('leaves focusedPanelId at its unmodified default when the pref file is absent', async () => {
    readAppPrefsMock.mockResolvedValue({})
    await useLayout.getState().hydrateOpenToHomePref()
    expect(useLayout.getState().focusedPanelId).toBe(DEFAULT_LAYOUT[0].id)
  })

  it('leaves focusedPanelId at its unmodified default when openToHomeOnLaunch is false', async () => {
    readAppPrefsMock.mockResolvedValue({ openToHomeOnLaunch: false })
    await useLayout.getState().hydrateOpenToHomePref()
    expect(useLayout.getState().focusedPanelId).toBe(DEFAULT_LAYOUT[0].id)
  })

  it('sets focusedPanelId to overview when openToHomeOnLaunch is true', async () => {
    readAppPrefsMock.mockResolvedValue({ openToHomeOnLaunch: true })
    await useLayout.getState().hydrateOpenToHomePref()
    expect(useLayout.getState().focusedPanelId).toBe('overview')
    expect(useLayout.getState().navFace).toBe('home')
  })

  it('does not stomp a navigation that happens while the pref read is in flight', async () => {
    let resolvePrefs: (v: { openToHomeOnLaunch: boolean }) => void
    readAppPrefsMock.mockReturnValue(new Promise((res) => { resolvePrefs = res }))
    const hydration = useLayout.getState().hydrateOpenToHomePref()

    // User navigates away from the default panel before the IPC read resolves.
    useLayout.getState().openPanel('terminal')
    resolvePrefs!({ openToHomeOnLaunch: true })
    await hydration

    expect(useLayout.getState().focusedPanelId).toBe('terminal')
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
