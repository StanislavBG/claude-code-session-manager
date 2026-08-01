// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicQueuePanel } from '../EpicQueuePanel'
import type { PromptTicket, TabChat } from '../../../state/chat'

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

function makeTicket(overrides: Partial<PromptTicket>): PromptTicket {
  return {
    id: overrides.id ?? 't-1',
    tabId: 'epic-1',
    sessionId: 'sess-1',
    cwd: '/proj',
    text: 'do the thing',
    status: 'queued',
    createdAt: Date.now(),
    ...overrides,
  }
}

function baseChat(overrides: Partial<TabChat> = {}): TabChat {
  return {
    turns: [],
    running: false,
    queuedPosition: 0,
    started: false,
    stream: '',
    liveToolUses: [],
    queue: [],
    activeTicket: null,
    ticketHistory: [],
    ...overrides,
  }
}

describe('EpicQueuePanel', () => {
  it('renders nothing when chat state is empty', () => {
    const el = mount(<EpicQueuePanel chat={baseChat()} />)
    expect(el.querySelector('[data-testid="epic-queue-panel"]')).toBeNull()
  })

  it('renders nothing when chat is undefined', () => {
    const el = mount(<EpicQueuePanel chat={undefined} />)
    expect(el.querySelector('[data-testid="epic-queue-panel"]')).toBeNull()
  })

  it('renders the active ticket with a running label', () => {
    const chat = baseChat({ activeTicket: makeTicket({ id: 'active-1', text: 'active work', status: 'running' }) })
    const el = mount(<EpicQueuePanel chat={chat} />)
    const active = el.querySelector('[data-testid="epic-queue-panel-active"]')
    expect(active).not.toBeNull()
    expect(active!.textContent).toContain('running')
    expect(active!.textContent).toContain('active work')
  })

  it('renders the active ticket as classifying while its status is still queued', () => {
    const chat = baseChat({ activeTicket: makeTicket({ id: 'active-1', text: 'active work', status: 'queued' }) })
    const el = mount(<EpicQueuePanel chat={chat} />)
    const active = el.querySelector('[data-testid="epic-queue-panel-active"]')
    expect(active!.textContent).toContain('classifying')
  })

  it('renders queued tickets in FIFO order with correct position numbers', () => {
    const chat = baseChat({
      queue: [
        makeTicket({ id: 'q-1', text: 'first queued' }),
        makeTicket({ id: 'q-2', text: 'second queued' }),
        makeTicket({ id: 'q-3', text: 'third queued' }),
      ],
    })
    const el = mount(<EpicQueuePanel chat={chat} />)
    const items = Array.from(el.querySelectorAll('[data-testid="epic-queue-panel-item"]'))
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('#1')
    expect(items[0].textContent).toContain('first queued')
    expect(items[1].textContent).toContain('#2')
    expect(items[1].textContent).toContain('second queued')
    expect(items[2].textContent).toContain('#3')
    expect(items[2].textContent).toContain('third queued')
  })

  it('renders recent ticketHistory entries, most recent first, with status labels', () => {
    const chat = baseChat({
      ticketHistory: [
        makeTicket({ id: 'h-1', text: 'oldest done', status: 'done' }),
        makeTicket({ id: 'h-2', text: 'middle failed', status: 'failed' }),
        makeTicket({ id: 'h-3', text: 'newest dispatched', status: 'dispatched-to-prd' }),
      ],
    })
    const el = mount(<EpicQueuePanel chat={chat} />)
    const items = Array.from(el.querySelectorAll('[data-testid="epic-queue-panel-history-item"]'))
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('newest dispatched')
    expect(items[0].textContent).toContain('dispatched to PRD')
    expect(items[1].textContent).toContain('middle failed')
    expect(items[1].textContent).toContain('failed')
    expect(items[2].textContent).toContain('oldest done')
    expect(items[2].textContent).toContain('completed')
  })

  it('caps ticketHistory display to the most recent 5 entries', () => {
    const chat = baseChat({
      ticketHistory: Array.from({ length: 8 }, (_, i) => makeTicket({ id: `h-${i}`, text: `entry ${i}`, status: 'done' })),
    })
    const el = mount(<EpicQueuePanel chat={chat} />)
    const items = el.querySelectorAll('[data-testid="epic-queue-panel-history-item"]')
    expect(items).toHaveLength(5)
    expect(el.textContent).toContain('entry 7')
    expect(el.textContent).not.toContain('entry 2')
  })

  it('truncates long ticket text to ~80 chars', () => {
    const longText = 'a'.repeat(200)
    const chat = baseChat({ queue: [makeTicket({ id: 'q-1', text: longText })] })
    const el = mount(<EpicQueuePanel chat={chat} />)
    const item = el.querySelector('[data-testid="epic-queue-panel-item"]')!
    expect(item.textContent!.length).toBeLessThan(150)
    expect(item.textContent).toContain('…')
  })
})
