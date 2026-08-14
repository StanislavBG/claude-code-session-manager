import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PromptSession } from '../promptSessions'
import { fakePromptSessionsCreate } from '../../testUtils/fakePromptSessionsCreate'

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
    promptSessions: {
      onEventAppended: vi.fn(),
      mergeActiveIndex: vi.fn().mockResolvedValue({ sessions: {}, events: {} }),
      create: fakePromptSessionsCreate(),
      // Defaults to null (no worktree) — matches createEpicWorktreeViaIpc's
      // own "never rejects, null on any failure" contract. Tests that care
      // about the success path override this per-call.
      createWorktree: vi.fn().mockResolvedValue(null),
      // Defaults to a clean merge — tests that care about the conflict path
      // override this per-call.
      mergeToMain: vi.fn().mockResolvedValue({ ok: true, status: 'merged', integrated: true }),
    },
    auditLog: {
      append: vi.fn().mockResolvedValue({ ok: true }),
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

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Build the widget')

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

  it('createPromptSession mints its id through main\'s ensureEpic (<slug>-<uuid8>), never the old psess-<ts>-<seq> format', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Build the widget')

    expect(api.promptSessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/proj', goalText: 'Build the widget' }),
    )
    expect(session.id).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
    expect(session.id).not.toMatch(/^psess-/)
  })

  it('regression: createPromptSession called with no tag arg (the chat.ts:712 dispatch shape) still mints proposed, never active', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    // Incident 2026-08-02 (psess-msbv6w4d-10): createPromptSession used to
    // default an omitted `status` arg to 'active', so any caller that didn't
    // pass a status — like chat.ts's dispatch path — rogue-created a live
    // Epic. The status parameter is gone entirely now; this call shape must
    // always land on 'proposed'.
    const session = await usePromptSessions.getState().createPromptSession('/proj', 'rogue dispatch text')

    expect(session.status).toBe('proposed')
  })

  it('appends a valid chain prompt -> prd_created -> response -> prd_created -> response -> closed', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the feature')

    expect(() =>
      store.appendPromptSessionEvent(session.id, {
        kind: 'prd_created',
        causedByEventId: 'does-not-exist',
        prdSlug: '999-bogus',
      }),
    ).toThrow()
  })

  it('rejects a second null-caused event once the session already has a first event', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the feature')

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
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const sessionA = await store.createPromptSession('/proj', 'Goal A')
    const sessionB = await store.createPromptSession('/proj', 'Goal B')
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
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(session.id)

    expect(api.promptSessionTranscript.read).not.toHaveBeenCalled()
    const archiveCall = api.config.writeJson.mock.calls.find(
      (c) => c[0] === promptSessionArchivePath('/proj', session.id),
    )
    const [, archive] = archiveCall!
    expect(archive.transcript).toBe('transcript body')
    expect(archive.durableTurns).toBeUndefined()
  })

  it('markCompleted rolls status back to active and toasts when the active-index write rejects', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { toast } = await import('../toast')
    const store = usePromptSessions.getState()

    const proposed = await store.createPromptSession('/proj', 'Ship the feature')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!
    expect(session.status).toBe('active')

    api.promptSessions.mergeActiveIndex.mockRejectedValue(new Error('write outside allowed boundaries'))
    const toastErrorSpy = vi.spyOn(toast, 'error')

    await expect(usePromptSessions.getState().markCompleted(session.id)).rejects.toThrow(
      'write outside allowed boundaries',
    )

    const after = usePromptSessions.getState().sessions[session.id]
    expect(after.status).toBe('active')
    expect(after.completedAt).toBeNull()
    // The optimistic 'closed' event must be rolled back along with the status.
    const events = usePromptSessions.getState().events[session.id]
    expect(events.every((e) => e.kind !== 'closed')).toBe(true)

    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
    expect(toastErrorSpy.mock.calls[0][0]).toContain('Ship the feature')
    // The archive write must never have been attempted once the index write
    // already failed.
    expect(api.config.writeJson).not.toHaveBeenCalled()
  })

  it('markCompleted rolls status back to active and toasts when the archive write rejects (index write already succeeded)', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { toast } = await import('../toast')
    const store = usePromptSessions.getState()

    const proposed = await store.createPromptSession('/proj', 'Ship the feature')
    const session = usePromptSessions.getState().approveProposed(proposed.id)!

    api.config.writeJson.mockRejectedValue(new Error('disk full'))
    const toastErrorSpy = vi.spyOn(toast, 'error')

    await expect(usePromptSessions.getState().markCompleted(session.id)).rejects.toThrow('disk full')

    const after = usePromptSessions.getState().sessions[session.id]
    expect(after.status).toBe('active')
    expect(after.completedAt).toBeNull()
    const events = usePromptSessions.getState().events[session.id]
    expect(events.every((e) => e.kind !== 'closed')).toBe(true)

    expect(toastErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Ship the feature'))
    // The active-index removal that ran before the archive write must be
    // compensated by a follow-up write restoring the row — not just left
    // stripped from disk with no archive to replace it.
    expect(api.promptSessions.mergeActiveIndex.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('markCompleted flips status to completed and persists the archive when both writes succeed (unchanged happy path)', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions, promptSessionArchivePath } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(session.id)

    const after = usePromptSessions.getState().sessions[session.id]
    expect(after.status).toBe('completed')
    expect(after.completedAt).toBeTruthy()
    const archiveCall = api.config.writeJson.mock.calls.find(
      (c) => c[0] === promptSessionArchivePath('/proj', session.id),
    )
    expect(archiveCall).toBeDefined()
  })

  it('resumeArchived mints a fresh independent session id, born proposed and activated only via approveProposed, and records the link back to the archived session', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const archived = await store.createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(archived.id)

    const approveSpy = vi.spyOn(usePromptSessions.getState(), 'approveProposed')
    const resumed = await usePromptSessions.getState().resumeArchived(archived.id)

    expect(resumed.id).not.toBe(archived.id)
    expect(resumed.claudeSessionId).not.toBe(archived.claudeSessionId)
    // The only way resumeArchived's result can be 'active' is via
    // approveProposed — it can never be minted 'active' directly.
    expect(approveSpy).toHaveBeenCalledWith(resumed.id, 'unknown')
    expect(resumed.status).toBe('active')
    expect(resumed.resumedFromId).toBe(archived.id)
    expect(resumed.cwd).toBe(archived.cwd)

    // The archived session's own record is untouched by the resume.
    expect(usePromptSessions.getState().sessions[archived.id].status).toBe('completed')
  })

  it('persists an active session + its events to disk on create/append, and round-trips id/claudeSessionId/events through hydrate() after a simulated reload', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the widget')
    store.appendPromptSessionEvent(session.id, {
      kind: 'response',
      causedByEventId: usePromptSessions.getState().events[session.id][0].id,
      text: 'progress update',
    })

    // persistActiveIndex now forwards its contribution to the main-process
    // merge IPC (window.api.promptSessions.mergeActiveIndex) instead of
    // read-merge-writing itself — the call lands a tick after the synchronous
    // store call returns.
    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
    const calls = api.promptSessions.mergeActiveIndex.mock.calls
    const lastCall = calls[calls.length - 1]
    const payload = lastCall[0] as {
      cwd: string
      sessions: Record<string, unknown>
      events: Record<string, unknown[]>
    }
    expect(payload.cwd).toBe('/proj')
    expect(payload.sessions[session.id]).toEqual(session)
    expect(payload.events[session.id]).toHaveLength(2)

    // Simulate an app reload: a brand-new module (fresh, empty store), disk
    // now holds whatever the main-process merge (not under test here) wrote
    // — modeled here as exactly the prior instance's contribution, since it
    // was the only writer.
    vi.resetModules()
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: { sessions: payload.sessions, events: payload.events },
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
    expect(fresh.usePromptSessions.getState().events[session.id]).toEqual(payload.events[session.id])
  })

  it('drops a session out of the active index once it is marked completed', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the widget')
    await usePromptSessions.getState().markCompleted(session.id)

    // persistActiveIndex's merge calls fire as microtasks — give the last one
    // (from markCompleted, after status flips to 'completed') a tick.
    await vi.waitFor(() => {
      const calls = api.promptSessions.mergeActiveIndex.mock.calls.filter(
        (c) => (c[0] as { cwd: string }).cwd === '/proj',
      )
      expect(calls.length).toBeGreaterThan(0)
      const payload = calls[calls.length - 1][0] as {
        sessions: Record<string, unknown>
        removedIds: string[]
      }
      expect(payload.sessions[session.id]).toBeUndefined()
      expect(payload.removedIds).toContain(session.id)
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

    const kept = await store.createPromptSession('/proj', 'Still open')
    const deleted = await usePromptSessions.getState().createPromptSession('/proj', 'Removed on disk')
    const otherProject = await usePromptSessions.getState().createPromptSession('/other', 'Different cwd')

    // Let the in-flight persists drain — hydrate() intentionally declines to
    // reconcile removals while disk is knowably behind memory.
    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
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
    // Hold the merge call open so the pending-write guard is active.
    let releaseWrite: () => void = () => {}
    api.promptSessions.mergeActiveIndex.mockImplementation(
      () => new Promise((resolve) => { releaseWrite = () => resolve({ sessions: {}, events: {} }) }),
    )
    const { usePromptSessions } = await import('../promptSessions')

    const fresh = await usePromptSessions.getState().createPromptSession('/proj', 'Brand new')
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
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()

    const session = await store.createPromptSession('/proj', 'Ship the widget', 'bug')
    expect(session.tag).toBe('bug')

    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
    const calls = api.promptSessions.mergeActiveIndex.mock.calls
    const payload = calls[calls.length - 1][0] as {
      sessions: Record<string, { tag?: string }>
      events: Record<string, unknown[]>
    }
    expect(payload.sessions[session.id].tag).toBe('bug')

    // Simulate a reload from a main-minted active-index.json (epicMint.cjs
    // writes `tag` the same shape) — hydrate() must read it back untouched.
    vi.resetModules()
    api.config.readJson.mockResolvedValue({
      exists: true,
      raw: '',
      data: payload,
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature\n\nMake it fast')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the feature')
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

    const session = await store.createPromptSession('/proj', 'Ship the widget')
    const promptEvent = usePromptSessions.getState().events[session.id][0]

    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())

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

    const session = await store.createPromptSession('/proj', 'Ship the widget')
    const promptEvent = usePromptSessions.getState().events[session.id][0]

    // An optimistic append not yet reflected on disk.
    const optimistic = store.appendPromptSessionEvent(session.id, {
      kind: 'prd_created',
      causedByEventId: promptEvent.id,
      prdSlug: '900-optimistic',
    })

    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())

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

    const session = await store.createPromptSession('/proj', 'Live in memory')
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

  // Regression coverage for the self-healing reconciliation: an Epic whose
  // markCompleted partially failed (archive written, but the active-index
  // row never got stripped, or a stale row from another writer resurfaced)
  // must NOT stay stuck showing "Open" forever — the archive is newer and
  // authoritative, so a hydrate() + hydrateArchived() pass should heal it.
  describe('hydrateArchived() self-heals a stale active-index row that already has an archive on disk', () => {
    function setupStaleEpic() {
      const id = 'psess-stale-1'
      const cwd = '/proj'
      const staleSession = {
        id,
        cwd,
        goalText: 'Stale open row',
        claudeSessionId: 'claude-stale-1',
        status: 'active' as const,
        createdAt: '2026-08-01T00:00:00.000Z',
        completedAt: null,
      }
      const archivedSession = { ...staleSession, status: 'completed' as const, completedAt: '2026-08-03T00:00:00.000Z' }
      const archiveEvents = [
        { id: 'e1', promptSessionId: id, kind: 'prompt' as const, causedByEventId: null, at: '2026-08-01T00:00:00.000Z', text: 'Stale open row' },
      ]
      return { id, cwd, staleSession, archivedSession, archiveEvents, indexPath: '', archivePath: '' }
    }

    it('archive wins: overrides the stale active-index row and shows the Epic as completed', async () => {
      const api = installWindowApiMock()
      const { usePromptSessions, promptSessionActiveIndexPath, promptSessionArchivePath } = await import('../promptSessions')
      const ctx = setupStaleEpic()
      ctx.indexPath = promptSessionActiveIndexPath(ctx.cwd)
      ctx.archivePath = promptSessionArchivePath(ctx.cwd, ctx.id)

      api.config.readJson.mockImplementation(async (path: string) => {
        if (path === ctx.indexPath) {
          return {
            exists: true,
            raw: '',
            data: { sessions: { [ctx.id]: ctx.staleSession }, events: { [ctx.id]: ctx.archiveEvents } },
            parseError: null,
            mtimeMs: 0,
            error: null,
          }
        }
        if (path === ctx.archivePath) {
          return {
            exists: true,
            raw: '',
            data: { session: ctx.archivedSession, events: ctx.archiveEvents, transcript: '', archivedAt: ctx.archivedSession.completedAt },
            parseError: null,
            mtimeMs: 0,
            error: null,
          }
        }
        return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }
      })

      // hydrate() loads the stale row from active-index.json — this is what
      // marks the id as "index-backed" so hydrateArchived() is allowed to
      // override it (as opposed to a freshly-created local row).
      await usePromptSessions.getState().hydrate(ctx.cwd)
      expect(usePromptSessions.getState().sessions[ctx.id].status).toBe('active')

      api.config.listDir.mockResolvedValue({
        ok: true,
        error: null,
        entries: [
          { name: 'active-index.json', path: ctx.indexPath, isDirectory: false, isFile: true, mtimeMs: 0, size: 0 },
          { name: `${ctx.id}.json`, path: ctx.archivePath, isDirectory: false, isFile: true, mtimeMs: 0, size: 0 },
        ],
      })

      await usePromptSessions.getState().hydrateArchived(ctx.cwd)

      const healed = usePromptSessions.getState().sessions[ctx.id]
      expect(healed.status).toBe('completed')
      expect(healed.completedAt).toBe(ctx.archivedSession.completedAt)
    })

    it('records a tombstone by routing the removal through the existing mergeActiveIndex removedIds path, not a direct fs write', async () => {
      const api = installWindowApiMock()
      const { usePromptSessions, promptSessionActiveIndexPath, promptSessionArchivePath } = await import('../promptSessions')
      const ctx = setupStaleEpic()
      ctx.indexPath = promptSessionActiveIndexPath(ctx.cwd)
      ctx.archivePath = promptSessionArchivePath(ctx.cwd, ctx.id)

      api.config.readJson.mockImplementation(async (path: string) => {
        if (path === ctx.indexPath) {
          return {
            exists: true,
            raw: '',
            data: { sessions: { [ctx.id]: ctx.staleSession }, events: { [ctx.id]: ctx.archiveEvents } },
            parseError: null,
            mtimeMs: 0,
            error: null,
          }
        }
        if (path === ctx.archivePath) {
          return {
            exists: true,
            raw: '',
            data: { session: ctx.archivedSession, events: ctx.archiveEvents, transcript: '', archivedAt: ctx.archivedSession.completedAt },
            parseError: null,
            mtimeMs: 0,
            error: null,
          }
        }
        return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }
      })
      api.config.listDir.mockResolvedValue({
        ok: true,
        error: null,
        entries: [{ name: `${ctx.id}.json`, path: ctx.archivePath, isDirectory: false, isFile: true, mtimeMs: 0, size: 0 }],
      })

      await usePromptSessions.getState().hydrate(ctx.cwd)
      await usePromptSessions.getState().hydrateArchived(ctx.cwd)

      // The one existing mechanism that removes a row from active-index.json
      // and writes a removal tombstone (activeIndexMerge.cjs, main-side) —
      // no new/second write path was introduced for this reconciliation.
      await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
      const call = api.promptSessions.mergeActiveIndex.mock.calls.find(
        (call) => (call[0] as { removedIds?: string[] }).removedIds?.includes(ctx.id),
      )
      expect(call).toBeDefined()
      expect(api.config.writeJson).not.toHaveBeenCalledWith(
        expect.stringContaining('active-index.json'),
        expect.anything(),
        expect.anything(),
      )
    })

    it('is one-shot / idempotent: a second hydrate+hydrateArchived pass performs no further merge writes', async () => {
      const api = installWindowApiMock()
      const { usePromptSessions, promptSessionActiveIndexPath, promptSessionArchivePath } = await import('../promptSessions')
      const ctx = setupStaleEpic()
      ctx.indexPath = promptSessionActiveIndexPath(ctx.cwd)
      ctx.archivePath = promptSessionArchivePath(ctx.cwd, ctx.id)

      api.config.readJson.mockImplementation(async (path: string) => {
        if (path === ctx.indexPath) {
          // Disk mock deliberately stays "stale" across both passes (real
          // activeIndexMerge.cjs would strip this row after the first merge,
          // but the reconciliation must be idempotent from IN-MEMORY state
          // alone — it should never rely on disk having caught up yet).
          return {
            exists: true,
            raw: '',
            data: { sessions: { [ctx.id]: ctx.staleSession }, events: { [ctx.id]: ctx.archiveEvents } },
            parseError: null,
            mtimeMs: 0,
            error: null,
          }
        }
        if (path === ctx.archivePath) {
          return {
            exists: true,
            raw: '',
            data: { session: ctx.archivedSession, events: ctx.archiveEvents, transcript: '', archivedAt: ctx.archivedSession.completedAt },
            parseError: null,
            mtimeMs: 0,
            error: null,
          }
        }
        return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }
      })
      api.config.listDir.mockResolvedValue({
        ok: true,
        error: null,
        entries: [{ name: `${ctx.id}.json`, path: ctx.archivePath, isDirectory: false, isFile: true, mtimeMs: 0, size: 0 }],
      })

      // First pass: hydrate() loads the stale row from active-index.json
      // (marking it index-backed), then hydrateArchived() heals it.
      await usePromptSessions.getState().hydrate(ctx.cwd)
      await usePromptSessions.getState().hydrateArchived(ctx.cwd)
      await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
      const callsAfterFirstPass = api.promptSessions.mergeActiveIndex.mock.calls.length
      expect(usePromptSessions.getState().sessions[ctx.id].status).toBe('completed')

      // Second pass over the same cwd, same (still-stale) disk mocks: the
      // row is already status:'completed' in memory, so it must not be
      // treated as stale again — no further merge write.
      await usePromptSessions.getState().hydrate(ctx.cwd)
      await usePromptSessions.getState().hydrateArchived(ctx.cwd)

      expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalledTimes(callsAfterFirstPass)
    })

    it('leaves an index-backed Epic untouched when no archive exists on disk for it', async () => {
      const api = installWindowApiMock()
      const { usePromptSessions, promptSessionActiveIndexPath } = await import('../promptSessions')
      const ctx = setupStaleEpic()
      ctx.indexPath = promptSessionActiveIndexPath(ctx.cwd)

      api.config.readJson.mockImplementation(async (path: string) => {
        if (path === ctx.indexPath) {
          return {
            exists: true,
            raw: '',
            data: { sessions: { [ctx.id]: ctx.staleSession }, events: { [ctx.id]: ctx.archiveEvents } },
            parseError: null,
            mtimeMs: 0,
            error: null,
          }
        }
        return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: 'not found' }
      })
      api.config.listDir.mockResolvedValue({ ok: true, error: null, entries: [] })

      await usePromptSessions.getState().hydrate(ctx.cwd)
      await usePromptSessions.getState().hydrateArchived(ctx.cwd)

      expect(usePromptSessions.getState().sessions[ctx.id].status).toBe('active')
      expect(api.promptSessions.mergeActiveIndex).not.toHaveBeenCalled()
    })
  })
})

