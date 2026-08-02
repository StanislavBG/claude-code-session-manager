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
    config: {
      readText: vi.fn().mockResolvedValue({ exists: true, text: 'transcript body', mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }),
      listDir: vi.fn().mockResolvedValue({ ok: true, entries: [], error: null }),
    },
    promptSessionTranscript: {
      append: vi.fn().mockResolvedValue({ ok: true }),
      read: vi.fn().mockResolvedValue({ turns: [] }),
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
    // Every Epic is born 'proposed' — createPromptSession can never mint
    // 'active' directly; only approveProposed may flip it.
    expect(session.status).toBe('proposed')
    expect(session.completedAt).toBeNull()

    // createPromptSession must not reuse or mutate any existing SessionTab.
    expect(useSessions.getState().tabs).toEqual(tabsBefore)

    // First event is auto-appended and has no cause.
    const events = usePromptSessions.getState().events[session.id]
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('prompt')
    expect(events[0].causedByEventId).toBeNull()
  })

  it('regression: createPromptSession called with no tag arg (the chat.ts:712 dispatch shape) still mints proposed, never active', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    // Incident 2026-08-02 (psess-msbv6w4d-10): createPromptSession used to
    // default an omitted `status` arg to 'active', so any caller that didn't
    // pass a status — like chat.ts's dispatch path — rogue-created a live
    // Epic. The status parameter is gone entirely now; this call shape must
    // always land on 'proposed'.
    const session = usePromptSessions.getState().createPromptSession('/proj', 'rogue dispatch text')

    expect(session.status).toBe('proposed')
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

  it('markCompleted kills the live chatRunner process, closes the chain, and persists a correctly-shaped archive', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionArchivePath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    store.appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: usePromptSessions.getState().events[session.id][0].id,
      text: 'progress update',
    })

    await usePromptSessions.getState().markCompleted(session.id)

    // Real kill path: chatRunner's child process is keyed by promptSessionId.
    expect(api.chat.cancel).toHaveBeenCalledWith(session.id)
    // AC-named reuse path, hit defensively even though it's a no-op today.
    expect(api.pty.kill).toHaveBeenCalledWith(session.claudeSessionId)

    const updated = usePromptSessions.getState().sessions[session.id]
    expect(updated.status).toBe('completed')
    expect(updated.completedAt).toBeTruthy()

    const events = usePromptSessions.getState().events[session.id]
    expect(events[events.length - 1].kind).toBe('closed')
    expect(events[events.length - 1].causedByEventId).toBe(events[events.length - 2].id)

    // writeJson also fires for the active-index persistence (on create,
    // append, and the completion-triggered removal) — isolate the one
    // archive write among them by path.
    const archiveCall = api.config.writeJson.mock.calls.find(
      (c) => c[0] === promptSessionArchivePath('/proj', session.id),
    )
    expect(archiveCall).toBeDefined()
    const [archivePath, archive] = archiveCall!
    expect(archive.session).toEqual(updated)
    expect(archive.events).toEqual(events)
    expect(archive.transcript).toBe('transcript body')
    expect(archive.archivedAt).toBeTruthy()
  })

  it('markCompleted is a no-op when the session is already completed', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(session.id)
    api.chat.cancel.mockClear()
    api.config.writeJson.mockClear()

    await usePromptSessions.getState().markCompleted(session.id)

    expect(api.chat.cancel).not.toHaveBeenCalled()
    expect(api.config.writeJson).not.toHaveBeenCalled()
  })

  it('markCompleted falls back to the durable transcript store when the raw ~/.claude/projects copy is empty', async () => {
    const api = installWindowApiMock()
    api.config.readText.mockResolvedValue({ exists: false, text: '', mtimeMs: 0, error: null })
    api.promptSessionTranscript.read.mockResolvedValue({
      turns: [
        { v: 1, epicId: 'irrelevant', eventId: null, role: 'user', at: '2026-01-01T00:00:00.000Z', text: 'hello' },
        { v: 1, epicId: 'irrelevant', eventId: null, role: 'assistant', at: '2026-01-01T00:00:01.000Z', text: 'hi there' },
      ],
    })
    const { usePromptSessions, promptSessionArchivePath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(session.id)

    const archiveCall = api.config.writeJson.mock.calls.find(
      (c) => c[0] === promptSessionArchivePath('/proj', session.id),
    )
    expect(archiveCall).toBeDefined()
    const [, archive] = archiveCall!
    expect(archive.transcript).toBe('')
    expect(archive.durableTurns).toEqual([
      { role: 'user', text: 'hello', at: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'hi there', at: '2026-01-01T00:00:01.000Z' },
    ])
  })

  it('markCompleted omits durableTurns when the raw transcript copy is present', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionArchivePath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(session.id)

    expect(api.promptSessionTranscript.read).not.toHaveBeenCalled()
    const archiveCall = api.config.writeJson.mock.calls.find(
      (c) => c[0] === promptSessionArchivePath('/proj', session.id),
    )
    const [, archive] = archiveCall!
    expect(archive.transcript).toBe('transcript body')
    expect(archive.durableTurns).toBeUndefined()
  })

  it('resumeArchived mints a fresh independent session id, born proposed and activated only via approveProposed, and records the link back to the archived session', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const archived = store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(archived.id)

    const approveSpy = vi.spyOn(usePromptSessions.getState(), 'approveProposed')
    const resumed = usePromptSessions.getState().resumeArchived(archived.id)

    expect(resumed.id).not.toBe(archived.id)
    expect(resumed.claudeSessionId).not.toBe(archived.claudeSessionId)
    // The only way resumeArchived's result can be 'active' is via
    // approveProposed — it can never be minted 'active' directly.
    expect(approveSpy).toHaveBeenCalledWith(resumed.id)
    expect(resumed.status).toBe('active')
    expect(resumed.resumedFromId).toBe(archived.id)
    expect(resumed.cwd).toBe(archived.cwd)

    // The archived session's own record is untouched by the resume.
    expect(usePromptSessions.getState().sessions[archived.id].status).toBe('completed')
  })

  it('persists an active session + its events to disk on create/append, and round-trips id/claudeSessionId/events through hydrate() after a simulated reload', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the widget')
    store.appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: usePromptSessions.getState().events[session.id][0].id,
      text: 'progress update',
    })

    // persistActiveIndex serializes writes to the same path behind a
    // microtask chain (to preserve issue order across concurrent mutations),
    // so the write lands a tick after the synchronous store call returns.
    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())
    const lastCall = api.config.writeJson.mock.calls[api.config.writeJson.mock.calls.length - 1]
    expect(lastCall[0]).toBe(promptSessionActiveIndexPath('/proj'))
    const persisted = lastCall[1] as { sessions: Record<string, unknown>; events: Record<string, unknown[]> }
    expect(persisted.sessions[session.id]).toEqual(session)
    expect(persisted.events[session.id]).toHaveLength(2)

    // Simulate an app reload: a brand-new module (fresh, empty store), disk
    // still has what the prior instance wrote.
    vi.resetModules()
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: persisted,
      parseError: null,
      mtimeMs: 0,
      error: null,
    })
    const fresh = await import('../promptSessions')
    expect(fresh.usePromptSessions.getState().sessions[session.id]).toBeUndefined()

    await fresh.usePromptSessions.getState().hydrate('/proj')

    const rehydrated = fresh.usePromptSessions.getState().sessions[session.id]
    expect(rehydrated).toEqual(session)
    expect(rehydrated.claudeSessionId).toBe(session.claudeSessionId)
    expect(fresh.usePromptSessions.getState().events[session.id]).toEqual(persisted.events[session.id])
  })

  it('drops a session out of the active index once it is marked completed', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the widget')
    await usePromptSessions.getState().markCompleted(session.id)

    // persistActiveIndex's writes are chained microtasks — give the last one
    // (fired from markCompleted, after status flips to 'completed') a tick.
    await vi.waitFor(() => {
      const calls = api.config.writeJson.mock.calls.filter((c) => c[0] === promptSessionActiveIndexPath('/proj'))
      expect(calls.length).toBeGreaterThan(0)
      const persisted = calls[calls.length - 1][1] as { sessions: Record<string, unknown> }
      expect(persisted.sessions[session.id]).toBeUndefined()
    })
  })

  // The active index is the source of truth for which Epics are still open in
  // a cwd, and it gets edited out-of-band (main-process epicMint, another
  // window, a manual cleanup). hydrate() used to only ever ADD, so a deleted
  // Epic stayed listed as Open and the next persist wrote it straight back.
  it('hydrate() removes active Epics for the cwd that are no longer on disk', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const kept = store.createPromptSession('/proj', 'Still open')
    const deleted = usePromptSessions.getState().createPromptSession('/proj', 'Removed on disk')
    const otherProject = usePromptSessions.getState().createPromptSession('/other', 'Different cwd')

    // Let the in-flight persists drain — hydrate() intentionally declines to
    // reconcile removals while disk is knowably behind memory.
    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()

    // Disk now lists only `kept` for /proj.
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: {
        sessions: { [kept.id]: usePromptSessions.getState().sessions[kept.id] },
        events: { [kept.id]: usePromptSessions.getState().events[kept.id] },
      },
      parseError: null,
      mtimeMs: 0,
      error: null,
    })

    await usePromptSessions.getState().hydrate('/proj')

    const after = usePromptSessions.getState()
    expect(after.sessions[kept.id]).toBeDefined()
    expect(after.sessions[deleted.id]).toBeUndefined()
    expect(after.events[deleted.id]).toBeUndefined()
    // Another project's Epics are outside this index's authority.
    expect(after.sessions[otherProject.id]).toBeDefined()
  })

  it('hydrate() does not remove a just-created Epic whose write is still in flight', async () => {
    const api = installWindowApiMock()
    // Hold the write open so the pending-write guard is active.
    let releaseWrite: () => void = () => {}
    api.config.writeJson.mockImplementation(
      () => new Promise<void>((resolve) => { releaseWrite = () => resolve() }),
    )
    const { usePromptSessions } = await import('../promptSessions')

    const fresh = usePromptSessions.getState().createPromptSession('/proj', 'Brand new')
    // Disk has nothing yet — the write hasn't landed.
    api.config.readJson.mockResolvedValue({
      exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null,
    })

    await usePromptSessions.getState().hydrate('/proj')

    expect(usePromptSessions.getState().sessions[fresh.id]).toBeDefined()
    releaseWrite()
  })

  it('round-trips an Epic-level tag through persistActiveIndex and hydrate()', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the widget', 'bug')
    expect(session.tag).toBe('bug')

    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())
    const lastCall = api.config.writeJson.mock.calls[api.config.writeJson.mock.calls.length - 1]
    const persisted = lastCall[1] as { sessions: Record<string, { tag?: string }> }
    expect(persisted.sessions[session.id].tag).toBe('bug')

    // Simulate a reload from a main-minted active-index.json (epicMint.cjs
    // writes `tag` the same shape) — hydrate() must read it back untouched.
    vi.resetModules()
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: persisted,
      parseError: null,
      mtimeMs: 0,
      error: null,
    })
    const fresh = await import('../promptSessions')
    await fresh.usePromptSessions.getState().hydrate('/proj')
    expect(fresh.usePromptSessions.getState().sessions[session.id].tag).toBe('bug')
  })

  it('hydrateArchived() loads completed-Epic archive files as status:completed sessions, skipping active-index.json', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionArchivePath } = await import('../promptSessions')

    const archivedSession = {
      id: 'psess-archived-1',
      cwd: '/proj',
      goalText: 'Old goal',
      claudeSessionId: 'claude-archived-1',
      status: 'completed' as const,
      createdAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-02T00:00:00.000Z',
    }
    const archivedEvents = [
      { id: 'e1', promptSessionId: 'psess-archived-1', kind: 'prompt' as const, causedByEventId: null, at: '2026-07-01T00:00:00.000Z', text: 'Old goal' },
    ]
    const archivePath = promptSessionArchivePath('/proj', 'psess-archived-1')

    api.config.listDir.mockResolvedValue({
      ok: true,
      error: null,
      entries: [
        { name: 'active-index.json', path: '/proj/session-manager-operations/prompt-sessions/active-index.json', isDirectory: false, isFile: true, mtimeMs: 0, size: 0 },
        { name: 'psess-archived-1.json', path: archivePath, isDirectory: false, isFile: true, mtimeMs: 0, size: 0 },
      ],
    })
    api.config.readJson.mockImplementation(async (path: string) => {
      if (path === archivePath) {
        return {
          exists: true,
          raw: '',
          data: { session: archivedSession, events: archivedEvents, transcript: '', archivedAt: '2026-07-02T00:00:00.000Z' },
          parseError: null,
          mtimeMs: 0,
          error: null,
        }
      }
      return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }
    })

    await usePromptSessions.getState().hydrateArchived('/proj')

    const loaded = usePromptSessions.getState().sessions['psess-archived-1']
    expect(loaded).toBeDefined()
    expect(loaded.status).toBe('completed')
    expect(loaded.goalText).toBe('Old goal')
    expect(usePromptSessions.getState().events['psess-archived-1']).toEqual(archivedEvents)
    // active-index.json must never be treated as an archived Epic.
    expect(usePromptSessions.getState().sessions['active-index']).toBeUndefined()
  })

  it('mergeAppendedEvent merges a broadcast event into an already in-memory session', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    const promptEvent = usePromptSessions.getState().events[session.id][0]

    store.mergeAppendedEvent(session.cwd, session.id, {
      id: 'pevt-response-1',
      promptSessionId: session.id,
      kind: 'response',
      causedByEventId: promptEvent.id,
      at: new Date(Date.parse(promptEvent.at) + 60_000).toISOString(),
      text: 'PRD finished',
    })

    const events = usePromptSessions.getState().events[session.id]
    expect(events).toHaveLength(2)
    expect(events[1].id).toBe('pevt-response-1')
    expect(events[1].kind).toBe('response')
    expect(events[1].text).toBe('PRD finished')
  })

  it('mergeAppendedEvent dedupes by event id against an event already present (e.g. an optimistic prd_created)', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    const promptEvent = usePromptSessions.getState().events[session.id][0]

    const optimistic = store.appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: promptEvent.id,
      prdSlug: '900-ship-the-feature',
    })

    // Main process also wrote (or would write) the SAME event to disk and
    // broadcasts it back — must not produce a duplicate chip.
    store.mergeAppendedEvent(session.cwd, session.id, { ...optimistic })

    const events = usePromptSessions.getState().events[session.id]
    expect(events).toHaveLength(2)
    expect(events.filter((e) => e.id === optimistic.id)).toHaveLength(1)
  })

  it('mergeAppendedEvent toasts a response event for an Epic that is not currently focused', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useToast } = await import('../toast')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature\n\nMake it fast')
    const promptEvent = usePromptSessions.getState().events[session.id][0]
    store.setFocusedEpicId('some-other-epic')

    store.mergeAppendedEvent(session.cwd, session.id, {
      id: 'pevt-response-1',
      promptSessionId: session.id,
      kind: 'response',
      causedByEventId: promptEvent.id,
      at: new Date(Date.parse(promptEvent.at) + 60_000).toISOString(),
      text: 'PRD 900-ship-the-feature finished: completed. Check Scheduler for details.',
    })

    const toasts = useToast.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('info')
    expect(toasts[0].message).toContain('PRD 900-ship-the-feature finished')
    expect(toasts[0].message).toContain('Ship the feature')
  })

  it('mergeAppendedEvent does not toast for the Epic the user is currently focused on', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useToast } = await import('../toast')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    const promptEvent = usePromptSessions.getState().events[session.id][0]
    store.setFocusedEpicId(session.id)

    store.mergeAppendedEvent(session.cwd, session.id, {
      id: 'pevt-response-1',
      promptSessionId: session.id,
      kind: 'response',
      causedByEventId: promptEvent.id,
      at: new Date(Date.parse(promptEvent.at) + 60_000).toISOString(),
      text: 'PRD 900-ship-the-feature finished: completed. Check Scheduler for details.',
    })

    expect(useToast.getState().toasts).toHaveLength(0)
  })

  it('mergeAppendedEvent does not re-toast on a duplicate merge of an already-known event (reload/re-hydration)', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useToast } = await import('../toast')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the feature')
    const promptEvent = usePromptSessions.getState().events[session.id][0]
    store.setFocusedEpicId(null)

    const responseEvent = {
      id: 'pevt-response-1',
      promptSessionId: session.id,
      kind: 'response' as const,
      causedByEventId: promptEvent.id,
      at: new Date(Date.parse(promptEvent.at) + 60_000).toISOString(),
      text: 'PRD 900-ship-the-feature finished: completed. Check Scheduler for details.',
    }
    store.mergeAppendedEvent(session.cwd, session.id, responseEvent)
    // Simulate a reload re-delivering the same event (e.g. hydrate + a
    // duplicate broadcast) — must not spam a second toast for it.
    store.mergeAppendedEvent(session.cwd, session.id, { ...responseEvent })

    expect(useToast.getState().toasts).toHaveLength(1)
  })

  it('mergeAppendedEvent silently ignores a broadcast for a session never hydrated into this store', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    expect(() =>
      usePromptSessions.getState().mergeAppendedEvent('/proj', 'psess-unknown', {
        id: 'pevt-x',
        promptSessionId: 'psess-unknown',
        kind: 'response',
        causedByEventId: null,
        at: '2026-07-31T00:00:00.000Z',
        text: 'hi',
      }),
    ).not.toThrow()
    expect(usePromptSessions.getState().events['psess-unknown']).toBeUndefined()
  })

  it('hydrate() merges newly-appended disk events into a session ALREADY in memory instead of early-returning when newIds is empty', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the widget')
    const promptEvent = usePromptSessions.getState().events[session.id][0]

    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())

    // Disk now has one MORE event than memory (the scheduler's response
    // append, main-process-side) but the SAME session id — so newIds is
    // empty and the old early-return would have discarded it.
    const responseEvent = {
      id: 'pevt-response-1',
      promptSessionId: session.id,
      kind: 'response' as const,
      causedByEventId: promptEvent.id,
      at: new Date(Date.parse(promptEvent.at) + 60_000).toISOString(),
      text: 'PRD finished',
    }
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: {
        sessions: { [session.id]: usePromptSessions.getState().sessions[session.id] },
        events: { [session.id]: [promptEvent, responseEvent] },
      },
      parseError: null,
      mtimeMs: 0,
      error: null,
    })

    await usePromptSessions.getState().hydrate('/proj')

    const events = usePromptSessions.getState().events[session.id]
    expect(events.map((e) => e.id)).toEqual([promptEvent.id, responseEvent.id])
    expect(promptSessionActiveIndexPath('/proj')).toBeTruthy()
  })

  it('hydrate() does not clobber an in-memory event newer than disk while merging', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Ship the widget')
    const promptEvent = usePromptSessions.getState().events[session.id][0]

    // An optimistic append not yet reflected on disk.
    const optimistic = store.appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: promptEvent.id,
      prdSlug: '900-optimistic',
    })

    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())

    // Disk is stale — still only has the first event.
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: {
        sessions: { [session.id]: usePromptSessions.getState().sessions[session.id] },
        events: { [session.id]: [promptEvent] },
      },
      parseError: null,
      mtimeMs: 0,
      error: null,
    })

    await usePromptSessions.getState().hydrate('/proj')

    const events = usePromptSessions.getState().events[session.id]
    expect(events.map((e) => e.id)).toEqual([promptEvent.id, optimistic.id])
  })

  it('hydrateArchived() never overwrites an in-memory session on id collision', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionArchivePath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = store.createPromptSession('/proj', 'Live in memory')
    const archivePath = promptSessionArchivePath('/proj', session.id)

    api.config.listDir.mockResolvedValue({
      ok: true,
      error: null,
      entries: [
        { name: `${session.id}.json`, path: archivePath, isDirectory: false, isFile: true, mtimeMs: 0, size: 0 },
      ],
    })
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: { session: { ...session, goalText: 'stale disk copy', status: 'completed' }, events: [], transcript: '', archivedAt: 'x' },
      parseError: null,
      mtimeMs: 0,
      error: null,
    })

    await usePromptSessions.getState().hydrateArchived('/proj')

    expect(usePromptSessions.getState().sessions[session.id].goalText).toBe('Live in memory')
    expect(usePromptSessions.getState().sessions[session.id].status).toBe('proposed')
  })
})

