// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

/**
 * EpicDetail (PRD 827-epic-detail-view) — the right-pane Epic detail shell +
 * Discussion view, superseding PromptSessionConversation.tsx as the Epic
 * conversation surface (retirement itself is PRD 829, not here).
 *
 * window.api is stubbed once in beforeAll, before EpicDetail/promptSessions
 * (whose module-load IPC wiring only fires if window.api exists at import
 * time) are themselves imported exactly once — chat.ts/promptSessions.ts's
 * module-load IPC wiring only fires if window.api exists at import time.
 * Each test re-stubs window.api when it needs different mock responses
 * (installWindowApiMock reassigns window.api; functions read it at call
 * time, not at import time). Store state is reset between tests instead of
 * re-importing the modules (PRD 1510).
 */

let usePromptSessions: typeof import('../../../state/promptSessions').usePromptSessions
let _resetForTests: typeof import('../../../state/promptSessions')._resetForTests
let useChat: typeof import('../../../state/chat').useChat
let useScheduleState: typeof import('../../../state/scheduleState').useScheduleState
let EpicDetail: typeof import('../EpicDetail').EpicDetail

function installWindowApiMock(opts: {
  branch?: string | null
  personas?: Array<{ name: string; model: string | null }>
  /** Mocked `agents:resolve-model-info` main-half result. `null` rejects the
   *  call (IPC-failure edge case); omit for the harmless default fallback. */
  runtimeInfo?: Record<string, unknown> | null
} = {}) {
  const listPrds = vi.fn().mockResolvedValue([])
  const resolveModelInfo = vi.fn().mockImplementation(({ agentType }: { cwd: string; agentType: string }) => {
    if (opts.runtimeInfo === null) return Promise.reject(new Error('IPC unavailable'))
    return Promise.resolve({
      agentType,
      modelAlias: null,
      modelSource: 'fallback',
      resolvedModelId: null,
      resolvedFrom: null,
      effortEnvReachable: false,
      personaEffort: null,
      personaEffortSource: null,
      ...opts.runtimeInfo,
    })
  })
  const api = {
    app: {
      gitBranch: vi.fn().mockResolvedValue(opts.branch ?? null),
      homeDir: vi.fn().mockResolvedValue('/home/bilko'),
    },
    agents: {
      listPersonas: vi.fn().mockResolvedValue(opts.personas ?? []),
      resolveModelInfo,
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
    epicDelegationStats: { get: vi.fn().mockResolvedValue({ prdsQueued: 0, inlineEdits: 0 }) },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
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
  beforeAll(async () => {
    installWindowApiMock()
    ;({ usePromptSessions, _resetForTests } = await import('../../../state/promptSessions'))
    ;({ useChat } = await import('../../../state/chat'))
    ;({ useScheduleState } = await import('../../../state/scheduleState'))
    ;({ EpicDetail } = await import('../EpicDetail'))
  })

  beforeEach(() => {
    _resetForTests()
    useChat.setState({ chats: {} })
    useScheduleState.setState({ snapshot: null, loaded: false })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    vi.restoreAllMocks()
  })

  it('renders status/kind chips and "Mark completed" for an active Epic', async () => {
    installWindowApiMock()

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
    // First test in the file pays the cold transform of EpicDetail's whole import graph.
    // Measured (12 isolated runs, 28 busy-loop procs on 14 cores): p50 5.7s, p95 9.5s vs
    // 1.4-1.8s idle; it exceeded the 15s global default under full-suite contention.
  }, 60_000)

  describe('editable title (full view)', () => {
    async function mountEpic() {
      installWindowApiMock()
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

  it('caps the header title with an inner scroll so a huge title cannot crowd out the transcript', async () => {
    installWindowApiMock()
    const title = 'A short title'
    const session = await usePromptSessions
      .getState()
      .createPromptSession('/tmp/proj', `${title}\n\n${'A very long goal sentence. '.repeat(200)}`, 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const h1 = el.querySelector('[data-testid="epic-detail-title"]') as HTMLElement
    expect(h1.className).toContain('max-h-')
    expect(h1.className).toContain('overflow-y-auto')
    expect(h1.className).toContain('font-serif')
    expect(h1.getAttribute('title')).toBe(title)
  })

  it('clamps the goal to one line by default and offers a "more" toggle for a long goal', async () => {
    installWindowApiMock()
    const longGoal = 'A very long goal sentence. '.repeat(10) // > 120 chars
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', `Ship it\n\n${longGoal}`, 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const goal = el.querySelector('[data-testid="epic-detail-goal"]') as HTMLElement
    expect(goal.className).toContain('line-clamp-1')
    const more = el.querySelector('[data-testid="epic-detail-goal-more"]') as HTMLButtonElement
    expect(more).not.toBeNull()
    expect(more.textContent).toBe('more')

    act(() => more.click())
    expect((el.querySelector('[data-testid="epic-detail-goal"]') as HTMLElement).className).not.toContain('line-clamp-1')
    const less = el.querySelector('[data-testid="epic-detail-goal-more"]') as HTMLButtonElement
    expect(less.textContent).toBe('less')

    act(() => less.click())
    expect((el.querySelector('[data-testid="epic-detail-goal"]') as HTMLElement).className).toContain('line-clamp-1')
  })

  it('omits the "more" toggle when the goal is short enough to fit on one line', async () => {
    installWindowApiMock()
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it\n\nGet it out the door.', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    expect(el.querySelector('[data-testid="epic-detail-goal-more"]')).toBeNull()
  })

  it('renders the Agent chip with the persona name and a condensed model family when the persona has an explicit override', async () => {
    installWindowApiMock({
      runtimeInfo: { modelAlias: 'claude-sonnet-4-5', modelSource: 'persona', resolvedModelId: 'claude-sonnet-4-5', resolvedFrom: 'transcript' },
    })

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature', undefined, 'architect')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    const chip = el.querySelector('[data-testid="epic-agent-tag"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toBe('architect · sonnet')
    // The tag's title carries the full verbose, evidence-backed line (not the
    // condensed text shown in the button itself) — hovering surfaces it,
    // matching formatEffectiveRuntimeLine's own text.
    expect(chip?.getAttribute('title')).toContain('Sonnet 4.5')
  })

  it('renders the Agent chip labeled "inherited" (not an explicit choice) when the persona model is inherit/unset', async () => {
    installWindowApiMock({
      runtimeInfo: { modelAlias: null, modelSource: 'inherit', resolvedModelId: null, resolvedFrom: null },
    })

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature', undefined, 'dev-lead')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    const chip = el.querySelector('[data-testid="epic-agent-tag"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toBe('dev-lead · inherited')
  })

  it('renders no Agent chip at all when the Epic has no agentType', async () => {
    installWindowApiMock()

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    expect(el.querySelector('[data-testid="epic-agent-tag"]')).toBeNull()
  })

  it('renders the Epic cwd\'s branch in the compact meta line when useBranch resolves one', async () => {
    installWindowApiMock({ branch: 'epic/contextual-chat' })

    // Unique cwd: useBranch.ts caches git-branch lookups per cwd for 30s —
    // a cwd shared with another test's differently-stubbed branch would read
    // that test's cached value instead of this test's mock.
    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj-branch-a', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    const metaLine = el.querySelector('[data-testid="epic-detail-meta-line"]')
    expect(metaLine).not.toBeNull()
    expect(metaLine?.textContent).toBe('epic/contextual-chat')
  })

  it('hides the compact meta line cleanly when there is no agent and useBranch resolves null', async () => {
    installWindowApiMock({ branch: null })

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj-branch-null', 'Ship it', 'feature')

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    expect(el.querySelector('[data-testid="epic-detail-meta-line"]')).toBeNull()
  })

  it('CORE: the compact meta line joins agent · model · effort · branch into one mono string, with the agent segment staying clickable', async () => {
    installWindowApiMock({
      branch: 'sm-epic/introduce-second-action',
      runtimeInfo: {
        modelAlias: 'opus',
        modelSource: 'persona',
        resolvedModelId: 'claude-opus-5',
        resolvedFrom: 'transcript',
        personaEffort: 'medium',
        personaEffortSource: 'persona',
      },
    })

    const proposed = await usePromptSessions.getState().createPromptSession('/tmp/proj-branch-b', 'Ship it', 'feature', undefined, 'architect')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    const el = mount(createElement(EpicDetail, { promptSession: session }))
    await flushAsync(2)

    const metaLine = el.querySelector('[data-testid="epic-detail-meta-line"]') as HTMLElement
    expect(metaLine).not.toBeNull()
    expect(metaLine.className).toContain('font-mono')
    expect(metaLine.className).toContain('truncate')
    expect(metaLine.textContent).toBe('architect · opus · effort medium · sm-epic/introduce-second-action')

    const agentBtn = metaLine.querySelector('[data-testid="epic-agent-tag"]') as HTMLButtonElement
    expect(agentBtn).not.toBeNull()
    expect(agentBtn.tagName).toBe('BUTTON')
  })

  it('suffixes the branch segment with the worktree status when it is not the normal active/isolated state', async () => {
    installWindowApiMock()

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    usePromptSessions.setState({
      sessions: {
        ...usePromptSessions.getState().sessions,
        [session.id]: {
          ...session,
          worktree: { dir: '/tmp/wt', branch: 'sm-epic/foo', baseCwd: '/tmp/proj', status: 'needs_merge_resolution' },
        },
      },
    })
    const withWorktree = usePromptSessions.getState().sessions[session.id]

    const el = mount(createElement(EpicDetail, { promptSession: withWorktree }))
    await flushAsync(2)

    expect(el.querySelector('[data-testid="epic-detail-meta-line"]')?.textContent).toBe('sm-epic/foo (merge conflict)')
  })

  it('CORE: the turns-ago caption counts only user+assistant turns, not transcript-feed event turns', async () => {
    installWindowApiMock()

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const now = Date.now()
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [
            { id: 't-user', role: 'user', text: 'do the thing', at: now - 20_000 },
            { id: 't-assistant', role: 'assistant', text: 'done', at: now - 10_000 },
            { id: 't-event', role: 'event', text: 'tool_use', at: now - 5_000, kind: 'tool_use' },
          ],
          running: false,
          stream: '',
          queuedPosition: 0,
        } as any,
      },
    })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const turnsAgo = el.querySelector('[data-testid="epic-detail-turns-ago"]') as HTMLElement
    expect(turnsAgo).not.toBeNull()
    expect(turnsAgo.textContent).toMatch(/^2 turns · /)
    expect(turnsAgo.textContent).not.toMatch(/^3 turns/)
    expect(turnsAgo.getAttribute('title')).toContain('opened')
    expect(turnsAgo.getAttribute('title')).toContain('tool calls')
    expect(turnsAgo.getAttribute('title')).toContain(`session ${session.claudeSessionId}`)
  })

  it('renders "Resume" instead of "Mark completed" for a completed Epic', async () => {
    installWindowApiMock()

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

  it('CORE: a response event with outcome "needs_review" (a grouped scheduler notice) renders amber-tinted and marked as a scheduler notice, distinct from an ordinary completed/failed outcome', async () => {
    installWindowApiMock()

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
      'Scheduler notice — PRD stopped',
    )
    // AMBER_TEXT/AMBER_TINT (not STATUS_TONE.needs_review's neutral butter pill).
    expect(responseEvent.className).toMatch(/#8e641a/)
    expect(responseEvent.getAttribute('aria-label')).toContain('Scheduler notice from a stopped PRD')
  })

  it('renders the "closed" event as a terminator rule (EventDivider), not plain centered text', async () => {
    installWindowApiMock()

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

    // The user bubble's "you · <age>" caption moved to its title attribute
    // (chat-turn-visuals restyle) — it's no longer in the visible text.
    const userBubble = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'Hello')!
    expect(userBubble.getAttribute('title')).toContain('you · just now')
    expect(el.textContent).toContain('claude · just now')
  })

  it('resets the view tab back to Discussion when the Epic changes', async () => {
    installWindowApiMock()

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
    expect(live!.querySelector('[data-testid="tool-strip-toggle"]')?.textContent).toContain('Bash · 1 tool')
  })

  it('replaces the live bubble with the finished turn on chat:run:complete, with no duplicated text', async () => {
    installWindowApiMock()

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

  it.each([
    { name: 'green "completed"', slug: '5-widget', status: 'completed', validation: undefined, words: ['completed'], tone: 'bg-sage' },
    { name: 'yellow "needs review"', slug: '6-widget', status: 'needs_review', validation: undefined, words: ['needs review'], tone: 'bg-butter' },
    { name: 'red "failed"', slug: '7-widget', status: 'failed', validation: undefined, words: ['failed'], tone: 'bg-accent' },
    { name: 'verified green', slug: '974-verified-widget', status: 'completed', validation: 'verified', words: ['verified'], tone: 'bg-sage' },
    { name: 'refuted red', slug: '976-refuted-widget', status: 'completed', validation: 'refuted', words: ['refuted'], tone: 'bg-accent' },
  ])('dispatched-PRD chip tone: $name for job status $status / validation $validation', async ({ slug, status, validation, words, tone }) => {
    installWindowApiMock()

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]
    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: initialEvent.id,
      prdSlug: slug,
    })
    if (validation) {
      const afterCreate = usePromptSessions.getState().events[session.id].slice(-1)[0]
      usePromptSessions.getState().appendPromptSessionEvent(session.id, {
        kind: 'response',
        causedByEventId: afterCreate.id,
        text: `PRD ${slug} finished: completed. Check Scheduler for details.`,
        prdSlug: slug,
        outcome: 'completed',
        validation,
      } as any)
    }
    useScheduleState.setState({ snapshot: { jobs: [{ slug, status } as any] } as any, loaded: true })

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const chip = el.querySelector('[data-testid="epic-prd-event"] button')!
    for (const w of words) {
      expect(chip.getAttribute('title')).toContain(w)
      expect(chip.getAttribute('aria-label')).toContain(w)
    }
    expect(chip.className).toContain(tone)
  })

  it('falls back to the neutral "ready to run" tone with no crash when the PRD has no matching queue job', async () => {
    installWindowApiMock()

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

  it.each([
    { validation: 'unvalidated', slug: '972-claimed' },
    { validation: 'verified', slug: '974-verified' },
    { validation: 'refuted', slug: '976-refuted' },
  ])('response event with outcome completed / validation $validation renders the right accessible label and tone', async ({ validation, slug }) => {
    installWindowApiMock()

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const initialEvent = usePromptSessions.getState().events[session.id][0]

    usePromptSessions.getState().appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: initialEvent.id,
      text: `PRD ${slug} finished: completed. Check Scheduler for details.`,
      prdSlug: slug,
      outcome: 'completed',
      validation,
    } as any)

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const label = el.querySelector('[data-testid="epic-response-event"]')!.getAttribute('aria-label')
    const cls = el.querySelector('[data-testid="epic-response-event"]')!.className
    if (validation === 'unvalidated') {
      // CORE (PRD 987): CLAIMED tone, never plain "completed"
      expect(label).toContain('claimed')
      expect(label).toContain('not yet verified')
      expect(label).not.toBe('PRD 972-claimed — completed')
    } else {
      expect(label).toBe(`PRD ${slug} — ${validation}`)
      expect(cls).toContain(validation === 'verified' ? 'bg-sage' : 'bg-accent')
    }
  })

  it('shows the goal as seed context with no crash when there are no chat turns yet', async () => {
    installWindowApiMock()

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'A brand new Epic with no turns', 'discussion')

    const el = mount(createElement(EpicDetail, { promptSession: session }))

    const seed = el.querySelector('[data-testid="epic-seed-goal"]')
    expect(seed).not.toBeNull()
    expect(seed!.textContent).toContain('A brand new Epic with no turns')
  })

  describe('Detail dial + hidden-events divider (PRD 1468)', () => {
    it('CORE: the active verbosity segment is filled accent, inactive segments are dim text', async () => {
      installWindowApiMock()

      const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
      const el = mount(createElement(EpicDetail, { promptSession: session }))

      // Default verbosity is 'standard' (CHAT_VERBOSITY_DEFAULT).
      const active = el.querySelector('[data-testid="epic-verbosity-standard"]') as HTMLButtonElement
      expect(active.className).toContain('bg-accent')
      expect(active.className).toContain('text-white')

      const inactive = el.querySelector('[data-testid="epic-verbosity-raw"]') as HTMLButtonElement
      expect(inactive.className).not.toContain('bg-accent')
      expect(inactive.className).toContain('text-fg-dim')

      expect(el.querySelector('[data-testid="epic-verbosity-hidden-count"]')).toBeNull()
    })

    it('reads "conversation" with no count when nothing is hidden', async () => {
      installWindowApiMock()

      const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
      useChat.setState({
        chats: {
          [session.id]: {
            turns: [{ id: 't-user', role: 'user', text: 'do the thing', at: 1000 }],
            running: false,
            stream: '',
            queuedPosition: 0,
          } as any,
        },
      })

      const el = mount(createElement(EpicDetail, { promptSession: session }))

      const divider = el.querySelector('[data-testid="epic-hidden-events-divider"]') as HTMLElement
      expect(divider).not.toBeNull()
      expect(divider.textContent).toContain('conversation')
      expect(divider.textContent).not.toContain('hidden')
    })

    it('CORE: shows the hidden-events divider text and reveals the hidden level on click', async () => {
      installWindowApiMock()

      const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
      useChat.setState({
        chats: {
          [session.id]: {
            turns: [
              { id: 't-user', role: 'user', text: 'do the thing', at: 1000 },
              // 'tool_use' is a DETAIL-level event — hidden at the default
              // 'standard' verbosity (chatVerbosity.ts's DETAIL_EVENT_KINDS).
              { id: 't-tool', role: 'event', kind: 'tool_use', text: 'Bash', at: 1500 },
              { id: 't-assistant', role: 'assistant', text: 'done', at: 2000 },
            ],
            running: false,
            stream: '',
            queuedPosition: 0,
          } as any,
        },
      })

      const el = mount(createElement(EpicDetail, { promptSession: session }))

      const divider = el.querySelector('[data-testid="epic-hidden-events-divider"]') as HTMLButtonElement
      expect(divider).not.toBeNull()
      expect(divider.textContent).toContain('conversation · 1 low-level events hidden')

      act(() => divider.dispatchEvent(new MouseEvent('click', { bubbles: true })))

      // Revealed to 'detail' — the dial's active segment moves, and the
      // divider reports nothing left hidden.
      expect((el.querySelector('[data-testid="epic-verbosity-detail"]') as HTMLElement).className).toContain('bg-accent')
      expect((el.querySelector('[data-testid="epic-hidden-events-divider"]') as HTMLElement).textContent).toBe('conversation')
    })
  })

  describe('Epic-intake AIM card (PRD session-chat-conversion-into-simplified-chat)', () => {
    it('CORE: renders the first turn as the AIM briefing card when the Epic carries composeEpicIntake sections', async () => {
      installWindowApiMock()

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
