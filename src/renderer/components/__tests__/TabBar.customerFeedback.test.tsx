// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TabBar } from '../TabBar'
import { useLayout, DEFAULT_LAYOUT } from '../../state/layout'
import { useSessions } from '../../state/sessions'
import { useCustomerFeedback } from '../../state/customerFeedback'
import type { CustomerFeedbackItem } from '../../../preload/api'

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

const item = (over: Partial<CustomerFeedbackItem> = {}): CustomerFeedbackItem => ({
  id: 'a',
  receipt: null,
  tag: 'bug',
  title: 'T',
  body: 'B',
  submittedAt: 1700000000000,
  status: 'open',
  statusNote: null,
  statusAt: null,
  seenStatusAt: null,
  ...over,
})

describe('TabBar {F} feedback button', () => {
  let container: HTMLDivElement
  let root: Root
  const load = vi.fn(async () => {})

  beforeEach(() => {
    ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'
    load.mockClear()
    useLayout.setState({
      panels: DEFAULT_LAYOUT,
      focusedPanelId: DEFAULT_LAYOUT[0]?.id ?? null,
      focusToken: 0,
      navFace: 'home',
    })
    useSessions.setState({ tabs: [], activeTabId: null })
    useCustomerFeedback.setState({
      panelOpen: false,
      items: [],
      load,
      loadOwnerInfo: vi.fn(async () => {}),
      refreshStatus: vi.fn(async () => {}),
      markSeen: vi.fn(async () => {}),
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const mount = async () => {
    await act(async () => {
      root.render(<TabBar />)
      await Promise.resolve()
    })
  }

  it('renders to the right of the tab strip and loads once on mount', async () => {
    await mount()
    const btn = q('tabbar-customer-feedback')!
    expect(btn).not.toBeNull()
    expect(btn.textContent).toBe('{F}')
    expect(btn.getAttribute('aria-label')).toBe('Send feedback')
    const strip = container.querySelector('.no-scrollbar') as HTMLElement
    expect(strip.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('opens the panel on click', async () => {
    await mount()
    expect(q('customer-feedback-panel')).toBeNull()
    expect(q('tabbar-customer-feedback')!.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      q('tabbar-customer-feedback')!.click()
      await Promise.resolve()
    })
    expect(q('customer-feedback-panel')).not.toBeNull()
    expect(q('tabbar-customer-feedback')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('shows the dot only when an item has an unseen status change', async () => {
    useCustomerFeedback.setState({ items: [item({ statusAt: 5, seenStatusAt: 5 })] })
    await mount()
    expect(q('customer-feedback-unseen-dot')).toBeNull()
    await act(async () => {
      useCustomerFeedback.setState({ items: [item({ statusAt: 6, seenStatusAt: 5 })] })
    })
    expect(q('customer-feedback-unseen-dot')).not.toBeNull()
  })
})
