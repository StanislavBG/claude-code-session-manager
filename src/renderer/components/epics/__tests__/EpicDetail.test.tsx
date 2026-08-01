// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

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
    expect(el.querySelector('[role="status"]')?.textContent).toContain('active')
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
    await flushAsync(2)

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
    await flushAsync(2)

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
    const tintedCard = questionCard!.querySelector('.border-\\[\\#b8443c\\]\\/40')
    expect(tintedCard).not.toBeNull()
  })

  it('clicking a needs-input option button submits the answer through chat.send', async () => {
    const { api } = installWindowApiMock()
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
              questions: ['Cap at archive depth', 'Extrapolate'],
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

    const questionCard = el.querySelector('[data-testid="chat-turn-question"]')!
    const buttons = Array.from(questionCard.querySelectorAll('button')).filter((b) => b.textContent === 'Extrapolate')
    expect(buttons).toHaveLength(1)

    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.chat.run).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: session.id, sessionId: session.claudeSessionId, prompt: 'Extrapolate' }),
    )
  })

  it('renders "claude · <age>" and "you · <age>" captions above turns', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            { id: 't-user', role: 'user', text: 'Hello', at: Date.now() },
            { id: 't-assistant', role: 'assistant', text: 'Hi there', at: Date.now() },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    expect(el.textContent).toContain('you · just now')
    expect(el.textContent).toContain('claude · just now')
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

  it('renders the accumulating chat.stream as a live assistant bubble while a turn is in flight', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [{ id: 't-user', role: 'user', text: 'go', at: Date.now() }],
          running: true,
          queuedPosition: 0,
          started: true,
          stream: 'Working on it',
          liveToolUses: [{ id: 'tu-1', kind: 'tool', label: 'Bash' }],
          queue: [],
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const live = el.querySelector('[data-testid="epic-live-turn"]')
    expect(live).not.toBeNull()
    expect(live!.textContent).toContain('Working on it')
    expect(live!.querySelector('[data-testid="tool-strip-toggle"]')?.textContent).toContain('used 1 tool')
  })

  it('replaces the live bubble with the finished turn on chat:run:complete, with no duplicated text', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [{ id: 't-user', role: 'user', text: 'go', at: Date.now() }],
          running: true,
          queuedPosition: 0,
          started: true,
          stream: 'partial reply',
          liveToolUses: [],
          queue: [],
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    expect(el.querySelector('[data-testid="epic-live-turn"]')).not.toBeNull()

    // Mirrors pushTurn's single atomic transition (chat.ts:350) — the real
    // turn appears and running/stream flip in one set() call.
    act(() => {
      useChat.setState((s) => ({
        chats: {
          ...s.chats,
          [session.id]: {
            ...s.chats[session.id],
            turns: [...s.chats[session.id].turns, { id: 't-final', role: 'assistant', text: 'partial reply done', at: Date.now() }],
            running: false,
            queuedPosition: 0,
            stream: '',
            liveToolUses: [],
          },
        },
      }))
    })

    expect(el.querySelector('[data-testid="epic-live-turn"]')).toBeNull()
    const occurrences = (el.textContent?.match(/partial reply done/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('suppresses the empty live bubble while chat:run:queued (queued-position indicator was superseded by EpicQueuePanel)', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [],
          running: true,
          queuedPosition: 2,
          started: true,
          stream: '',
          liveToolUses: [],
          queue: [],
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    expect(el.querySelector('[data-testid="epic-live-turn"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-queued-position"]')).toBeNull()
  })

  it('resets to no live bubble on chat:run:error (stream cleared, running false)', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [],
          running: true,
          queuedPosition: 0,
          started: true,
          stream: 'streaming when it broke',
          liveToolUses: [{ id: 'tu-1', kind: 'tool', label: 'Bash' }],
          queue: [],
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    expect(el.querySelector('[data-testid="epic-live-turn"]')).not.toBeNull()

    // Mirrors applyError -> pushTurn (chat.ts:713/350): error turn appended,
    // running/stream/liveToolUses reset in the same atomic transition.
    act(() => {
      useChat.setState((s) => ({
        chats: {
          ...s.chats,
          [session.id]: {
            ...s.chats[session.id],
            turns: [...s.chats[session.id].turns, { id: 't-err', role: 'error', text: 'boom', at: Date.now() }],
            running: false,
            queuedPosition: 0,
            stream: '',
            liveToolUses: [],
          },
        },
      }))
    })

    expect(el.querySelector('[data-testid="epic-live-turn"]')).toBeNull()
    expect(el.textContent).not.toContain('streaming when it broke')
  })

  it('keys the live bubble by epic id — switching Epics does not leak the previous partial stream', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const sessionA = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic A', 'feature')
    const sessionB = usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic B', 'feature')
    useChat.setState({
      chats: {
        [sessionA.id]: {
          turns: [],
          running: true,
          queuedPosition: 0,
          started: true,
          stream: "Epic A's in-flight stream",
          liveToolUses: [],
          queue: [],
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: sessionA }))
    expect(el.textContent).toContain("Epic A's in-flight stream")

    act(() => {
      root!.render(createElement(EpicDetail, { promptSession: sessionB }))
    })

    expect(el.textContent).not.toContain("Epic A's in-flight stream")
    expect(el.querySelector('[data-testid="epic-live-turn"]')).toBeNull()
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