describe('proposed Epics are durable (never erased)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  const lastIndexWrite = (api: ReturnType<typeof installWindowApiMock>, cwd: string) => {
    const calls = api.promptSessions.mergeActiveIndex.mock.calls.filter(
      (c: unknown[]) => (c[0] as { cwd: string }).cwd === cwd,
    )
    return calls[calls.length - 1]?.[0] as
      | { sessions: Record<string, unknown>; events: Record<string, unknown[]> }
      | undefined
  }

  it('persists a proposed Epic to active-index.json', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'agent-filed work', 'bug')

    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
    expect(lastIndexWrite(api, '/proj')?.sessions[proposed.id]).toEqual(proposed)
  })

  // The regression: persistActiveIndex rewrites the WHOLE file, so filtering it
  // to status === 'active' meant any later mutation dropped every proposal that
  // epicMint.cjs (main) had written in — silently destroying the agent-proposal
  // intake. A proposed Epic is a valid minimal row, not junk to filter out.
  it('keeps proposed Epics when an unrelated active Epic is mutated', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'agent-filed work', 'bug')
    const activeProposal = await usePromptSessions.getState().createPromptSession('/proj', 'human work', 'feature')
    const active = usePromptSessions.getState().approveProposed(activeProposal.id)!

    usePromptSessions.getState().appendPromptSessionEvent(active.id, {
      kind: 'response',
      causedByEventId: usePromptSessions.getState().events[active.id][0].id,
      text: 'a later mutation',
    })

    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
    const persisted = lastIndexWrite(api, '/proj')
    expect(persisted?.sessions[active.id]).toBeDefined()
    expect(persisted?.sessions[proposed.id]).toEqual(proposed)
  })

  it('drops a row only when it is completed (archived)', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'agent-filed work', 'bug')
    await usePromptSessions.getState().markCompleted(proposed.id)

    // Wait on the CONDITION, not on the merge call having happened at all —
    // create() already called it, so the latter resolves before the
    // completion call lands.
    await vi.waitFor(() => {
      expect(lastIndexWrite(api, '/proj')?.sessions[proposed.id]).toBeUndefined()
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

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Old title\n\nOld goal body')
    await usePromptSessions.getState().renameEpic(session.id, 'New title', 'New goal body')

    expect(usePromptSessions.getState().sessions[session.id].goalText).toBe('New title\n\nNew goal body')
  })

  it('renameEpic rejects an empty (or whitespace-only) title', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Old title\n\nOld goal body')

    await expect(usePromptSessions.getState().renameEpic(session.id, '   ', 'goal')).rejects.toThrow()
    expect(usePromptSessions.getState().sessions[session.id].goalText).toBe('Old title\n\nOld goal body')
  })

  it('renameEpic collapses a multi-line title so it cannot bleed into the goal on read-back', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Old title\n\nOld goal body')
    await usePromptSessions.getState().renameEpic(session.id, 'Line one\n\nLine two', 'goal body')

    const goalText = usePromptSessions.getState().sessions[session.id].goalText
    // splitTitleAndGoal decodes on the FIRST "\n\n" — the encoded title must
    // not itself contain that separator, or the decode would truncate it.
    expect(goalText.indexOf('\n\n')).toBe(goalText.indexOf('\n\ngoal body'))
  })

  it('duplicateEpic mints a fresh Epic with the same cwd/goalText/tag but a new id + claudeSessionId, activated only via approveProposed', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const source = await usePromptSessions.getState().createPromptSession('/proj', 'Shared goal', 'feature')
    const approveSpy = vi.spyOn(usePromptSessions.getState(), 'approveProposed')
    const copy = await usePromptSessions.getState().duplicateEpic(source.id)

    expect(copy.id).not.toBe(source.id)
    expect(copy.claudeSessionId).not.toBe(source.claudeSessionId)
    expect(copy.cwd).toBe(source.cwd)
    expect(copy.goalText).toBe(source.goalText)
    expect(copy.tag).toBe(source.tag)
    // duplicateEpic can never mint 'active' directly — it is born 'proposed'
    // then activated exclusively through approveProposed.
    expect(approveSpy).toHaveBeenCalledWith(copy.id, 'unknown')
    expect(copy.status).toBe('active')
  })

  it('deleteEpic removes the Epic from both sessions and events', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Throwaway')
    await usePromptSessions.getState().deleteEpic(session.id)

    expect(usePromptSessions.getState().sessions[session.id]).toBeUndefined()
    expect(usePromptSessions.getState().events[session.id]).toBeUndefined()
  })

  it('deleteEpic throws and does not remove the Epic when a scheduler job is running against it', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const { useScheduleState } = await import('../scheduleState')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Has a running job')
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

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Has a pending job, stale sourcePromptId')
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

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Has a live chat run')
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

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Attached to Terminal')
    useEpicTerminal.getState().setAttached(session.id, true)

    await expect(usePromptSessions.getState().deleteEpic(session.id)).rejects.toThrow()
    expect(usePromptSessions.getState().sessions[session.id]).toBeDefined()
  })
})

