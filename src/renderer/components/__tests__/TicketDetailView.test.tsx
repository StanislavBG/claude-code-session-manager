// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TicketDetailView } from '../TicketDetailView'
import type { PromptTicket } from '../../state/chat'
import type { ScheduleJob } from '../../../preload/api'

// TicketDetailView reuses TerminalChat's openPrdSlug, which dispatches a
// window CustomEvent — no need to mock window.api for this component.

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

function ticket(overrides: Partial<PromptTicket> = {}): PromptTicket {
  return {
    id: 't-root',
    tabId: 'tab-1',
    sessionId: 'sess-1',
    cwd: '/proj',
    text: 'build the thing',
    status: 'dispatched-to-prd',
    createdAt: Date.now(),
    ...overrides,
  }
}

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug: '100-thing',
    title: 'the thing',
    cwd: '/proj',
    parallelGroup: 1,
    estimateMinutes: null,
    bodyPreview: '',
    status: 'completed',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    ...overrides,
  } as ScheduleJob
}

describe('TicketDetailView', () => {
  it('renders a single-PRD chain with no follow-ups: prompt text, tag chip, and live status', () => {
    const t = ticket({ tag: 'feature', prdSlugs: ['100-thing'] })
    const jobs = [job({ slug: '100-thing', status: 'running' })]
    const el = mount(<TicketDetailView ticket={t} allTickets={[t]} jobs={jobs} onClose={vi.fn()} />)

    expect(el.textContent).toContain('build the thing')
    expect(el.textContent).toContain('Feature')
    const prds = el.querySelectorAll('[data-testid="ticket-detail-prd"]')
    expect(prds).toHaveLength(1)
    expect(prds[0].textContent).toContain('100-thing')
    expect(prds[0].textContent).toContain('running')
    expect(el.querySelectorAll('[data-testid="ticket-detail-entry"]')).toHaveLength(1)
  })

  it('renders a multi-PRD chain with follow-ups, in order', () => {
    const root_ = ticket({
      id: 'root-1',
      tag: 'bug',
      text: 'fix the login flow',
      prdSlugs: ['100-a', '101-b'],
    })
    const followUp1 = ticket({
      id: 'fu-1',
      chainRootId: 'root-1',
      text: 'also handle the logout case',
      prdSlugs: ['102-c'],
      tag: 'bug',
    })
    const followUp2 = ticket({
      id: 'fu-2',
      chainRootId: 'root-1',
      text: 'and the session-timeout case',
      prdSlugs: [],
      tag: 'feature',
    })
    const jobs = [
      job({ slug: '100-a', status: 'completed' }),
      job({ slug: '101-b', status: 'failed' }),
      job({ slug: '102-c', status: 'pending' }),
    ]
    const allTickets = [root_, followUp1, followUp2]
    const el = mount(<TicketDetailView ticket={root_} allTickets={allTickets} jobs={jobs} onClose={vi.fn()} />)

    const entries = el.querySelectorAll('[data-testid="ticket-detail-entry"]')
    // root entry + 2 follow-up entries
    expect(entries).toHaveLength(3)
    expect(entries[0].textContent).toContain('fix the login flow')
    expect(entries[1].textContent).toContain('also handle the logout case')
    expect(entries[2].textContent).toContain('and the session-timeout case')

    // Root's two PRDs render in prdSlugs order.
    const rootPrds = entries[0].querySelectorAll('[data-testid="ticket-detail-prd"]')
    expect(rootPrds).toHaveLength(2)
    expect(rootPrds[0].textContent).toContain('100-a')
    expect(rootPrds[1].textContent).toContain('101-b')

    // Follow-up with no PRDs yet shows the empty-state line, not a list item.
    expect(entries[2].querySelectorAll('[data-testid="ticket-detail-prd"]')).toHaveLength(0)
    expect(entries[2].textContent).toContain('No PRDs linked yet.')

    expect(el.textContent).toContain('Follow-ups')
  })

  it('renders the Feature tag chip for a feature-tagged ticket', () => {
    const t = ticket({ tag: 'feature', prdSlugs: [] })
    const el = mount(<TicketDetailView ticket={t} allTickets={[t]} jobs={[]} onClose={vi.fn()} />)
    expect(el.textContent).toContain('Feature')
    expect(el.textContent).not.toContain('Bug')
  })

  it('renders the Bug tag chip for a bug-tagged ticket', () => {
    const t = ticket({ tag: 'bug', prdSlugs: [] })
    const el = mount(<TicketDetailView ticket={t} allTickets={[t]} jobs={[]} onClose={vi.fn()} />)
    expect(el.textContent).toContain('Bug')
    expect(el.textContent).not.toContain('Feature')
  })

  it('fires onClose when the back control is clicked', () => {
    const onClose = vi.fn()
    const t = ticket()
    const el = mount(<TicketDetailView ticket={t} allTickets={[t]} jobs={[]} onClose={onClose} />)
    const back = el.querySelector('[data-testid="ticket-detail-back"]') as HTMLElement
    act(() => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
