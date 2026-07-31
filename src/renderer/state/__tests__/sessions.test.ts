import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * newSession() mints a fresh sessionId for the tab, shared by both Chat and
 * the raw PTY (there is a single unified session id per tab).
 */

function installWindowApiMock() {
  const api = {
    pty: { kill: vi.fn() },
    watchers: { killTab: vi.fn().mockResolvedValue(undefined) },
    transcripts: {
      closeTab: vi.fn().mockResolvedValue(undefined),
      pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'),
    },
    config: { exists: vi.fn().mockResolvedValue(false) },
    sessions: {
      load: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null, freshStart: false }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    chat: {
      cancel: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue({ ok: true }),
      // chat.ts subscribes to these at module load time (guarded on
      // window.api?.chat existing) — stub as no-ops so importing sessions.ts
      // (which now imports chat.ts) doesn't throw in this non-renderer test env.
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

describe('sessions.ts queueRawCommand()/consumeRawCommand()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('round-trips a queued command and clears it after one consume', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    useSessions.getState().queueRawCommand('tab-1', '/design consent')
    expect(useSessions.getState().consumeRawCommand('tab-1')).toBe('/design consent')
    expect(useSessions.getState().consumeRawCommand('tab-1')).toBeNull()
  })

  it('returns null for a tab with nothing queued', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    expect(useSessions.getState().consumeRawCommand('never-queued')).toBeNull()
  })
})

describe('sessions.ts addTab()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('dormant:true creates a dormant tab with no startupCommand', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const id = useSessions.getState().addTab({
      cwd: '/proj',
      startupCommand: 'claude --dangerously-skip-permissions --session-id ignored',
      dormant: true,
    })

    const tab = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(tab.status).toBe('dormant')
    expect(tab.startupCommand).toBeNull()
  })

  it('omitting dormant keeps today\'s spawning behavior', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const startupCommand = 'claude --dangerously-skip-permissions --session-id abc'
    const id = useSessions.getState().addTab({ cwd: '/proj', startupCommand })

    const tab = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(tab.status).toBe('spawning')
    expect(tab.startupCommand).toBe(startupCommand)
  })

  it('double-add with an existing id returns the existing tab id without changing it', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const id = useSessions.getState().addTab({ cwd: '/proj', startupCommand: null, dormant: true })
    const before = useSessions.getState().tabs.find((t) => t.id === id)!

    const returnedId = useSessions.getState().addTab({
      id,
      cwd: '/proj',
      startupCommand: 'claude --dangerously-skip-permissions --session-id different',
    })

    expect(returnedId).toBe(id)
    const after = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(after).toEqual(before)
    expect(useSessions.getState().tabs.filter((t) => t.id === id)).toHaveLength(1)
  })
})

describe('sessions.ts newSession()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('mints a fresh sessionId for the tab', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const id = useSessions.getState().addTab({ cwd: '/proj', startupCommand: null })
    const before = useSessions.getState().tabs.find((t) => t.id === id)!
    const prevSessionId = before.sessionId
    expect(prevSessionId).toBeTruthy()

    useSessions.getState().newSession(id)

    const after = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(after.sessionId).not.toBe(prevSessionId)
  })
})

describe('sessions.ts groupTabsByCwd()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('returns an empty array for 0 tabs', async () => {
    const { groupTabsByCwd } = await import('../sessions')
    expect(groupTabsByCwd([])).toEqual([])
  })

  it('groups a single project with a single tab', async () => {
    installWindowApiMock()
    const { useSessions, groupTabsByCwd } = await import('../sessions')

    useSessions.getState().addTab({ cwd: '/proj-a', startupCommand: null, dormant: true })

    const groups = groupTabsByCwd(useSessions.getState().tabs)
    expect(groups).toHaveLength(1)
    expect(groups[0].cwd).toBe('/proj-a')
    expect(groups[0].tabs).toHaveLength(1)
  })

  it('groups 2+ tabs sharing one cwd together', async () => {
    installWindowApiMock()
    const { useSessions, groupTabsByCwd } = await import('../sessions')

    useSessions.getState().addTab({ cwd: '/proj-a', startupCommand: null, dormant: true })
    useSessions.getState().addTab({ cwd: '/proj-a', startupCommand: null, dormant: true })

    const groups = groupTabsByCwd(useSessions.getState().tabs)
    expect(groups).toHaveLength(1)
    expect(groups[0].cwd).toBe('/proj-a')
    expect(groups[0].tabs).toHaveLength(2)
  })

  it('produces a separate group per distinct cwd, ordered by first appearance', async () => {
    installWindowApiMock()
    const { useSessions, groupTabsByCwd } = await import('../sessions')

    useSessions.getState().addTab({ cwd: '/proj-b', startupCommand: null, dormant: true })
    useSessions.getState().addTab({ cwd: '/proj-a', startupCommand: null, dormant: true })
    useSessions.getState().addTab({ cwd: '/proj-b', startupCommand: null, dormant: true })

    const groups = groupTabsByCwd(useSessions.getState().tabs)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.cwd)).toEqual(['/proj-b', '/proj-a'])
    expect(groups[0].tabs).toHaveLength(2)
    expect(groups[1].tabs).toHaveLength(1)
  })
})