// The read-merge-write itself (disk preservation, memory-wins-on-collision,
// removal tombstones/resurrection guard, event union, corrupt-disk fallback,
// mint-during-persist) moved main-side to lib/activeIndexMerge.cjs — see
// src/main/__tests__/activeIndexMerge.test.cjs for that coverage. These tests
// only verify persistActiveIndex computes and forwards the correct
// CONTRIBUTION to the main-process merge IPC.
describe('persistActiveIndex forwards its contribution to the main-process merge IPC', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  const lastIndexWrite = (api: ReturnType<typeof installWindowApiMock>, cwd: string) => {
    const calls = api.promptSessions.mergeActiveIndex.mock.calls.filter(
      (c: unknown[]) => (c[0] as { cwd: string }).cwd === cwd,
    )
    return calls[calls.length - 1]?.[0] as
      | {
          cwd: string
          sessions: Record<string, PromptSession>
          events: Record<string, unknown[]>
          removedIds: string[]
          source: string
        }
      | undefined
  }

  it('sends only this cwd\'s open (active/proposed) Epics, tagged source: "epics"', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Fresh title')
    await usePromptSessions.getState().createPromptSession('/other', 'A different project')

    await vi.waitFor(() => expect(api.promptSessions.mergeActiveIndex).toHaveBeenCalled())
    const persisted = lastIndexWrite(api, '/proj')
    expect(persisted?.sessions[session.id]).toEqual(session)
    expect(persisted?.source).toBe('epics')
    // Never leaks another cwd's Epics into this cwd's merge call.
    expect(Object.keys(persisted?.sessions ?? {})).toEqual([session.id])
  })

  // markCompleted/deleteEpic are the ONLY two mechanisms allowed to erase a
  // row — verify the renderer forwards the explicit removal, not just drops
  // the row from its own contribution (the main-side merge needs removedIds
  // to record the tombstone; see activeIndexMerge.test.cjs).
  it('markCompleted forwards its own id in removedIds and drops it from the sessions contribution', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Will complete')
    await usePromptSessions.getState().markCompleted(session.id)

    await vi.waitFor(() => {
      const persisted = lastIndexWrite(api, '/proj')
      expect(persisted?.sessions[session.id]).toBeUndefined()
      expect(persisted?.removedIds).toContain(session.id)
    })
  })

  it('deleteEpic forwards its own id in removedIds and drops it from the sessions contribution', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Will delete')
    await usePromptSessions.getState().deleteEpic(session.id)

    await vi.waitFor(() => {
      const persisted = lastIndexWrite(api, '/proj')
      expect(persisted?.sessions[session.id]).toBeUndefined()
      expect(persisted?.removedIds).toContain(session.id)
    })
  })

  it('logs a warning (and never throws into the caller) when the merge IPC call rejects', async () => {
    const api = installWindowApiMock()
    api.promptSessions.mergeActiveIndex.mockRejectedValue(new Error('main-process merge failed'))
    const logsWrite = vi.fn()
    ;(api as unknown as { logs: { write: typeof logsWrite } }).logs = { write: logsWrite }
    const { usePromptSessions } = await import('../promptSessions')

    await expect(
      usePromptSessions.getState().createPromptSession('/proj', 'Survives a merge failure'),
    ).resolves.toBeDefined()

    await vi.waitFor(() => {
      expect(logsWrite).toHaveBeenCalledWith(
        'promptSessions',
        'warn',
        expect.stringContaining('persistActiveIndex failed'),
      )
    })
  })
})

