// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { CustomerFeedbackPanel } from '../CustomerFeedbackPanel'
import { useCustomerFeedback } from '../../../state/customerFeedback'
import { useToast } from '../../../state/toast'
import { useSessions } from '../../../state/sessions'
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
    ownerInfo: null,
    inbox: [],
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
    const submit = vi.fn(async () => false)
    useCustomerFeedback.setState({ submit })
    ;(window as unknown as { api: unknown }).api = { shell: { open } }
    await mount()
    await act(async () => {
      q('customer-feedback-free-hour-link')!.click()
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({
      as: 'external',
      url: 'https://bilko.run/book?utm_source=session-manager&utm_medium=app&utm_campaign=free-consultation',
    })
    expect(submit).not.toHaveBeenCalled()
    expect(spies.closePanel).not.toHaveBeenCalled()
  })

  it('free-hour line carries no price text', async () => {
    await mount()
    expect(q('customer-feedback-free-hour')).not.toBeNull()
    expect(q('customer-feedback-free-hour')!.textContent).toBe('Want to chat? Book a free consultation.')
    const text = q('customer-feedback-panel')!.textContent ?? ''
    expect(text).not.toContain('$')
    expect(text).not.toContain('per hour')
    expect(text).not.toContain('pricing')
  })

  it('labels the fields Goal and Description and warns about screenshots', async () => {
    await mount()
    const text = q('customer-feedback-panel')!.textContent ?? ''
    expect(text).toContain('Goal')
    expect(text).toContain('0/120')
    expect(text).toContain('Description')
    expect(text).not.toContain('Header')
    expect(text).toContain('including any screenshots, is sent to bilko.run')
  })

  describe('images', () => {
    let created = 0
    let revoked: string[] = []
    const png = (name: string, size = 10, type = 'image/png') => {
      const f = new File([new Uint8Array(4)], name, { type })
      if (size !== 10) Object.defineProperty(f, 'size', { value: size })
      return f
    }
    const pick = async (files: File[]) => {
      const input = q('customer-feedback-images-input') as HTMLInputElement
      Object.defineProperty(input, 'files', { value: files, configurable: true })
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    const thumbs = () => document.querySelectorAll('[data-testid="customer-feedback-image"]')
    let show: ReturnType<typeof vi.fn>

    beforeEach(() => {
      created = 0
      revoked = []
      URL.createObjectURL = vi.fn(() => `blob:${++created}`)
      URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u))
      show = vi.fn()
      useToast.setState({ show } as never)
      ;(window as unknown as { api: unknown }).api = {}
    })

    it('Add images opens a multiple image-only file input', async () => {
      await mount()
      const input = q('customer-feedback-images-input') as HTMLInputElement
      const click = vi.spyOn(input, 'click').mockImplementation(() => {})
      q('customer-feedback-add-images')!.click()
      expect(click).toHaveBeenCalled()
      expect(input.multiple).toBe(true)
      expect(input.accept).toBe('image/png,image/jpeg,image/webp,image/gif')
    })

    it('two picked images render two thumbnails; remove drops one and revokes its URL', async () => {
      await mount()
      await pick([png('a.png'), png('b.png')])
      expect(thumbs()).toHaveLength(2)
      await act(async () => {
        ;(document.querySelector('[data-testid="customer-feedback-image-remove"]') as HTMLElement).click()
      })
      expect(thumbs()).toHaveLength(1)
      expect(revoked).toEqual(['blob:1'])
    })

    it('refuses a 6th image, a non-image and a file over 25 MB with an error toast', async () => {
      await mount()
      await pick([png('1.png'), png('2.png'), png('3.png'), png('4.png'), png('5.png')])
      expect(thumbs()).toHaveLength(5)
      await pick([png('6.png')])
      expect(thumbs()).toHaveLength(5)
      expect(show).toHaveBeenCalledWith('error', expect.stringContaining('up to 5'))
      act(() => {
        ;(document.querySelector('[data-testid="customer-feedback-image-remove"]') as HTMLElement).click()
      })
      show.mockClear()
      await pick([png('notes.txt', 10, 'text/plain')])
      expect(show).toHaveBeenCalledWith('error', expect.stringContaining('notes.txt'))
      await pick([png('huge.png', 26 * 1024 * 1024)])
      expect(show).toHaveBeenCalledWith('error', expect.stringContaining('25 MB'))
      expect(thumbs()).toHaveLength(4)
    })

    it('accepts a pasted image', async () => {
      await mount()
      const ev = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'clipboardData', { value: { files: [png('shot.png')] } })
      await act(async () => {
        q('customer-feedback-body')!.dispatchEvent(ev)
      })
      expect(thumbs()).toHaveLength(1)
    })

    it('accepts a dropped image', async () => {
      await mount()
      const ev = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'dataTransfer', { value: { files: [png('d.png')], types: ['Files'] } })
      await act(async () => {
        q('customer-feedback-form')!.dispatchEvent(ev)
      })
      expect(thumbs()).toHaveLength(1)
    })

    const flushAll = async () => {
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0))
        })
      }
    }

    it('submit passes two data URLs and clears images on success', async () => {
      const submit = vi.fn(async (_images?: { dataUrl: string }[]) => true)
      useCustomerFeedback.setState({ submit, draft: { title: 'G', body: 'D', tag: 'bug' } })
      await mount()
      await pick([png('a.png'), png('b.png')])
      await act(async () => {
        q('customer-feedback-submit')!.click()
      })
      await flushAll()
      expect(submit).toHaveBeenCalledTimes(1)
      const images = submit.mock.calls[0][0]!
      expect(images).toHaveLength(2)
      for (const im of images) expect(im.dataUrl).toMatch(/^data:image\/png;base64,/)
      expect(thumbs()).toHaveLength(0)
      expect(revoked.sort()).toEqual(['blob:1', 'blob:2'])
    })

    it('keeps images when submit fails', async () => {
      const submit = vi.fn(async () => false)
      useCustomerFeedback.setState({ submit, draft: { title: 'G', body: 'D', tag: 'bug' } })
      await mount()
      await pick([png('a.png'), png('b.png')])
      await act(async () => {
        q('customer-feedback-submit')!.click()
      })
      await flushAll()
      expect(submit).toHaveBeenCalledTimes(1)
      expect(thumbs()).toHaveLength(2)
    })

    it('revokes object URLs on unmount', async () => {
      await mount()
      await pick([png('a.png')])
      act(() => root?.unmount())
      root = null
      expect(revoked).toEqual(['blob:1'])
    })
  })

  it('renders a <script> title as literal text', async () => {
    useCustomerFeedback.setState({ items: [item({ title: '<script>alert(1)</script>' })] })
    await mount()
    const el = q('customer-feedback-item')!
    expect(el.textContent).toContain('<script>alert(1)</script>')
    expect(el.querySelector('script')).toBeNull()
  })

  describe('session hint', () => {
    const PHRASE = 'Send this to Session Manager as feedback, with any screenshots I attached.'
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
          'Already talking about this in a session? Ask it: "Send this to Session Manager as feedback, with any screenshots I attached." It uses what the session already knows, so you don\'t retype it, and the item shows up here.',
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

  describe('owner inbox link', () => {
    it('owner mode shows the moved notice instead of the Customer inbox, and Open goes to Project Home > Feedback', async () => {
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
      try {
        useCustomerFeedback.setState({ ownerInfo: { ownerMode: true, projectCwd: '/owner' }, feedbackTabIntent: null })
        const setActive = vi.fn()
        useSessions.setState({ tabs: [{ id: 't-owner', cwd: '/owner' } as never], activeTabId: null, setActive })
        const nav = vi.fn()
        window.addEventListener('sm:navigate', nav)
        await mount()
        expect(q('customer-feedback-inbox')).toBeNull()
        expect(q('customer-feedback-inbox-refresh')).toBeNull()
        const moved = q('customer-feedback-inbox-moved')!
        expect(moved.textContent).toContain('Customer inbox moved to Project Home > Feedback')
        setTimeoutSpy.mockClear()
        await act(async () => {
          q('customer-feedback-inbox-open-project-home')!.click()
        })
        expect(setActive).toHaveBeenCalledWith('t-owner')
        expect(spies.closePanel).toHaveBeenCalled()
        // Navigation is synchronous — no setTimeout race with App.tsx's tab-switch effect.
        expect(nav).toHaveBeenCalledTimes(1)
        expect((nav.mock.calls[0][0] as CustomEvent).detail).toBe('project-home')
        expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === 0)).toBe(false)
        // The intent names the owner project: another project's mount cannot consume it.
        expect(useCustomerFeedback.getState().feedbackTabIntent).toMatchObject({ cwd: '/owner' })
        expect(useCustomerFeedback.getState().consumeFeedbackTabIntent('/elsewhere')).toBe(false)
        expect(useCustomerFeedback.getState().consumeFeedbackTabIntent('/owner')).toBe(true)
        expect(useCustomerFeedback.getState().consumeFeedbackTabIntent('/owner')).toBe(false)
        window.removeEventListener('sm:navigate', nav)
      } finally {
        setTimeoutSpy.mockRestore()
      }
    })

    it('a trailing-slash projectCwd reuses the existing tab instead of opening a second one', async () => {
      useCustomerFeedback.setState({ ownerInfo: { ownerMode: true, projectCwd: '/owner/' }, feedbackTabIntent: null })
      const setActive = vi.fn()
      const addSessionToProject = vi.fn()
      useSessions.setState({
        tabs: [{ id: 't-owner', cwd: '/owner' } as never],
        activeTabId: null,
        setActive,
        addSessionToProject,
      } as never)
      await mount()
      await act(async () => {
        q('customer-feedback-inbox-open-project-home')!.click()
      })
      expect(setActive).toHaveBeenCalledWith('t-owner')
      expect(addSessionToProject).not.toHaveBeenCalled()
      expect(useCustomerFeedback.getState().consumeFeedbackTabIntent('/owner')).toBe(true)
    })

    it('shows neither the inbox nor the link outside owner mode', async () => {
      useCustomerFeedback.setState({ ownerInfo: { ownerMode: false, projectCwd: null } })
      await mount()
      expect(q('customer-feedback-inbox')).toBeNull()
      expect(q('customer-feedback-inbox-moved')).toBeNull()
    })
  })
})
