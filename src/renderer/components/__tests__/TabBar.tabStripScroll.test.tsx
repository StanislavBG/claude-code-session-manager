// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TabBar } from '../TabBar'
import { useLayout, DEFAULT_LAYOUT } from '../../state/layout'
import { useSessions, type SessionTab } from '../../state/sessions'

/**
 * The TOP bar showed a permanent 10px horizontal scrollbar under the project
 * tabs (the app's global `::-webkit-scrollbar` height, inside a fixed-height
 * strip). It read as a stray widget rather than an affordance, and it ate a
 * tenth of the bar. It is hidden via `.no-scrollbar` (styles.css) with the bar
 * grown one step to pay back the space — but the row must STILL scroll, so
 * many open projects stay reachable.
 */

function tab(id: string): SessionTab {
  return {
    id, sessionId: id, label: id, cwd: `/home/bilko/Projects/${id}`,
    pid: null, status: 'dormant', exitCode: null, startupCommand: null,
    presetId: null, generation: 0,
  }
}

describe('TabBar tab strip', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
    useLayout.setState({
      panels: DEFAULT_LAYOUT,
      focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
      focusToken: 0,
      navFace: 'home',
    })
    useSessions.setState({ tabs: [tab('alpha'), tab('beta'), tab('gamma')], activeTabId: 'alpha' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => { root.render(<TabBar />) })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const strip = () =>
    container.querySelector('[data-testid="tour-tabbar"] > div:last-of-type') as HTMLElement

  it('hides the scrollbar without giving up horizontal scrolling', () => {
    const el = strip()
    expect(el.className).toContain('overflow-x-auto')
    expect(el.className).toContain('no-scrollbar')
  })

  it('keeps the bar tall enough that the hidden scrollbar costs no tab height', () => {
    const bar = container.querySelector('[data-testid="tour-tabbar"]') as HTMLElement
    expect(bar.className).toContain('h-12')
    expect(bar.className).not.toContain('h-11')
  })
})