describe('audit log emission (PRD 940)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('createPromptSession fires an epic_create audit event with cwd/epicId/source', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature', undefined, 'NewEpicCard')

    expect(api.auditLog.append).toHaveBeenCalledWith('epic_create', {
      cwd: '/proj',
      epicId: session.id,
      source: 'NewEpicCard',
    })
  })

  it('createPromptSession defaults source to "unknown" when the caller omits it', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')

    expect(api.auditLog.append).toHaveBeenCalledWith('epic_create', {
      cwd: '/proj',
      epicId: session.id,
      source: 'unknown',
    })
  })

  it('approveProposed fires an epic_approve audit event', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    api.auditLog.append.mockClear()
    usePromptSessions.getState().approveProposed(session.id, 'EpicApprovalBar')

    expect(api.auditLog.append).toHaveBeenCalledWith('epic_approve', {
      cwd: '/proj',
      epicId: session.id,
      source: 'EpicApprovalBar',
    })
  })

  it('markCompleted fires an epic_complete audit event', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    api.auditLog.append.mockClear()
    await usePromptSessions.getState().markCompleted(session.id, 'EpicDetail')

    expect(api.auditLog.append).toHaveBeenCalledWith('epic_complete', {
      cwd: '/proj',
      epicId: session.id,
      source: 'EpicDetail',
    })
  })

  it('deleteEpic fires an epic_delete audit event', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Throwaway')
    api.auditLog.append.mockClear()
    await usePromptSessions.getState().deleteEpic(session.id, 'EpicQueue row menu')

    expect(api.auditLog.append).toHaveBeenCalledWith('epic_delete', {
      cwd: '/proj',
      epicId: session.id,
      source: 'EpicQueue row menu',
    })
  })

  it('resumeArchived fires an epic_resume audit event for the new Epic id', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const archived = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    await usePromptSessions.getState().markCompleted(archived.id)
    api.auditLog.append.mockClear()
    const resumed = await usePromptSessions.getState().resumeArchived(archived.id, 'EpicDetail')

    expect(api.auditLog.append).toHaveBeenCalledWith('epic_resume', {
      cwd: resumed.cwd,
      epicId: resumed.id,
      source: 'EpicDetail',
    })
  })

  it('duplicateEpic fires an epic_duplicate audit event for the new Epic id', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')

    const source = await usePromptSessions.getState().createPromptSession('/proj', 'Shared goal', 'feature')
    api.auditLog.append.mockClear()
    const copy = await usePromptSessions.getState().duplicateEpic(source.id, 'EpicQueue row menu')

    expect(api.auditLog.append).toHaveBeenCalledWith('epic_duplicate', {
      cwd: source.cwd,
      epicId: copy.id,
      source: 'EpicQueue row menu',
    })
  })

  it('audit IPC failure logs a console warning and never rejects the store mutation', async () => {
    const api = installWindowApiMock()
    api.auditLog.append.mockRejectedValue(new Error('ipc down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { usePromptSessions } = await import('../promptSessions')

    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    expect(session.status).toBe('proposed')

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('epic_create'),
        expect.any(Error),
      )
    })
    warnSpy.mockRestore()
  })
})

