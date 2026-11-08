// @vitest-environment jsdom
import { cloneElement, createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SectionFrame } from '../SectionFrame'
import { renderScreenComponent } from '../../screenComponents'
import { SCREEN_KEYS } from '../../../lib/screenKeys'
import { useUiChromePrefs } from '../../../state/uiChromePrefs'

type FrameProps = ComponentProps<typeof SectionFrame>

const EYEBROW = 'Claude Code'
const TITLE = 'Extensions'
const INTRO = 'Skills, MCP servers and plugins — each tab edits the real file Claude Code reads.'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  // Learn renders as its closed trigger: no hydrate IPC, no open popover.
  useUiChromePrefs.setState({ hydrated: true, learningPanelCollapsed: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function mount(node: ReactNode) {
  act(() => { root.render(node) })
}
const header = () => container.querySelector('header')
const learn = () => Array.from(container.querySelectorAll('header button')).find((b) => b.textContent === 'Learn')
const spacer = () => container.querySelector('[data-testid="section-frame-title-spacer"]')
const frame = (extra: Omit<Partial<FrameProps>, 'children'> = {}) =>
  createElement(SectionFrame, {
    eyebrow: EYEBROW, title: TITLE, intro: INTRO, learnKey: 'extensions', ...extra,
    children: createElement('div', { 'data-testid': 'frame-body' }),
  })

describe('SectionFrame', () => {
  it('renders the serif h1 between the eyebrow and the subtitle by default', () => {
    mount(frame())
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(container.querySelector('h1')?.textContent).toBe(TITLE)
    expect(header()?.textContent).toContain(EYEBROW)
    expect(header()?.textContent).toContain(INTRO)
    expect(learn()).toBeDefined()
    expect(spacer()).toBeNull()
    expect(container.querySelector('[data-testid="frame-body"]')).not.toBeNull()
  })

  it('hideTitle renders no h1, an 8px spacer in its place, and keeps the eyebrow, Learn and the subtitle', () => {
    mount(frame({ hideTitle: true }))
    expect(container.querySelector('h1')).toBeNull()
    expect(container.textContent).not.toContain(TITLE)
    expect(spacer()?.className.split(/\s+/)).toContain('h-2')
    expect(header()?.textContent).toContain(EYEBROW)
    expect(header()?.textContent).toContain(INTRO)
    expect(learn()).toBeDefined()
    expect(container.querySelector('[data-testid="frame-body"]')).not.toBeNull()
  })
})

describe('screenComponents page frames', () => {
  it('hides the h1 only on Extensions — every other framed Home page still shows its title', () => {
    const ctx = {}
    const framed: Array<[string, ReactElement<FrameProps>]> = []
    for (const key of SCREEN_KEYS) {
      if (key === 'terminal') continue // never rendered through renderScreenComponent
      const node = renderScreenComponent(key, ctx)
      if (isValidElement(node) && node.type === SectionFrame) framed.push([key, node as ReactElement<FrameProps>])
    }
    expect(framed.map(([key]) => key)).toContain('extensions')
    expect(framed.length).toBeGreaterThan(1)
    for (const [key, node] of framed) {
      // The frame alone (its lazy page body swapped out), exactly as screenComponents configures it.
      mount(cloneElement(node, undefined, null))
      const h1 = container.querySelector('h1')
      if (key === 'extensions') {
        expect(h1, key).toBeNull()
        expect(spacer(), key).not.toBeNull()
        expect(header()?.textContent, key).toContain(INTRO)
        expect(learn(), key).toBeDefined()
      } else {
        expect(h1?.textContent, key).toBe(node.props.title)
        expect(spacer(), key).toBeNull()
      }
    }
  })
})
