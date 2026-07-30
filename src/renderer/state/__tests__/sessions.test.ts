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