describe('approveProposed epic worktree creation (PRD 1033)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('fires createWorktree with the Epic cwd/id and patches worktree onto the session once it resolves — never blocking the sync transition', async () => {
    const api = installWindowApiMock()
    let resolveCreate!: (v: unknown) => void
    api.promptSessions.createWorktree.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve }))
    const { usePromptSessions } = await import('../promptSessions')

    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    const approved = usePromptSessions.getState().approveProposed(proposed.id, 'EpicApprovalBar')

    // The transition itself is synchronous and unblocked by the still-pending IPC call.
    expect(approved?.status).toBe('active')
    expect(approved?.worktree).toBeUndefined()
    expect(api.promptSessions.createWorktree).toHaveBeenCalledWith({ cwd: '/proj', epicId: proposed.id })

    const worktree = { dir: '/tmp/sm-epic-worktrees/abc/epic-1', branch: `sm-epic/${proposed.id}`, baseCwd: '/proj', status: 'active' as const }
    resolveCreate(worktree)

    await vi.waitFor(() => {
      expect(usePromptSessions.getState().sessions[proposed.id].worktree).toEqual(worktree)
    })
  })

  it('leaves worktree unset when createWorktree resolves null (not a repo / dirty / disabled / cap reached)', async () => {
    const api = installWindowApiMock()
    api.promptSessions.createWorktree.mockResolvedValue(null)
    const { usePromptSessions } = await import('../promptSessions')

    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    usePromptSessions.getState().approveProposed(proposed.id)

    await vi.waitFor(() => {
      expect(api.promptSessions.createWorktree).toHaveBeenCalled()
    })
    expect(usePromptSessions.getState().sessions[proposed.id].worktree).toBeUndefined()
  })

  it('never throws or blocks approveProposed when createWorktree rejects', async () => {
    const api = installWindowApiMock()
    api.promptSessions.createWorktree.mockRejectedValue(new Error('ipc down'))
    const { usePromptSessions } = await import('../promptSessions')

    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    expect(() => usePromptSessions.getState().approveProposed(proposed.id)).not.toThrow()

    // Give the rejected promise's .catch(() => {}) a tick to settle quietly.
    await vi.waitFor(() => {
      expect(api.promptSessions.createWorktree).toHaveBeenCalled()
    })
    expect(usePromptSessions.getState().sessions[proposed.id].worktree).toBeUndefined()
    expect(usePromptSessions.getState().sessions[proposed.id].status).toBe('active')
  })

  it('does not graft a worktree back onto an Epic that was completed while creation was still pending', async () => {
    const api = installWindowApiMock()
    let resolveCreate!: (v: unknown) => void
    api.promptSessions.createWorktree.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve }))
    const { usePromptSessions } = await import('../promptSessions')

    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    usePromptSessions.getState().approveProposed(proposed.id)
    await usePromptSessions.getState().markCompleted(proposed.id)

    resolveCreate({ dir: '/tmp/late-worktree', branch: `sm-epic/${proposed.id}`, baseCwd: '/proj', status: 'active' })
    // Flush microtasks so the .then() handler above has a chance to run.
    await Promise.resolve()
    await Promise.resolve()

    expect(usePromptSessions.getState().sessions[proposed.id].worktree).toBeUndefined()
  })
})

