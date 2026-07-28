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
  }
  vi.stubGlobal('window', { api })
  return api
}

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
