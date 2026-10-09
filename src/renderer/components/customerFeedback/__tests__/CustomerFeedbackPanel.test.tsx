// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { CustomerFeedbackPanel } from '../CustomerFeedbackPanel'
import { useCustomerFeedback } from '../../../state/customerFeedback'
import type { CustomerFeedbackItem, CustomerFeedbackStatus } from '../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

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

const spies = {
  load: vi.fn(async () => {}),
  loadOwnerInfo: vi.fn(async () => {}),
  refreshStatus: vi.fn(async () => {}),
  markSeen: vi.fn(async () => {}),
  closePanel: vi.fn(),
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(CustomerFeedbackPanel))
    await Promise.resolve()
  })
}

beforeEach(() => {
  Object.values(spies).forEach((s) => s.mockClear())
  useCustomerFeedback.setState({
    panelOpen: true,
    draft: { title: '', body: '', tag: 'bug' },
    items: [],
    submitting: false,
    ...spies,
    setDraft: (p) => useCustomerFeedback.setState((s) => ({ draft: { ...s.draft, ...p } })),
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('CustomerFeedbackPanel', () => {
  it('renders nothing when closed', async () => {
    useCustomerFeedback.setState({ panelOpen: false })
    await mount()
    expect(q('customer-feedback-panel')).toBeNull()
    expect(q('customer-feedback-backdrop')).toBeNull()
  })

  it('shows form + list when open and runs the open sequence', async () => {
    await mount()
    expect(q('customer-feedback-panel')).not.toBeNull()
    expect(q('customer-feedback-title')).not.toBeNull()
    expect(q('customer-feedback-body')).not.toBeNull()
    expect(q('customer-feedback-list')).not.toBeNull()
    expect(q('customer-feedback-panel')!.textContent).toContain('bilko.run')
    expect(spies.load).toHaveBeenCalled()
    expect(spies.loadOwnerInfo).toHaveBeenCalled()
    expect(spies.refreshStatus).toHaveBeenCalled()
    expect(spies.markSeen).toHaveBeenCalled()
  })

  it('disables submit when blank and enables when filled', async () => {
    await mount()
    expect((q('customer-feedback-submit') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      useCustomerFeedback.setState({ draft: { title: 'Hi', body: 'There', tag: 'bug' } })
    })
    expect((q('customer-feedback-submit') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      useCustomerFeedback.setState({ draft: { title: '   ', body: 'There', tag: 'bug' } })
    })
    expect((q('customer-feedback-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('selects a tag', async () => {
    await mount()
    expect(q('customer-feedback-tag-bug')!.getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      q('customer-feedback-tag-feature')!.click()
    })
    expect(useCustomerFeedback.getState().draft.tag).toBe('feature')
    expect(q('customer-feedback-tag-feature')!.getAttribute('aria-pressed')).toBe('true')
    expect(q('customer-feedback-tag-bug')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('closes on Escape, backdrop and close button', async () => {
    await mount()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(spies.closePanel).toHaveBeenCalledTimes(1)
    await act(async () => {
      q('customer-feedback-backdrop')!.click()
    })
    expect(spies.closePanel).toHaveBeenCalledTimes(2)
    await act(async () => {
      q('customer-feedback-close')!.click()
    })
    expect(spies.closePanel).toHaveBeenCalledTimes(3)
  })

  it('shows empty state with no items', async () => {
    await mount()
    expect(q('customer-feedback-list')!.textContent).toContain('No feedback yet')
  })

  it('renders a status badge per status, newest first', async () => {
    const labels: Record<CustomerFeedbackStatus, string> = {
      open: 'Open',
      in_progress: 'In progress',
      resolved: 'Resolved',
      wontfix: "Won't fix",
    }
    const statuses = Object.keys(labels) as CustomerFeedbackStatus[]
    useCustomerFeedback.setState({
      items: statuses.map((s, i) => item({ id: s, status: s, title: s, submittedAt: 1000 + i, statusNote: s === 'resolved' ? 'shipped' : null })),
    })
    await mount()
    const badges = Array.from(document.querySelectorAll('[data-testid="customer-feedback-status"]')).map((e) => e.textContent)
    expect(badges).toEqual([labels.wontfix, labels.resolved, labels.in_progress, labels.open])
    expect(q('customer-feedback-list')!.textContent).toContain('shipped')
  })

  it('renders a <script> title as literal text', async () => {
    useCustomerFeedback.setState({ items: [item({ title: '<script>alert(1)</script>' })] })
    await mount()
    const el = q('customer-feedback-item')!
    expect(el.textContent).toContain('<script>alert(1)</script>')
    expect(el.querySelector('script')).toBeNull()
  })
})
