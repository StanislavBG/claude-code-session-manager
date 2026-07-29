// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { QueueTicketPanel } from '../TerminalChat'
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
})
