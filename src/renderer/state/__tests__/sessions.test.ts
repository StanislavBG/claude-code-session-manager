import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * chatSessionId is minted separately from claudeSessionId so chat's
 * --session-id never collides with the raw PTY's lock (see the comment at
 * SessionTab.chatSessionId in sessions.ts). newChatThread() must mint a
 * fresh id without touching claudeSessionId.
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

describe('sessions.ts newChatThread()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('mints a fresh chatSessionId without changing claudeSessionId', async () => {
    installWindowApiMock()
    const { useSessions } = await import('../sessions')

    const id = useSessions.getState().addTab({ cwd: '/proj', startupCommand: null })
    const before = useSessions.getState().tabs.find((t) => t.id === id)!
    const prevChatId = before.chatSessionId
    const prevClaudeId = before.claudeSessionId
    expect(prevChatId).toBeTruthy()

    useSessions.getState().newChatThread(id)

    const after = useSessions.getState().tabs.find((t) => t.id === id)!
    expect(after.chatSessionId).not.toBe(prevChatId)
    expect(after.claudeSessionId).toBe(prevClaudeId)
  })
})
