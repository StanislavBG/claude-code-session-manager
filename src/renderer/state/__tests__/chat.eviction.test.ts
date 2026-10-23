import { describe, it, expect, beforeEach, vi } from 'vitest'
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
      readText: vi.fn().mockResolvedValue({ exists: true, text: '', mtimeMs: 0, error: null }),
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
      archiveTranscript: vi.fn().mockResolvedValue({ path: '/p/e.jsonl.gz', bytes: 15, gzBytes: 10, sha256: 'abc' }),
      mergeActiveIndex: vi.fn().mockResolvedValue({ sessions: {}, events: {} }),
      create: fakePromptSessionsCreate(),
      createWorktree: vi.fn().mockResolvedValue(null),
      mergeToMain: vi.fn().mockResolvedValue({ ok: true, status: 'merged', integrated: true }),
    },
    auditLog: { append: vi.fn().mockResolvedValue({ ok: true }) },
  }
  vi.stubGlobal('window', { api })
  return api
}

type ChatStore = typeof import('../chat').useChat

function seedChat(useChat: ChatStore, id: string, extra: Record<string, unknown> = {}) {
  useChat.setState({
    chats: {
      ...useChat.getState().chats,
      [id]: { turns: [{ id: `t-${id}`, role: 'user', text: 'hi', at: 1 }], running: false, queuedPosition: 0, started: true, stream: '', liveToolUses: [], queue: [], ...extra } as never,
    },
  })
}

describe('chat eviction', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('deleteEpic drops the Epic chat entry and its hydration flag', async () => {
    installWindowApiMock()
    const { useChat } = await import('../chat')
    const { usePromptSessions } = await import('../promptSessions')
    const session = await usePromptSessions.getState().createPromptSession('/proj', 'Throwaway')
    seedChat(useChat, session.id)
    useChat.setState({ hydratedTabs: { [session.id]: true } })

    await usePromptSessions.getState().deleteEpic(session.id)

    expect(useChat.getState().chats[session.id]).toBeUndefined()
    expect(useChat.getState().hydratedTabs[session.id]).toBeUndefined()
  })

  it('viewing a 9th Epic evicts the least recently viewed idle chat', async () => {
    installWindowApiMock()
    const { useChat } = await import('../chat')
    const st = useChat.getState()
    for (let i = 1; i <= 9; i++) {
      seedChat(useChat, `e${i}`)
      st.touchEpicChat(`e${i}`)
      st.evictIdleChats(8, `e${i}`)
    }
    const ids = Object.keys(useChat.getState().chats)
    expect(ids).toHaveLength(8)
    expect(ids).not.toContain('e1')
    expect(ids).toContain('e9')
  })

  it('never evicts a chat with an in-flight run (running, queued or streaming)', async () => {
    installWindowApiMock()
    const { useChat } = await import('../chat')
    const st = useChat.getState()
    seedChat(useChat, 'e1', { running: true })
    seedChat(useChat, 'e2', { stream: 'partial' })
    seedChat(useChat, 'e3', { queuedPosition: 1 })
    st.touchEpicChat('e1')
    st.touchEpicChat('e2')
    st.touchEpicChat('e3')
    for (let i = 4; i <= 11; i++) {
      seedChat(useChat, `e${i}`)
      st.touchEpicChat(`e${i}`)
      st.evictIdleChats(8, `e${i}`)
    }
    const ids = Object.keys(useChat.getState().chats)
    expect(ids).toEqual(expect.arrayContaining(['e1', 'e2', 'e3', 'e11']))
    expect(ids).not.toContain('e4')
  })

  it('never evicts the visible (keep) Epic even when it is oldest', async () => {
    installWindowApiMock()
    const { useChat } = await import('../chat')
    const st = useChat.getState()
    for (let i = 1; i <= 9; i++) {
      seedChat(useChat, `e${i}`)
      st.touchEpicChat(`e${i}`)
    }
    st.evictIdleChats(8, 'e1')
    const ids = Object.keys(useChat.getState().chats)
    expect(ids).toContain('e1')
    expect(ids).not.toContain('e2')
  })

  it('caps promptSessions events per Epic at 500, dropping the oldest', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../promptSessions')
    const store = usePromptSessions.getState()
    const session = await store.createPromptSession('/proj', 'Busy epic')
    for (let i = 0; i < 510; i++) {
      const tail = usePromptSessions.getState().events[session.id].at(-1)!
      store.appendPromptSessionEvent(session.id, { kind: 'response', causedByEventId: tail.id, summary: `r${i}` } as never)
    }
    const evs = usePromptSessions.getState().events[session.id]
    expect(evs).toHaveLength(500)
    expect(evs.at(-1)).toMatchObject({ summary: 'r509' })
  })
})
