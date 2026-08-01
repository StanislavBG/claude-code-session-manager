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

  it('resumeArchived mints a fresh independent session id and records the link back to the archived session', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const archived = store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(archived.id)

    const resumed = usePromptSessions.getState().resumeArchived(archived.id)

    expect(resumed.id).not.toBe(archived.id)
    expect(resumed.claudeSessionId).not.toBe(archived.claudeSessionId)
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
    expect(usePromptSessions.getState().sessions[session.id].status).toBe('active')
  })
})
