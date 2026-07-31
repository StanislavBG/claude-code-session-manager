// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { QueueTicketPanel, openPromptSession } from '../TerminalChat'
import type { PromptTicket } from '../../state/chat'

// Covers the AC: the panel is always rendered (never returns null on an
// empty ticket list) with a "Prompt queue" header, showing an empty-state
// block when there are zero tickets and the ticket list otherwise.

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('QueueTicketPanel', () => {
  it('renders the header and an empty-state block when there are zero tickets', () => {
    const el = mount(<QueueTicketPanel tickets={[]} />)
    expect(el.querySelector('[data-testid="chat-queue-panel"]')).not.toBeNull()
    expect(el.textContent).toContain('Prompt queue')
    expect(el.textContent).toContain('No prompts queued')
    expect(el.querySelectorAll('[data-testid="chat-queue-ticket"]')).toHaveLength(0)
  })

  it('renders the header and the ticket list when tickets are present', () => {
    const tickets: PromptTicket[] = [
      {
        id: 't1',
        tabId: 'tab-1',
        sessionId: 'sess-1',
        cwd: '/proj',
        text: 'do the thing',
        status: 'running',
        createdAt: Date.now(),
      },
    ]
    const el = mount(<QueueTicketPanel tickets={tickets} />)
    expect(el.textContent).toContain('Prompt queue')
    expect(el.textContent).not.toContain('No prompts queued')
    const items = el.querySelectorAll('[data-testid="chat-queue-ticket"]')
    expect(items).toHaveLength(1)
    expect(items[0].textContent).toContain('do the thing')
  })

  it('renders a needs-input ticket with the distinct amber treatment and fires the click callback', () => {
    const onSelectNeedsInput = vi.fn()
    const ticket: PromptTicket = {
      id: 't-needs-input',
      tabId: 'tab-1',
      sessionId: 'sess-1',
      cwd: '/proj',
      text: 'Which environment should I deploy to?',
      status: 'needs-input',
      createdAt: Date.now(),
      questionTurnId: 'turn-1',
    }
    const el = mount(<QueueTicketPanel tickets={[ticket]} onSelectNeedsInput={onSelectNeedsInput} />)
    expect(el.textContent).toContain('needs your answer')

    const item = el.querySelector('[data-testid="chat-queue-ticket"]') as HTMLElement
    expect(item.className).toContain('cursor-pointer')

    act(() => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelectNeedsInput).toHaveBeenCalledWith(ticket)
  })

  it('does not attach the click callback to non-needs-input tickets', () => {
    const onSelectNeedsInput = vi.fn()
    const ticket: PromptTicket = {
      id: 't-done',
      tabId: 'tab-1',
      sessionId: 'sess-1',
      cwd: '/proj',
      text: 'do the thing',
      status: 'done',
      createdAt: Date.now(),
    }
    const el = mount(<QueueTicketPanel tickets={[ticket]} onSelectNeedsInput={onSelectNeedsInput} />)
    const item = el.querySelector('[data-testid="chat-queue-ticket"]') as HTMLElement
    act(() => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelectNeedsInput).not.toHaveBeenCalled()
  })

  it('renders a tag chip for a ticket with a tag set, and no chip for one without (PRD 774)', () => {
    const tagged: PromptTicket = {
      id: 't-tagged',
      tabId: 'tab-1',
      sessionId: 'sess-1',
      cwd: '/proj',
      text: 'fix the login bug',
      status: 'done',
      createdAt: Date.now(),
      tag: 'bug',
    }
    const untagged: PromptTicket = {
      id: 't-untagged',
      tabId: 'tab-1',
      sessionId: 'sess-1',
      cwd: '/proj',
      text: 'pre-existing history ticket',
      status: 'done',
      createdAt: Date.now(),
    }
    const el = mount(<QueueTicketPanel tickets={[tagged, untagged]} />)
    const items = el.querySelectorAll('[data-testid="chat-queue-ticket"]')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Bug')
    expect(items[1].textContent).not.toContain('Feature')
    expect(items[1].textContent).not.toContain('Bug')
  })

  // PRD 814: a dispatched-to-prd ticket with a minted promptSessionId (PRD
  // 813) renders a link into its own scoped PromptSessionConversation, using
  // the SAME open mechanism (sm:select-prompt-session via
  // promptSessionDeepLink.ts) SchedulePanel's job-row chip and
  // ProjectsLanding's deep-link listener already use — never a second path.
  it('renders an "Open conversation" link for a dispatched-to-prd ticket with a promptSessionId, and navigates via the shared deep-link event on click', () => {
    const navHandler = vi.fn()
    window.addEventListener('sm:navigate', navHandler)
    const selectHandler = vi.fn()
    window.addEventListener('sm:select-prompt-session', selectHandler)
    try {
      const ticket: PromptTicket = {
        id: 't-dispatched',
        tabId: 'tab-1',
        sessionId: 'sess-1',
        cwd: '/proj',
        text: 'build the thing',
        status: 'dispatched-to-prd',
        createdAt: Date.now(),
        promptSessionId: 'psess-123',
        prdSlugs: ['814-build-the-thing'],
      }
      const el = mount(<QueueTicketPanel tickets={[ticket]} />)
      const link = el.querySelector('[data-testid="ticket-open-prompt-session"]') as HTMLButtonElement
      expect(link).not.toBeNull()

      act(() => {
        link.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(selectHandler).toHaveBeenCalledTimes(1)
      expect((selectHandler.mock.calls[0][0] as CustomEvent<string>).detail).toBe('psess-123')
      expect(navHandler).toHaveBeenCalledTimes(1)
      expect((navHandler.mock.calls[0][0] as CustomEvent<string>).detail).toBe('terminal')
    } finally {
      window.removeEventListener('sm:navigate', navHandler)
      window.removeEventListener('sm:select-prompt-session', selectHandler)
    }
  })

  it('does not render the "Open conversation" link when the ticket has no promptSessionId', () => {
    const ticket: PromptTicket = {
      id: 't-no-session',
      tabId: 'tab-1',
      sessionId: 'sess-1',
      cwd: '/proj',
      text: 'pre-813 dispatched ticket',
      status: 'dispatched-to-prd',
      createdAt: Date.now(),
      prdSlugs: ['700-pre-813'],
    }
    const el = mount(<QueueTicketPanel tickets={[ticket]} />)
    expect(el.querySelector('[data-testid="ticket-open-prompt-session"]')).toBeNull()
  })

  it('openPromptSession helper sets the pending id and dispatches sm:navigate to terminal', () => {
    const navHandler = vi.fn()
    const selectHandler = vi.fn()
    window.addEventListener('sm:navigate', navHandler)
    window.addEventListener('sm:select-prompt-session', selectHandler)
    try {
      openPromptSession('psess-abc')
      expect(selectHandler).toHaveBeenCalledTimes(1)
      expect((selectHandler.mock.calls[0][0] as CustomEvent<string>).detail).toBe('psess-abc')
      expect(navHandler).toHaveBeenCalledTimes(1)
      expect((navHandler.mock.calls[0][0] as CustomEvent<string>).detail).toBe('terminal')
    } finally {
      window.removeEventListener('sm:navigate', navHandler)
      window.removeEventListener('sm:select-prompt-session', selectHandler)
    }
  })

  // Covers the scroll-stabilization fix: the panel container is a plain
  // overflow-y-auto div with no scroll anchoring at all before this fix, so a
  // ticket status transition (or a new ticket arriving) left scrollTop fixed
  // while scrollHeight grew underneath it — jsdom always reports
  // scrollHeight/clientHeight as 0, so these tests stub them via
  // defineProperty to exercise the "was I at the bottom?" branch logic.
  function ticket(overrides: Partial<PromptTicket> = {}): PromptTicket {
    return {
      id: 't1',
      tabId: 'tab-1',
      sessionId: 'sess-1',
      cwd: '/proj',
      text: 'do the thing',
      status: 'running',
      createdAt: Date.now(),
      ...overrides,
    }
  }

  function stubScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  }

  it('preserves scrollTop across a ticket status transition when the user scrolled up', () => {
    const el = mount(<QueueTicketPanel tickets={[ticket({ status: 'running' })]} />)
    const panel = el.querySelector('[data-testid="chat-queue-panel"]') as HTMLDivElement

    // Simulate a tall, overflowing list where the user has scrolled up away
    // from the bottom (scrollHeight - scrollTop - clientHeight >= 8).
    stubScrollMetrics(panel, 500, 100)
    Object.defineProperty(panel, 'scrollTop', { configurable: true, writable: true, value: 50 })
    act(() => {
      panel.dispatchEvent(new Event('scroll'))
    })
    expect(panel.scrollTop).toBe(50)

    // A ticket status transition re-renders with a new tickets array and a
    // taller scrollHeight (content grew); since the user wasn't at the
    // bottom, scrollTop must stay untouched — proving the guard actively
    // suppressed a would-be jump rather than the effect being a no-op.
    stubScrollMetrics(panel, 650, 100)
    act(() => {
      root!.render(<QueueTicketPanel tickets={[ticket({ status: 'done' })]} />)
    })
    expect(panel.scrollTop).toBe(50)
  })

  it('sticks to the bottom when the user was already there before a ticket update', () => {
    const el = mount(<QueueTicketPanel tickets={[ticket({ status: 'running' })]} />)
    const panel = el.querySelector('[data-testid="chat-queue-panel"]') as HTMLDivElement

    stubScrollMetrics(panel, 500, 100)
    Object.defineProperty(panel, 'scrollTop', { configurable: true, writable: true, value: 400 })
    act(() => {
      panel.dispatchEvent(new Event('scroll'))
    })
    expect(panel.scrollTop).toBe(400)

    // A new ticket arrives (e.g. a second prompt entering the queue) and
    // grows scrollHeight; since the user was pinned to the bottom, the panel
    // should re-anchor to the new bottom instead of leaving stale content
    // visible.
    stubScrollMetrics(panel, 650, 100)
    act(() => {
      root!.render(
        <QueueTicketPanel
          tickets={[ticket({ status: 'running' }), ticket({ id: 't2', status: 'queued', text: 'second prompt' })]}
        />,
      )
    })
    expect(panel.scrollTop).toBe(650)
  })
})
