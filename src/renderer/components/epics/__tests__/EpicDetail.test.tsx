// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * EpicDetail (PRD 827-epic-detail-view) — the right-pane Epic detail shell +
 * Discussion view, superseding PromptSessionConversation.tsx as the Epic
 * conversation surface (retirement itself is PRD 829, not here).
 *
 * window.api is stubbed via vi.resetModules + dynamic import, mirroring
 * PromptSessionConversation.test.tsx's pattern — chat.ts/promptSessions.ts's
 * module-load IPC wiring only fires if window.api exists at import time.
 */

function installWindowApiMock(opts: { branch?: string | null } = {}) {
  const listPrds = vi.fn().mockResolvedValue([])
  const api = {
    app: {
      gitBranch: vi.fn().mockResolvedValue(opts.branch ?? null),
    },
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(() => () => {}),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(async () => 'inline' as const),
      createPrd: vi.fn(async () => ({ ok: true as const, nn: 1, filename: '1-fake.md' })),
    },
    pty: { kill: vi.fn() },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    logs: { write: vi.fn() },
    schedule: { listPrds },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, listPrds }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

describe('EpicDetail (PRD 827)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as unknown as { api?: unknown }).api
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('renders status/kind chips and "Mark completed" for an active Epic', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it\n\nGet it out the door.', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    expect(el.querySelector('[data-testid="epic-detail"]')).not.toBeNull()
    expect(el.querySelector('[role="status"]')?.textContent).toContain('draft')
    expect(el.textContent).toContain('FEATURE')
    expect(el.querySelector('h1')?.textContent).toBe('Ship it')
    expect(el.textContent).toContain('Get it out the door.')
    expect(el.querySelector('[data-testid="epic-mark-completed"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="epic-resume"]')).toBeNull()
  })

  it('renders the Epic cwd\'s branch next to the ProjectTag when useBranch resolves one', async () => {
    installWindowApiMock({ branch: 'epic/contextual-chat' })
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const branchEl = el.querySelector('[data-testid="epic-detail-branch"]')
    expect(branchEl).not.toBeNull()
    expect(branchEl?.textContent).toBe('⎇ epic/contextual-chat')
  })

  it('hides the branch line cleanly when useBranch resolves null', async () => {
    installWindowApiMock({ branch: null })
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(el.querySelector('[data-testid="epic-detail-branch"]')).toBeNull()
  })

  it('renders "Resume" instead of "Mark completed" for a completed Epic', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Fix the bug', 'bug')
    usePromptSessions.setState({
      sessions: {
        ...usePromptSessions.getState().sessions,
        [session.id]: { ...session, status: 'completed', completedAt: new Date().toISOString() },
      },
    })
    const completed = usePromptSessions.getState().sessions[session.id]

    const el = mount(createElement(EpicDetail, { promptSession: completed }))

    expect(el.querySelector('[data-testid="epic-resume"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="epic-mark-completed"]')).toBeNull()
  })

  it('interleaves chat turns and prd_created events by timestamp in the Discussion view', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            { id: 't-early', role: 'user', text: 'earliest turn', at: 1000 },
            { id: 't-late', role: 'assistant', text: 'latest turn', at: 3000 },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '5-widget',
    })
    // Force the event's timestamp to sit between the two turns for a
    // deterministic ordering assertion.
    const events = usePromptSessions.getState().events[session.id]
    usePromptSessions.setState({
      events: {
        ...usePromptSessions.getState().events,
        [session.id]: events.map((e) => (e.kind === 'prd_created' ? { ...e, at: new Date(2000).toISOString() } : e)),
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const body = el.querySelector('[data-testid="epic-detail-body"]')!
    const rendered = Array.from(body.querySelectorAll('[id^="epic-detail-turn-"], [data-testid="epic-prd-event"]'))
    expect(rendered).toHaveLength(3)
    expect(rendered[0].textContent).toContain('earliest turn')
    expect(rendered[1].textContent).toContain('5-widget')
    expect(rendered[2].textContent).toContain('latest turn')
  })

  it('renders a needs-input turn with the red "NEEDS YOUR DECISION" styling', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            {
              id: 't-question',
              role: 'question',
              text: 'Cap at archive depth or extrapolate?',
              questions: ['Cap at archive depth or extrapolate?'],
              at: Date.now(),
            },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const questionCard = el.querySelector('[data-testid="chat-turn-question"]')
    expect(questionCard).not.toBeNull()
    expect(questionCard!.textContent).toContain('NEEDS YOUR DECISION')
    expect(questionCard!.className).toContain('border-[#b8443c]/40')
  })

  it('resets the view tab back to Discussion when the Epic changes', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const sessionA = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic A', 'feature')
    const sessionB = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic B', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: sessionA }))
    const prdsTab = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith('PRDs')) as HTMLButtonElement
    act(() => {
      prdsTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el.querySelector('[data-testid="epic-prds-placeholder"]')).not.toBeNull()

    act(() => {
      root!.render(createElement(EpicDetail, { promptSession: sessionB }))
    })
    expect(el.querySelector('[data-testid="epic-prds-placeholder"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-seed-goal"]')).not.toBeNull()
  })

  it('shows the goal as seed context with no crash when there are no chat turns yet', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'A brand new Epic with no turns', 'discussion')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const seed = el.querySelector('[data-testid="epic-seed-goal"]')
    expect(seed).not.toBeNull()
    expect(seed!.textContent).toContain('A brand new Epic with no turns')
  })
})