describe('merge-to-main checkpoint (PRD 1034)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  async function approvedEpicWithWorktree(api: ReturnType<typeof installWindowApiMock>) {
    const { usePromptSessions, promptSessionArchivePath } = await import('../promptSessions')
    const worktree = { dir: '/tmp/sm-epic-worktrees/abc/epic-1', branch: 'sm-epic/placeholder', baseCwd: '/proj', status: 'active' as const }
    api.promptSessions.createWorktree.mockResolvedValueOnce(worktree)
    const proposed = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')
    usePromptSessions.getState().approveProposed(proposed.id)
    await vi.waitFor(() => {
      expect(usePromptSessions.getState().sessions[proposed.id].worktree).toBeDefined()
    })
    return { usePromptSessions, promptSessionArchivePath, epicId: proposed.id }
  }

  it('markCompleted merges an unmerged active worktree before archiving, and the archive carries status "merged"', async () => {
    const api = installWindowApiMock()
    api.promptSessions.mergeToMain.mockResolvedValue({ ok: true, status: 'merged', integrated: true })
    const { usePromptSessions, promptSessionArchivePath, epicId } = await approvedEpicWithWorktree(api)
    const worktreeBefore = usePromptSessions.getState().sessions[epicId].worktree!

    await usePromptSessions.getState().markCompleted(epicId)

    expect(api.promptSessions.mergeToMain).toHaveBeenCalledWith({
      cwd: '/proj',
      epicId,
      branch: worktreeBefore.branch,
      dir: worktreeBefore.dir,
    })
    const archiveCall = api.config.writeJson.mock.calls.find((c: unknown[]) => c[0] === promptSessionArchivePath('/proj', epicId))
    expect(archiveCall).toBeDefined()
    const [, archive] = archiveCall as [string, { session: { worktree?: { status: string } } }]
    expect(archive.session.worktree?.status).toBe('merged')
  })

  it('markCompleted still archives on a merge conflict, preserving the conflict status + branch + dir instead of dropping it', async () => {
    const api = installWindowApiMock()
    api.promptSessions.mergeToMain.mockResolvedValue({ ok: false, status: 'needs_merge_resolution', reason: 'merge failed (likely a real content conflict)' })
    const { usePromptSessions, promptSessionArchivePath, epicId } = await approvedEpicWithWorktree(api)
    const worktreeBefore = usePromptSessions.getState().sessions[epicId].worktree!

    await expect(usePromptSessions.getState().markCompleted(epicId)).resolves.toBeUndefined()

    const updated = usePromptSessions.getState().sessions[epicId]
    expect(updated.status).toBe('completed')
    expect(updated.worktree?.status).toBe('needs_merge_resolution')
    expect(updated.worktree?.branch).toBe(worktreeBefore.branch)
    expect(updated.worktree?.dir).toBe(worktreeBefore.dir)

    const archiveCall = api.config.writeJson.mock.calls.find((c: unknown[]) => c[0] === promptSessionArchivePath('/proj', epicId))
    const [, archive] = archiveCall as [string, { session: { worktree?: { status: string; branch: string; dir: string } } }]
    expect(archive.session.worktree?.status).toBe('needs_merge_resolution')
    expect(archive.session.worktree?.branch).toBe(worktreeBefore.branch)
    expect(archive.session.worktree?.dir).toBe(worktreeBefore.dir)
  })

  it('markCompleted is a no-op merge attempt when the Epic has no worktree', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')

    await usePromptSessions.getState().markCompleted(session.id)

    expect(api.promptSessions.mergeToMain).not.toHaveBeenCalled()
  })

  it('mergeEpicToMain calls the IPC with the Epic worktree branch/dir and patches status to "merged" on success', async () => {
    const api = installWindowApiMock()
    api.promptSessions.mergeToMain.mockResolvedValue({ ok: true, status: 'merged', integrated: true })
    const { usePromptSessions, epicId } = await approvedEpicWithWorktree(api)

    const result = await usePromptSessions.getState().mergeEpicToMain(epicId)

    expect(result).toEqual({ ok: true, reason: undefined })
    expect(usePromptSessions.getState().sessions[epicId].worktree?.status).toBe('merged')
  })

  it('mergeEpicToMain patches status to "needs_merge_resolution" and surfaces the reason on conflict, without touching branch/dir', async () => {
    const api = installWindowApiMock()
    api.promptSessions.mergeToMain.mockResolvedValue({ ok: false, status: 'needs_merge_resolution', reason: 'merge failed (likely a real content conflict)' })
    const { usePromptSessions, epicId } = await approvedEpicWithWorktree(api)
    const worktreeBefore = usePromptSessions.getState().sessions[epicId].worktree!

    const result = await usePromptSessions.getState().mergeEpicToMain(epicId)

    expect(result).toEqual({ ok: false, reason: 'merge failed (likely a real content conflict)' })
    const worktreeAfter = usePromptSessions.getState().sessions[epicId].worktree!
    expect(worktreeAfter.status).toBe('needs_merge_resolution')
    expect(worktreeAfter.branch).toBe(worktreeBefore.branch)
    expect(worktreeAfter.dir).toBe(worktreeBefore.dir)
  })

  it('mergeEpicToMain no-ops when the Epic has no worktree', async () => {
    const api = installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Ship the feature')

    const result = await usePromptSessions.getState().mergeEpicToMain(session.id)

    expect(result).toEqual({ ok: false, reason: undefined })
    expect(api.promptSessions.mergeToMain).not.toHaveBeenCalled()
  })
})
