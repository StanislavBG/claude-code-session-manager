// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TabBar, FEEDBACK_TOOLTIP } from '../TabBar'
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

describe('TabBar Feedback button', () => {
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
    expect(btn.textContent).toBe('Feedback')
    expect(btn.textContent).not.toContain('{F}')
    expect(btn.getAttribute('title')).toBe(FEEDBACK_TOOLTIP)
    expect(btn.getAttribute('aria-label')).toBe('Send feedback')
    const strip = container.querySelector('.no-scrollbar') as HTMLElement
    expect(strip.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shows the thank-you tooltip on hover and on focus', async () => {
    const text =
      'Thank you for using the product — feedback is much appreciated. For convenience, ask your agent to send it via the Feedback MCP, directly from any session.'
    expect(FEEDBACK_TOOLTIP).toBe(text)
    await mount()
    const btn = q('tabbar-customer-feedback')!
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(text)
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => {
      btn.focus()
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(text)
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