describe('proposed Epics are durable (never erased)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  const lastIndexWrite = (api: ReturnType<typeof installWindowApiMock>, path: string) => {
    const calls = api.config.writeJson.mock.calls.filter((c: unknown[]) => c[0] === path)
    return calls[calls.length - 1]?.[1] as
      | { sessions: Record<string, unknown>; events: Record<string, unknown[]> }
      | undefined
  }

  it('persists a proposed Epic to active-index.json', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')

    const proposed = usePromptSessions.getState().createPromptSession('/proj', 'agent-filed work', 'bug')

    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())
    expect(lastIndexWrite(api, promptSessionActiveIndexPath('/proj'))?.sessions[proposed.id]).toEqual(proposed)
  })

  // The regression: persistActiveIndex rewrites the WHOLE file, so filtering it
  // to status === 'active' meant any later mutation dropped every proposal that
  // epicMint.cjs (main) had written in — silently destroying the agent-proposal
  // intake. A proposed Epic is a valid minimal row, not junk to filter out.
  it('keeps proposed Epics when an unrelated active Epic is mutated', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')

    const proposed = usePromptSessions.getState().createPromptSession('/proj', 'agent-filed work', 'bug')
    const activeProposal = usePromptSessions.getState().createPromptSession('/proj', 'human work', 'feature')
    const active = usePromptSessions.getState().approveProposed(activeProposal.id)!

    usePromptSessions.getState().appendPromptSessionEvent(active.id, {
      kind: 'response',
      causedByEventId: usePromptSessions.getState().events[active.id][0].id,
      text: 'a later mutation',
    })

    await vi.waitFor(() => expect(api.config.writeJson).toHaveBeenCalled())
    const persisted = lastIndexWrite(api, promptSessionActiveIndexPath('/proj'))
    expect(persisted?.sessions[active.id]).toBeDefined()
    expect(persisted?.sessions[proposed.id]).toEqual(proposed)
  })

  it('drops a row only when it is completed (archived)', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')

    const proposed = usePromptSessions.getState().createPromptSession('/proj', 'agent-filed work', 'bug')
    await usePromptSessions.getState().markCompleted(proposed.id)

    // Wait on the CONDITION, not on writeJson having been called at all —
    // create() already called it, so the latter resolves before the
    // completion write lands.
    await vi.waitFor(() => {
      expect(lastIndexWrite(api, promptSessionActiveIndexPath('/proj'))?.sessions[proposed.id]).toBeUndefined()
    })
  })
})

