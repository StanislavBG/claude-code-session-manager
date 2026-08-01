// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TabBar } from '../TabBar'
import { useLayout, DEFAULT_LAYOUT } from '../../state/layout'
import { useSessions } from '../../state/sessions'

/**
 * Regression coverage for the "Home tab loses focus while browsing the Home
 * sidebar" report: the TabBar's Home pill used to compute its highlighted
 * state as `focusedPanelId === 'overview'`, but most Home-face sidebar rows
 * (Scheduler, Skills, Plugins, ...) are BOTH-face screens — navigating to one
 * of them via the Home sidebar correctly leaves navFace at 'home' (see
 * state/layout.ts) while moving focusedPanelId off 'overview', which used to
 * un-highlight the Home pill mid-browse. The pill must track navFace, not
 * focusedPanelId.
 */
describe('TabBar Home pill', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    // __APP_VERSION__ is injected by vite's `define` at build time (see
    // vite.config.ts); vitest.config.ts has no such define, so TabBar's
    // version footer needs it stubbed for this test's jsdom render.
    ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
    useLayout.setState({
      panels: DEFAULT_LAYOUT,
      focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
      focusToken: 0,
      navFace: 'home',
    })
    useSessions.setState({ tabs: [], activeTabId: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('stays highlighted while navFace is home even after focusedPanelId leaves overview', () => {
    act(() => {
      root.render(<TabBar />)
    })
    // Simulate navigating to a BOTH-face screen (e.g. Scheduler) from the
    // Home sidebar: openPanel leaves navFace untouched for non-'overview'
    // ids, so it stays 'home'.
    act(() => {
      useLayout.getState().openPanel('scheduler')
    })
    const homeButton = container.querySelector('[data-testid="tabbar-machine-home"]')
    expect(homeButton?.getAttribute('aria-current')).toBe('true')
  })

  it('drops the highlight once navFace flips to project', () => {
    act(() => {
      root.render(<TabBar />)
    })
    act(() => {
      useLayout.setState({ navFace: 'project' })
    })
    const homeButton = container.querySelector('[data-testid="tabbar-machine-home"]')
    expect(homeButton?.getAttribute('aria-current')).toBeNull()
  })
})
