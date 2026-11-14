// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { CustomerFeedbackPanel } from '../CustomerFeedbackPanel'
import { useCustomerFeedback } from '../../../state/customerFeedback'
import { useToast } from '../../../state/toast'
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

  it('free-hour link opens the booking URL and does not submit or close', async () => {
    const open = vi.fn(async () => ({ ok: true }))
    const submit = vi.fn(async () => {})
    useCustomerFeedback.setState({ submit })
    ;(window as unknown as { api: unknown }).api = { shell: { open } }
    await mount()
    await act(async () => {
      q('customer-feedback-free-hour-link')!.click()
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({
      as: 'external',
      url: 'https://bilko.run/book?utm_source=session-manager&utm_medium=app',
    })
    expect(submit).not.toHaveBeenCalled()
    expect(spies.closePanel).not.toHaveBeenCalled()
  })

  it('free-hour line carries no price text', async () => {
    await mount()
    expect(q('customer-feedback-free-hour')).not.toBeNull()
    const text = q('customer-feedback-panel')!.textContent ?? ''
    expect(text).not.toContain('$')
    expect(text).not.toContain('per hour')
    expect(text).not.toContain('pricing')
  })

  it('renders a <script> title as literal text', async () => {
    useCustomerFeedback.setState({ items: [item({ title: '<script>alert(1)</script>' })] })
    await mount()
    const el = q('customer-feedback-item')!
    expect(el.textContent).toContain('<script>alert(1)</script>')
    expect(el.querySelector('script')).toBeNull()
  })

  describe('session hint', () => {
    const PHRASE = 'Send this to Session Manager as feedback.'
    const seed = (status: 'done' | 'pending' | 'failed' | 'exhausted') => ({
      'dev-plugin': { status: 'done', fix: '' },
      'scheduler-mcp': { status, fix: '' },
      'agent-personas': { status: 'done', fix: '' },
    })
    const setApi = (api: unknown) => {
      ;(window as unknown as { api: unknown }).api = api
    }
    const flush = async () => {
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    it('shows the hint above the title when scheduler-mcp is done', async () => {
      setApi({ app: { seedStatus: vi.fn(async () => seed('done')) } })
      await mount()
      await flush()
      const hint = q('customer-feedback-session-hint')
      expect(hint).not.toBeNull()
      expect(hint!.textContent).toContain(
          'Already talking about this in a session? Ask it: "Send this to Session Manager as feedback." It uses what the session already knows, so you don\'t retype it, and the item shows up here.',
      )
      expect(q('customer-feedback-session-hint-copy')).not.toBeNull()
      const title = q('customer-feedback-title')!
      expect(hint!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('hides the hint when scheduler-mcp is pending', async () => {
      setApi({ app: { seedStatus: vi.fn(async () => seed('pending')) } })
      await mount()
      await flush()
      expect(q('customer-feedback-session-hint')).toBeNull()
      expect(q('customer-feedback-title')).not.toBeNull()
    })

    it('hides the hint when seedStatus rejects', async () => {
      setApi({ app: { seedStatus: vi.fn(async () => { throw new Error('boom') }) } })
      await mount()
      await flush()
      expect(q('customer-feedback-session-hint')).toBeNull()
      expect(q('customer-feedback-title')).not.toBeNull()
    })

    it('Copy writes the exact phrase and confirms with a toast', async () => {
      const writeText = vi.fn(async () => ({ ok: true }))
      const show = vi.fn()
      useToast.setState({ show } as never)
      setApi({ app: { seedStatus: vi.fn(async () => seed('done')) }, clipboard: { writeText } })
      await mount()
      await flush()
      await act(async () => {
        q('customer-feedback-session-hint-copy')!.click()
        await Promise.resolve()
      })
      await flush()
      expect(writeText).toHaveBeenCalledWith(PHRASE)
      expect(show).toHaveBeenCalledWith('info', expect.any(String))
    })

    it('Copy failure shows an error toast', async () => {
      const writeText = vi.fn(async () => ({ ok: false }))
      const show = vi.fn()
      useToast.setState({ show } as never)
      setApi({ app: { seedStatus: vi.fn(async () => seed('done')) }, clipboard: { writeText } })
      await mount()
      await flush()
      await act(async () => {
        q('customer-feedback-session-hint-copy')!.click()
        await Promise.resolve()
      })
      await flush()
      expect(show).toHaveBeenCalledWith('error', expect.any(String))
    })
  })
})