describe('renameEpic / duplicateEpic / deleteEpic', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('renameEpic re-encodes goalText as title + blank line + goal', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Old title\n\nOld goal body')
    await usePromptSessions.getState().renameEpic(session.id, 'New title', 'New goal body')

    expect(usePromptSessions.getState().sessions[session.id].goalText).toBe('New title\n\nNew goal body')
  })

  it('renameEpic rejects an empty (or whitespace-only) title', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Old title\n\nOld goal body')

    await expect(usePromptSessions.getState().renameEpic(session.id, '   ', 'goal')).rejects.toThrow()
    expect(usePromptSessions.getState().sessions[session.id].goalText).toBe('Old title\n\nOld goal body')
  })

  it('renameEpic collapses a multi-line title so it cannot bleed into the goal on read-back', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Old title\n\nOld goal body')
    await usePromptSessions.getState().renameEpic(session.id, 'Line one\n\nLine two', 'goal body')

    const goalText = usePromptSessions.getState().sessions[session.id].goalText
    // splitTitleAndGoal decodes on the FIRST "\n\n" — the encoded title must
    // not itself contain that separator, or the decode would truncate it.
    expect(goalText.indexOf('\n\n')).toBe(goalText.indexOf('\n\ngoal body'))
  })

  it('duplicateEpic mints a fresh Epic with the same cwd/goalText/tag but a new id + claudeSessionId, activated only via approveProposed', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const source = usePromptSessions.getState().createPromptSession('/proj', 'Shared goal', 'feature')
    const approveSpy = vi.spyOn(usePromptSessions.getState(), 'approveProposed')
    const copy = usePromptSessions.getState().duplicateEpic(source.id)

    expect(copy.id).not.toBe(source.id)
    expect(copy.claudeSessionId).not.toBe(source.claudeSessionId)
    expect(copy.cwd).toBe(source.cwd)
    expect(copy.goalText).toBe(source.goalText)
    expect(copy.tag).toBe(source.tag)
    // duplicateEpic can never mint 'active' directly — it is born 'proposed'
    // then activated exclusively through approveProposed.
    expect(approveSpy).toHaveBeenCalledWith(copy.id)
    expect(copy.status).toBe('active')
  })

  it('deleteEpic removes the Epic from both sessions and events', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Throwaway')
    await usePromptSessions.getState().deleteEpic(session.id)

    expect(usePromptSessions.getState().sessions[session.id]).toBeUndefined()
    expect(usePromptSessions.getState().events[session.id]).toBeUndefined()
  })

  it('deleteEpic throws and does not remove the Epic when a scheduler job is running against it', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useScheduleState } = await import('../scheduleState')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Has a running job')
    useScheduleState.setState({
      loaded: true,
      snapshot: {
        jobs: [
          {
            slug: '001-foo',
            title: 'foo',
            cwd: '/proj',
            parallelGroup: 0,
            estimateMinutes: null,
            bodyPreview: '',
            status: 'running',
            runId: null,
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            error: null,
            sourcePromptId: session.id,
          },
        ],
      } as never,
    })

    await expect(usePromptSessions.getState().deleteEpic(session.id)).rejects.toThrow()
    expect(usePromptSessions.getState().sessions[session.id]).toBeDefined()
  })

  it('deleteEpic still blocks when only the authoritative epicId (not sourcePromptId) matches a pending job', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useScheduleState } = await import('../scheduleState')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Has a pending job, stale sourcePromptId')
    useScheduleState.setState({
      loaded: true,
      snapshot: {
        jobs: [
          {
            slug: '002-bar',
            title: 'bar',
            cwd: '/proj',
            parallelGroup: 0,
            estimateMinutes: null,
            bodyPreview: '',
            status: 'pending',
            runId: null,
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            error: null,
            sourcePromptId: 'stale-other-id',
            epicId: session.id,
          },
        ],
      } as never,
    })

    await expect(usePromptSessions.getState().deleteEpic(session.id)).rejects.toThrow()
    expect(usePromptSessions.getState().sessions[session.id]).toBeDefined()
  })

  it('deleteEpic throws and does not remove the Epic when its chat run is in flight', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useChat } = await import('../chat')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Has a live chat run')
    useChat.setState({
      chats: {
        [session.id]: {
          turns: [],
          running: true,
          queuedPosition: 0,
          queue: [],
          activeTicket: null,
          stream: '',
          liveToolUses: [],
          started: false,
        } as never,
      },
    })

    await expect(usePromptSessions.getState().deleteEpic(session.id)).rejects.toThrow()
    expect(usePromptSessions.getState().sessions[session.id]).toBeDefined()
  })

  it('deleteEpic throws and does not remove the Epic when a Terminal session is attached', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useEpicTerminal } = await import('../epicTerminal')

    const session = usePromptSessions.getState().createPromptSession('/proj', 'Attached to Terminal')
    useEpicTerminal.getState().setAttached(session.id, true)

    await expect(usePromptSessions.getState().deleteEpic(session.id)).rejects.toThrow()
    expect(usePromptSessions.getState().sessions[session.id]).toBeDefined()
  })
})
