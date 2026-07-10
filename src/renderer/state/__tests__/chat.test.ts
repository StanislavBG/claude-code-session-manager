import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * chat.ts's create-vs-resume decision must be driven by the on-disk
 * transcript (mirroring sessions.ts's resolveStartupCommand), not the
 * ephemeral `started` flag — that ephemeral flag is what produced the
 * "Session ID <uuid> is already in use" bug after a reload. window.api is
 * mocked here since vitest runs this suite in a node environment.
 */

function installWindowApiMock(opts: { transcriptExists: boolean }) {
  const run = vi.fn().mockResolvedValue(undefined)
  const api = {
    chat: {
      run,
      cancel: vi.fn(),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
    },
    transcripts: {
      pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl'),
    },
    config: {
      exists: vi.fn().mockResolvedValue(opts.transcriptExists),
    },
    logs: { write: vi.fn() },
  }
  vi.stubGlobal('window', { api })
  return { api, run }
}

describe('chat.ts send() resume decision', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('resumes when a transcript file already exists on disk', async () => {
    const { api, run } = installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 'tab-1', sessionId: 'sess-1', cwd: '/proj', prompt: 'hello' })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())

    expect(api.transcripts.pathFor).toHaveBeenCalledWith('/proj', 'sess-1')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-1', sessionId: 'sess-1', resume: true }),
    )
  })

  it('creates fresh when no transcript file exists on disk', async () => {
    const { api, run } = installWindowApiMock({ transcriptExists: false })
    const { useChat } = await import('../chat')

    useChat.getState().send({ tabId: 'tab-2', sessionId: 'sess-2', cwd: '/proj', prompt: 'hello' })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())

    expect(api.transcripts.pathFor).toHaveBeenCalledWith('/proj', 'sess-2')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-2', sessionId: 'sess-2', resume: false }),
    )
  })
})

describe('chat.ts resetThread()', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('clears turns and run state for the tab', async () => {
    installWindowApiMock({ transcriptExists: true })
    const { useChat } = await import('../chat')

    useChat.setState({
      chats: {
        't1': {
          turns: [{ id: 'a', role: 'user', text: 'hi', at: 1 }],
          running: false,
          queuedPosition: 0,
          started: true,
          stream: 'partial',
          liveToolUses: [{ id: 'u1', kind: 'tool', label: 'Bash' }],
        },
      },
    })

    useChat.getState().resetThread('t1')

    const cleared = useChat.getState().get('t1')
    expect(cleared.turns).toEqual([])
    expect(cleared.started).toBe(false)
    expect(cleared.stream).toBe('')
    expect(cleared.liveToolUses).toEqual([])
    expect(cleared.running).toBe(false)
  })
})
