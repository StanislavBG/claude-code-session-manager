import { describe, it, expect, beforeEach, vi } from 'vitest'

function installWindowApiMock() {
  const api = {
    pty: { kill: vi.fn() },
    watchers: { killTab: vi.fn().mockResolvedValue(undefined) },
    transcripts: {
      closeTab: vi.fn().mockResolvedValue(undefined),
      pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'),
    },
    sessions: {
      load: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null, freshStart: false }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    chat: {
      cancel: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue({ ok: true }),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
    },
  }
  vi.stubGlobal('window', { api })
  return api
}

describe('promptSessions.ts', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('createPromptSession mints a session id distinct from every open SessionTab id/sessionId', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { usePromptSessions } = await import('../promptSessions')

    useSessions.getState().addTab({ id: 'tab-1', cwd: '/proj', startupCommand: null, dormant: true })
    useSessions.getState().addTab({ id: 'tab-2', cwd: '/proj', startupCommand: null, dormant: true })
    const tabsBefore = useSessions.getState().tabs.map((t) => ({ ...t }))

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Build the widget')

    expect(session.claudeSessionId).toBeTruthy()
    for (const tab of useSessions.getState().tabs) {
      expect(tab.id).not.toBe(session.claudeSessionId)
      expect(tab.sessionId).not.toBe(session.claudeSessionId)
    }
    expect(session.id).not.toBe(session.claudeSessionId)
    expect(session.status).toBe('active')
    expect(session.completedAt).toBeNull()

    // createPromptSession must not reuse or mutate any existing SessionTab.
    expect(useSessions.getState().tabs).toEqual(tabsBefore)

    // First event is auto-appended and has no cause.
    const events = usePromptSessions.getState().events[session.id]
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('prompt')
    expect(events[0].causedByEventId).toBeNull()
  })

  it('appends a valid chain prompt -> prd_created -> response -> prd_created -> response -> closed', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    const events = usePromptSessions.getState().events[session.id]
    const promptEvent = events[0]

    const prd1 = store.appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: promptEvent.id,
      prdSlug: '900-ship-the-feature',
    })
    expect(prd1.causedByEventId).toBe(promptEvent.id)

    const resp1 = store.appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: prd1.id,
      text: 'first pass done',
    })
    expect(resp1.causedByEventId).toBe(prd1.id)

    const prd2 = store.appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: resp1.id,
      prdSlug: '901-follow-up',
    })
    expect(prd2.causedByEventId).toBe(resp1.id)

    const resp2 = store.appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: prd2.id,
      text: 'second pass done',
    })
    expect(resp2.causedByEventId).toBe(prd2.id)

    const closed = store.appendPromptSessionEvent(session.id, {
      kind: 'closed',
      causedByEventId: resp2.id,
    })
    expect(closed.causedByEventId).toBe(resp2.id)

    const chain = usePromptSessions.getState().events[session.id]
    expect(chain.map((e) => e.kind)).toEqual([
      'prompt',
      'prd_created',
      'response',
      'prd_created',
      'response',
      'closed',
    ])

    // Every event's causedByEventId resolves to its actual predecessor.
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].causedByEventId).toBe(chain[i - 1].id)
    }
    expect(chain[0].causedByEventId).toBeNull()
  })

  it('rejects an event whose causedByEventId points at a non-existent event', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')

    expect(() =>
      store.appendPromptSessionEvent(session.id, {
        kind: 'prd_created',
        causedByEventId: 'does-not-exist',
        prdSlug: '999-bogus',
      }),
    ).toThrow()
  })

  it('rejects a second null-caused event once the session already has a first event', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')

    expect(() =>
      store.appendPromptSessionEvent(session.id, {
        kind: 'prompt',
        causedByEventId: null,
        text: 'a second unrelated prompt',
      }),
    ).toThrow()
  })

  it('rejects an event for a promptSessionId that was never created', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    expect(() =>
      store.appendPromptSessionEvent('never-created', {
        kind: 'prompt',
        causedByEventId: null,
        text: 'orphan',
      }),
    ).toThrow()
  })

  it('rejects a causedByEventId that is valid in a different session\'s chain', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const sessionA = store.createPromptSession('/proj', 'Goal A')
    const sessionB = store.createPromptSession('/proj', 'Goal B')
    const eventFromA = usePromptSessions.getState().events[sessionA.id][0]

    expect(() =>
      store.appendPromptSessionEvent(sessionB.id, {
        kind: 'prd_created',
        causedByEventId: eventFromA.id,
        prdSlug: '902-cross-session',
      }),
    ).toThrow()
  })

  it('rejects branching: causedByEventId must be the current tail, not an earlier event', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    const events = usePromptSessions.getState().events[session.id]
    const promptEvent = events[0]

    store.appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: promptEvent.id,
      prdSlug: '900-first',
    })

    // A second event also caused by the (now stale) prompt event must be
    // rejected — only the current tail may be referenced.
    expect(() =>
      store.appendPromptSessionEvent(session.id, {
        kind: 'prd_created',
        causedByEventId: promptEvent.id,
        prdSlug: '901-branch',
      }),
    ).toThrow()
  })

  it('rejects a prd_created event with no prdSlug', async () => {
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    const events = usePromptSessions.getState().events[session.id]
    const promptEvent = events[0]

    expect(() =>
      store.appendPromptSessionEvent(session.id, {
        kind: 'prd_created',
        causedByEventId: promptEvent.id,
      }),
    ).toThrow()
  })
})
