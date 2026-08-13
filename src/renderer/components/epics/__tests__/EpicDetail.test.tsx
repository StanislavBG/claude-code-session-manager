// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

/**
 * EpicDetail (PRD 827-epic-detail-view) — the right-pane Epic detail shell +
 * Discussion view, superseding PromptSessionConversation.tsx as the Epic
 * conversation surface (retirement itself is PRD 829, not here).
 *
 * window.api is stubbed via vi.resetModules + dynamic import, mirroring
 * PromptSessionConversation.test.tsx's pattern — chat.ts/promptSessions.ts's
 * module-load IPC wiring only fires if window.api exists at import time.
 */

function installWindowApiMock(opts: { branch?: string | null; personas?: Array<{ name: string; model: string | null }> } = {}) {
  const listPrds = vi.fn().mockResolvedValue([])
  const api = {
    app: {
      gitBranch: vi.fn().mockResolvedValue(opts.branch ?? null),
    },
    agents: {
      listPersonas: vi.fn().mockResolvedValue(opts.personas ?? []),
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
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
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

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it\n\nGet it out the door.', 'feature')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    expect(el.querySelector('[data-testid="epic-detail"]')).not.toBeNull()
    expect(el.querySelector('[role="status"]')?.textContent).toContain('active')
    expect(el.textContent).toContain('FEATURE')
    expect(el.querySelector('h1')?.textContent).toBe('Ship it')
    expect(el.textContent).toContain('Get it out the door.')
    expect(el.querySelector('[data-testid="epic-mark-completed"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="epic-resume"]')).toBeNull()
  })

  describe('editable title (full view)', () => {
    async function mountEpic() {
      installWindowApiMock()
      const { usePromptSessions } = await import('../../../state/promptSessions')
      const { EpicDetail } = await import('../EpicDetail')
      const proposed = await usePromptSessions
        .getState()
        .createPromptSession('/tmp/proj', 'Ship it\n\nGet it out the door.', 'feature')
      const session = usePromptSessions.getState().approveProposed(proposed.id)!
      return { el: mount(createElement(EpicDetail, { promptSession: session })), session, usePromptSessions }
    }

    function typeTitle(input: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    it('Save calls renameEpic with the new title and the UNCHANGED goal', async () => {
      const { el, session, usePromptSessions } = await mountEpic()
      const renameEpic = vi.spyOn(usePromptSessions.getState(), 'renameEpic').mockResolvedValue(undefined)

      act(() => (el.querySelector('[data-testid="epic-detail-title-edit"]') as HTMLButtonElement).click())
      const input = el.querySelector('[data-testid="epic-detail-title-input"]') as HTMLInputElement
      expect(input.value).toBe('Ship it')
      const save = el.querySelector('[data-testid="epic-detail-title-save"]') as HTMLButtonElement
      expect(save.disabled).toBe(true)

      typeTitle(input, 'Renamed')
      expect(save.disabled).toBe(false)
      act(() => save.click())
      await flushAsync(2)

      expect(renameEpic).toHaveBeenCalledWith(session.id, 'Renamed', 'Get it out the door.')
    })

    it('Cancel discards the edit and restores the heading', async () => {
      const { el, usePromptSessions } = await mountEpic()
      const renameEpic = vi.spyOn(usePromptSessions.getState(), 'renameEpic').mockResolvedValue(undefined)

      act(() => (el.querySelector('[data-testid="epic-detail-title-edit"]') as HTMLButtonElement).click())
      typeTitle(el.querySelector('[data-testid="epic-detail-title-input"]') as HTMLInputElement, 'Renamed')
      act(() => (el.querySelector('[data-testid="epic-detail-title-cancel"]') as HTMLButtonElement).click())

      expect(renameEpic).not.toHaveBeenCalled()
      expect(el.querySelector('[data-testid="epic-detail-title-input"]')).toBeNull()
      expect(el.querySelector('h1')?.textContent).toBe('Ship it')
    })

    it('offers no editor for the goal paragraph — it is the already-sent first prompt', async () => {
      const { el } = await mountEpic()
      expect(el.textContent).toContain('Get it out the door.')
      expect(el.querySelector('textarea[data-testid*="goal"]')).toBeNull()
    })
  })

  it('renders the Agent+model chip with the persona name and pretty-formatted model when the persona has an explicit model', async () => {
    installWindowApiMock({ personas: [{ name: 'architect', model: 'claude-sonnet-4-5' }] })
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature', undefined, 'architect')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    const chip = el.querySelector('[data-testid="epic-agent-tag"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('architect')
    expect(chip?.textContent).toContain('Sonnet 4.5')
  })

  it('renders the Agent chip with just the persona name (no model) when the persona model is inherit/unset', async () => {
    installWindowApiMock({ personas: [{ name: 'dev-lead', model: 'inherit' }] })
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature', undefined, 'dev-lead')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    const chip = el.querySelector('[data-testid="epic-agent-tag"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toBe('dev-lead')
  })

  it('renders no Agent chip at all when the Epic has no agentType', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    expect(el.querySelector('[data-testid="epic-agent-tag"]')).toBeNull()
  })

  it('renders the Epic cwd\'s branch next to the ProjectTag when useBranch resolves one', async () => {
    installWindowApiMock({ branch: 'epic/contextual-chat' })
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    expect(el.querySelector('[data-testid="epic-detail-branch"]')).toBeNull()
  })

  it('renders "Resume" instead of "Mark completed" for a completed Epic', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Fix the bug', 'bug')
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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

  it('does not double-render an assistant reply as both a chat Turn and a duplicate ResponseEvent', async () => {
    // chat.ts's onComplete handler appends a 'response' PromptSessionEvent
    // (for the cross-Epic "toast if unfocused" signal, promptSessions.ts's
    // mergeAppendedEvent) alongside pushing the real assistant Turn — both
    // land in this Epic's own store. When viewing THIS Epic, the ResponseEvent
    // must be suppressed since the Turn already shows the same text in full;
    // a genuinely out-of-band 'response' (no matching turn) must still render.
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            { id: 't-user', role: 'user', text: 'do the thing', at: 1000 },
            { id: 't-assistant', role: 'assistant', text: 'done — here is the result', at: 2000 },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: 'done — here is the result',
    })
    const tailAfterFirst = usePromptSessions.getState().events[session.id].slice(-1)[0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: tailAfterFirst.id,
      text: 'PRD 9-widget finished: completed. Check Scheduler for details.',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const turnBubbles = el.querySelectorAll('[id^="epic-detail-turn-"]')
    expect(turnBubbles).toHaveLength(2)
    const responseEvents = el.querySelectorAll('[data-testid="epic-response-event"]')
    expect(responseEvents).toHaveLength(1)
    expect(responseEvents[0].textContent).toContain('PRD 9-widget finished')
    expect(el.textContent).not.toMatch(/done — here is the result.*done — here is the result/s)
  })

  it('does not double-render a long stop-signal assistant reply as both a Turn and a duplicate ResponseEvent', async () => {
    // The surviving assistant Turn may hold the JSONL feed's FULL text
    // (sentinel + questions-JSON tail included, per state/chat.ts's
    // reconciliation rule), while appendResponseEvent persists the
    // stop-signal-stripped `answerBody`, truncated to RESPONSE_EVENT_PREVIEW_MAX
    // (2000) chars with a trailing '…' for a long reply. isDuplicateResponseEvent
    // must match the truncated, stripped ResponseEvent text against the
    // stop-signal-stripped form of the Turn's text, not the raw Turn text.
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    const longBody = 'Here is a very long answer. '.repeat(100) // > 2000 chars
    const fullText = `${longBody}\n\n<<<SM_NEEDS_INPUT>>>\n${JSON.stringify({ questions: ['Deploy to prod now?'] })}`
    const truncatedPreview = `${longBody.slice(0, 2000)}…`

    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            { id: 't-user', role: 'user', text: 'do the thing', at: 1000 },
            { id: 't-assistant', role: 'assistant', text: fullText, at: 2000 },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: truncatedPreview,
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const turnBubbles = el.querySelectorAll('[id^="epic-detail-turn-"]')
    expect(turnBubbles).toHaveLength(2)
    const responseEvents = el.querySelectorAll('[data-testid="epic-response-event"]')
    expect(responseEvents).toHaveLength(0)
  })

  it('tones a response event\'s accessible text by outcome, and falls back to neutral when outcome is absent', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: 'PRD 976-foo finished: failed. Check Scheduler for details.',
      prdSlug: '976-foo',
      outcome: 'failed',
    })
    const tailAfterFirst = usePromptSessions.getState().events[session.id].slice(-1)[0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: tailAfterFirst.id,
      text: 'no outcome on this one',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const responseEvents = el.querySelectorAll('[data-testid="epic-response-event"]')
    expect(responseEvents).toHaveLength(2)
    expect(responseEvents[0].getAttribute('aria-label')).toBe('PRD 976-foo — failed')
    expect(responseEvents[1].getAttribute('aria-label')).toBeNull()
  })

  it('CORE: a response event with outcome "needs_review" (rcaReport.cjs\'s routed question) renders amber-tinted and marked as a question aimed at the human, distinct from an ordinary completed/failed outcome', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: 'Root-cause report: runs/123/root-cause-980-fix.md',
      prdSlug: '980-fix',
      outcome: 'needs_review',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const responseEvent = el.querySelector('[data-testid="epic-response-event"]')!
    expect(responseEvent).toBeTruthy()
    expect(responseEvent.querySelector('[data-testid="epic-response-question-marker"]')?.textContent).toContain(
      'Question aimed at you',
    )
    // AMBER_TEXT/AMBER_TINT (not STATUS_TONE.needs_review's neutral butter pill).
    expect(responseEvent.className).toMatch(/#8e641a/)
    expect(responseEvent.getAttribute('aria-label')).toContain('Question routed back from a scheduler run')
  })

  it('renders the "closed" event as a terminator rule (EventDivider), not plain centered text', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'closed',
      causedByEventId: initialEvent.id,
      text: 'done',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const closedEvent = el.querySelector('[data-testid="epic-closed-event"]')!
    expect(closedEvent).toBeTruthy()
    expect(closedEvent.querySelector('[data-testid="event-divider"]')).toBeTruthy()
  })

  it('wires onQuote into the Discussion timeline\'s Turn so its hover Quote button reports the turn text', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [{ id: 't-1', role: 'user', text: 'quote me please', at: 1000 }],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const onQuote = vi.fn()
    const el = mount(createElement(EpicDetail, { promptSession: session, onQuote }))

    const quoteBtn = el.querySelector('[data-testid="chat-turn-quote"]') as HTMLButtonElement
    expect(quoteBtn).not.toBeNull()
    act(() => quoteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onQuote).toHaveBeenCalledWith('quote me please')
  })

  it('omits the Quote button entirely when onQuote is not passed', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [{ id: 't-1', role: 'user', text: 'no quote here', at: 1000 }],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    expect(el.querySelector('[data-testid="chat-turn-quote"]')).toBeNull()
  })

  it('renders a needs-input turn with the red "NEEDS YOUR DECISION" styling', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

    const sessionA = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic A', 'feature')
    const sessionB = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic B', 'feature')

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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
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

    const sessionA = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic A', 'feature')
    const sessionB = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Epic B', 'feature')
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

  it('tones the dispatched-PRD chip green with "completed" wording when its queue job is completed', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '5-widget',
    })
    useScheduleState.setState({ snapshot: { jobs: [{ slug: '5-widget', status: 'completed' } as any] } as any, loaded: true })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    expect(chip.getAttribute('title')).toContain('completed')
    expect(chip.getAttribute('aria-label')).toContain('completed')
    expect(chip.className).toContain('bg-sage')
  })

  it('tones the dispatched-PRD chip yellow with "needs review" wording when its queue job is needs_review', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '6-widget',
    })
    useScheduleState.setState({ snapshot: { jobs: [{ slug: '6-widget', status: 'needs_review' } as any] } as any, loaded: true })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    expect(chip.getAttribute('title')).toContain('needs review')
    expect(chip.getAttribute('aria-label')).toContain('needs review')
    expect(chip.className).toContain('bg-butter')
  })

  it('tones the dispatched-PRD chip red with "failed" wording when its queue job is failed', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '7-widget',
    })
    useScheduleState.setState({ snapshot: { jobs: [{ slug: '7-widget', status: 'failed' } as any] } as any, loaded: true })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    expect(chip.getAttribute('title')).toContain('failed')
    expect(chip.getAttribute('aria-label')).toContain('failed')
    expect(chip.className).toContain('bg-accent')
  })

  it('falls back to the neutral "ready to run" tone with no crash when the PRD has no matching queue job', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '8-archived-widget',
    })
    useScheduleState.setState({ snapshot: { jobs: [] } as any, loaded: true })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    expect(chip.getAttribute('title')).toContain('ready to run')
    expect(chip.getAttribute('aria-label')).toContain('ready to run')
    expect(chip.className).toContain('bg-bg')
  })

  it('CORE (PRD 987): the dispatched-PRD chip renders the CLAIMED tone — never green — when the job self-reports completed but the Epic has not yet verified it', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '972-claimed-widget',
    })
    const afterCreate = usePromptSessions.getState().events[session.id].slice(-1)[0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: afterCreate.id,
      text: 'PRD 972-claimed-widget finished: completed. Check Scheduler for details.',
      prdSlug: '972-claimed-widget',
      outcome: 'completed',
      validation: 'unvalidated',
    })
    useScheduleState.setState({
      snapshot: { jobs: [{ slug: '972-claimed-widget', status: 'completed' } as any] } as any,
      loaded: true,
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    expect(chip.getAttribute('title')).toContain('claimed')
    expect(chip.getAttribute('title')).toContain('not yet verified')
    expect(chip.getAttribute('aria-label')).toContain('claimed')
    expect(chip.className).not.toContain('bg-sage')
  })

  it('the dispatched-PRD chip renders green with a "verified" label once the Epic validates the completed job', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '974-verified-widget',
    })
    const afterCreate = usePromptSessions.getState().events[session.id].slice(-1)[0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: afterCreate.id,
      text: 'PRD 974-verified-widget finished: completed. Check Scheduler for details.',
      prdSlug: '974-verified-widget',
      outcome: 'completed',
      validation: 'verified',
    })
    useScheduleState.setState({
      snapshot: { jobs: [{ slug: '974-verified-widget', status: 'completed' } as any] } as any,
      loaded: true,
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    expect(chip.getAttribute('title')).toContain('verified')
    expect(chip.getAttribute('aria-label')).toContain('verified')
    expect(chip.className).toContain('bg-sage')
  })

  it('the dispatched-PRD chip renders red with a "refuted" label when the Epic refutes a claimed-completed job', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useScheduleState } = await import('../../../state/scheduleState')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: '976-refuted-widget',
    })
    const afterCreate = usePromptSessions.getState().events[session.id].slice(-1)[0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: afterCreate.id,
      text: 'PRD 976-refuted-widget finished: completed. Check Scheduler for details.',
      prdSlug: '976-refuted-widget',
      outcome: 'completed',
      validation: 'refuted',
    })
    useScheduleState.setState({
      snapshot: { jobs: [{ slug: '976-refuted-widget', status: 'completed' } as any] } as any,
      loaded: true,
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    expect(chip.getAttribute('title')).toContain('refuted')
    expect(chip.getAttribute('aria-label')).toContain('refuted')
    expect(chip.className).toContain('bg-accent')
  })

  it('CORE (PRD 987): a response event with outcome completed but validation unvalidated renders the CLAIMED tone in its accessible label, never "completed"', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: 'PRD 972-claimed finished: completed. Check Scheduler for details.',
      prdSlug: '972-claimed',
      outcome: 'completed',
      validation: 'unvalidated',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const responseEvent = el.querySelector('[data-testid="epic-response-event"]')!
    expect(responseEvent.getAttribute('aria-label')).toContain('claimed')
    expect(responseEvent.getAttribute('aria-label')).toContain('not yet verified')
    expect(responseEvent.getAttribute('aria-label')).not.toBe('PRD 972-claimed — completed')
  })

  it('a response event with validation verified renders "verified" in green', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: 'PRD 974-verified finished: completed. Check Scheduler for details.',
      prdSlug: '974-verified',
      outcome: 'completed',
      validation: 'verified',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const responseEvent = el.querySelector('[data-testid="epic-response-event"]')!
    expect(responseEvent.getAttribute('aria-label')).toBe('PRD 974-verified — verified')
    expect(responseEvent.className).toContain('bg-sage')
  })

  it('a response event with validation refuted renders "refuted" in red', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: 'PRD 976-refuted finished: completed. Check Scheduler for details.',
      prdSlug: '976-refuted',
      outcome: 'completed',
      validation: 'refuted',
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const responseEvent = el.querySelector('[data-testid="epic-response-event"]')!
    expect(responseEvent.getAttribute('aria-label')).toBe('PRD 976-refuted — refuted')
    expect(responseEvent.className).toContain('bg-accent')
  })

  it('shows the goal as seed context with no crash when there are no chat turns yet', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'A brand new Epic with no turns', 'discussion')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const seed = el.querySelector('[data-testid="epic-seed-goal"]')
    expect(seed).not.toBeNull()
    expect(seed!.textContent).toContain('A brand new Epic with no turns')
  })

  describe('Epic-intake AIM card (PRD session-chat-conversion-into-simplified-chat)', () => {
    it('CORE: renders the first turn as the AIM briefing card when the Epic carries composeEpicIntake sections', async () => {
      installWindowApiMock()
      const { usePromptSessions } = await import('../../../state/promptSessions')
      const { useChat } = await import('../../../state/chat')
      const { EpicDetail } = await import('../EpicDetail')

      const openingPrompt = 'You are acting as the "debugger" agent: desc.\n\nGoal: Fix it\n\nDetails.'
      const session = await usePromptSessions.getState().createPromptSession(
        '/tmp/proj',
        'Fix it',
        'bug',
        undefined,
        undefined,
        openingPrompt,
        [
          { kind: 'actor', label: 'Actor', text: 'You are acting as the "debugger" agent: desc.', source: 'debugger' },
          { kind: 'goal', label: 'Goal', text: 'Goal: Fix it\n\nDetails.' },
        ],
      )
      useChat.setState({
        chats: {
          [session.id]: {
            turns: [{ id: 't-first', role: 'user', text: openingPrompt, at: 1000 }],
            running: false,
            stream: '',
            queuedPosition: 0,
          } as any,
        },
      })

      const el = mount(createElement(EpicDetail, { promptSession: session }))

      expect(el.querySelector('[data-testid="epic-intake-card"]')).not.toBeNull()
      // The flat fallback bubble's own footer marker must NOT also render —
      // this turn is replaced by the card, not wrapped by both.
      expect(el.querySelector('[data-testid="chat-turn-user-footer"]')).toBeNull()
    })

    it('EDGE: falls back to the flat-text Turn bubble when the Epic has no `sections` field (a pre-existing Epic)', async () => {
      installWindowApiMock()
      const { usePromptSessions } = await import('../../../state/promptSessions')
      const { useChat } = await import('../../../state/chat')
      const { EpicDetail } = await import('../EpicDetail')

      // createPromptSession with no openingPrompt/sections args mirrors every
      // Epic minted before this PRD — the field is simply absent on the
      // record, not present-but-empty.
      const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Fix it', 'bug')
      expect(session.sections).toBeUndefined()

      useChat.setState({
        chats: {
          [session.id]: {
            turns: [{ id: 't-first', role: 'user', text: 'Fix it', at: 1000 }],
            running: false,
            stream: '',
            queuedPosition: 0,
          } as any,
        },
      })

      const el = mount(createElement(EpicDetail, { promptSession: session }))

      expect(el.querySelector('[data-testid="epic-intake-card"]')).toBeNull()
      expect(el.querySelector('[data-testid="chat-turn-user-footer"]')).not.toBeNull()
      expect(el.textContent).toContain('Fix it')
    })

    it('EDGE: a non-first user turn never renders as the AIM card even when the Epic carries sections', async () => {
      installWindowApiMock()
      const { usePromptSessions } = await import('../../../state/promptSessions')
      const { useChat } = await import('../../../state/chat')
      const { EpicDetail } = await import('../EpicDetail')

      const session = await usePromptSessions.getState().createPromptSession(
        '/tmp/proj',
        'Fix it',
        'bug',
        undefined,
        undefined,
        'Goal: Fix it',
        [{ kind: 'goal', label: 'Goal', text: 'Goal: Fix it' }],
      )
      useChat.setState({
        chats: {
          [session.id]: {
            turns: [
              { id: 't-first', role: 'user', text: 'Goal: Fix it', at: 1000 },
              { id: 't-second', role: 'user', text: 'A follow-up message', at: 2000 },
            ],
            running: false,
            stream: '',
            queuedPosition: 0,
          } as any,
        },
      })

      const el = mount(createElement(EpicDetail, { promptSession: session }))

      const cards = el.querySelectorAll('[data-testid="epic-intake-card"]')
      expect(cards).toHaveLength(1)
      expect(el.textContent).toContain('A follow-up message')
    })
  })
})