describe('sessions.ts addSessionToProject()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('creates a dormant tab pinned to the given cwd with a fresh id/sessionId', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const id = useSessions.getState().addSessionToProject('/proj-c')

    const tab = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(tab).toBeTruthy()
    expect(tab.cwd).toBe('/proj-c')
    expect(tab.status).toBe('dormant')
    expect(tab.sessionId).toBe(id)
  })

  it('creates independent tabs on repeated calls for the same cwd', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const id1 = useSessions.getState().addSessionToProject('/proj-c')
    const id2 = useSessions.getState().addSessionToProject('/proj-c')

    expect(id1).not.toBe(id2)
    const tabs = useSessions.getState().tabs.filter((t) => t.cwd === '/proj-c')
    expect(tabs).toHaveLength(2)
  })

  it('passes through opts.label and opts.presetId', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const id = useSessions.getState().addSessionToProject('/proj-c', { label: 'custom', presetId: 'preset-x' })

    const tab = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(tab.label).toBe('custom')
    expect(tab.presetId).toBe('preset-x')
  })
})

/**
 * PRD 718: wakeTab (opening a raw session) must not race chatRunner's
 * headless `claude -p --resume <sessionId>` — cancel it and wait before
 * spawning the raw pty against the same session id.
 */
describe('sessions.ts wakeTab() vs. an in-flight chat run', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('cancels the in-flight chat run and waits for it before proceeding', async () => {
    const api = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useChat } = await import('../chat')
    const { useToast } = await import('../toast')

    const id = useSessions.getState().addTab({ cwd: '/proj', startupCommand: null })
    useSessions.getState().sleepTab(id) // -> dormant, so wakeTab is eligible

    useChat.setState({
      chats: {
        [id]: {
          turns: [],
          running: true,
          queuedPosition: 0,
          started: true,
          stream: '',
          liveToolUses: [],
          queue: [],
        },
      },
    })

    await useSessions.getState().wakeTab(id)

    expect(api.chat.cancel).toHaveBeenCalledWith(id)
    expect(useToast.getState().toasts.some((t) => /cancelled/i.test(t.message))).toBe(true)

    const tab = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(tab.status).toBe('spawning')
  })

  it('does not call chat.cancel or toast when no chat run is running', async () => {
    const api = installWindowApiMock()
    const { useSessions } = await import('../sessions')
    const { useToast } = await import('../toast')

    const id = useSessions.getState().addTab({ cwd: '/proj', startupCommand: null })
    useSessions.getState().sleepTab(id)

    await useSessions.getState().wakeTab(id)

    expect(api.chat.cancel).not.toHaveBeenCalled()
    expect(useToast.getState().toasts.some((t) => /cancelled/i.test(t.message))).toBe(false)

    const tab = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(tab.status).toBe('spawning')
  })

  it('waking a never-run dormant tab (no transcript) resolves a fresh --session-id command, not --resume', async () => {
    const api = installWindowApiMock()
    api.config.exists.mockResolvedValue(false) // no JSONL on disk for this sessionId yet
    const { useSessions } = await import('../sessions')

    // Mirrors createPickedSession()/openInSession(): a dormant tab created
    // directly via addTab({ dormant: true }), never spawned or woken before.
    const id = useSessions.getState().addTab({ cwd: '/proj', startupCommand: null, dormant: true })

    await useSessions.getState().wakeTab(id)

    const tab = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(tab.status).toBe('spawning')
    expect(tab.sessionId).toBe(id)
    expect(tab.startupCommand).toContain(`--session-id '${id}'`)
    expect(tab.startupCommand).not.toContain('--resume')
  })
})
