import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TranscriptEvent } from '../../../preload/api'

/**
 * PRD chat-feed-from-jsonl: the Epic Chat view's transcript is sourced from
 * the JSONL events transcripts.cjs emits (transcript:event:<tabId>), with
 * chatRunner's stream-json demoted to a low-latency live tap. These tests
 * cover the three AC-mandated cases:
 *   1. a JSONL-only event kind (mode / queue-operation / attachment) reaching
 *      the chat store;
 *   2. the streamed-then-persisted de-duplication rule (either arrival order);
 *   3. the empty/missing-transcript case rendering an empty-but-valid slice.
 */

function makeEv(kind: string, data: unknown, opts: { timestamp?: string; byteOffset?: number } = {}): TranscriptEvent {
  return {
    kind,
    data,
    raw: { timestamp: opts.timestamp ?? new Date().toISOString() },
    previewText: typeof data === 'string' ? data.slice(0, 280) : JSON.stringify(data).slice(0, 280),
    ref: { filePath: '/tmp/fake.jsonl', byteOffset: opts.byteOffset ?? Math.floor(Math.random() * 1e9), byteLength: 10 },
  }
}

function installWindowApiMock(opts: {
  subscribeResult?: { ok: boolean; path: string | null; error?: string }
  bufferEvents?: TranscriptEvent[]
} = {}) {
  const onEventHandlers = new Map<string, (ev: TranscriptEvent) => void>()
  let completeHandler: ((e: { tabId: string; sessionId: string; finalMessage: string }) => void) | null = null
  const subscribe = vi.fn().mockResolvedValue(opts.subscribeResult ?? { ok: true, path: '/tmp/fake.jsonl' })
  const buffer = vi.fn().mockResolvedValue(opts.bufferEvents ?? [])
  const unsubscribe = vi.fn().mockResolvedValue({ ok: true })
  const api = {
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn((handler) => {
        completeHandler = handler
        return () => {
          completeHandler = null
        }
      }),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(),
      createPrd: vi.fn(),
    },
    transcripts: {
      pathFor: vi.fn().mockResolvedValue('/tmp/fake.jsonl'),
      subscribe,
      buffer,
      unsubscribe,
      onEvent: vi.fn((tabId: string, handler: (ev: TranscriptEvent) => void) => {
        onEventHandlers.set(tabId, handler)
        return () => onEventHandlers.delete(tabId)
      }),
    },
    config: { exists: vi.fn().mockResolvedValue(true), readJson: vi.fn().mockResolvedValue({ exists: false, data: null }) },
    logs: { write: vi.fn() },
    promptSessionTranscript: {
      append: vi.fn().mockResolvedValue({ ok: true }),
      read: vi.fn().mockResolvedValue({ turns: [] }),
    },
  }
  vi.stubGlobal('window', { api })
  return {
    api,
    subscribe,
    buffer,
    unsubscribe,
    emit: (tabId: string, ev: TranscriptEvent) => onEventHandlers.get(tabId)?.(ev),
    hasListener: (tabId: string) => onEventHandlers.has(tabId),
    getCompleteHandler: () => completeHandler,
  }
}

describe('chat.ts transcript feed (PRD chat-feed-from-jsonl)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('a JSONL-only event kind (queue-operation / mode / attachment) reaches the chat store', async () => {
    const mock = installWindowApiMock({
      bufferEvents: [makeEv('queue-operation', { operation: 'enqueue' }, { byteOffset: 100 })],
    })
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-1', cwd: '/proj', sessionUuid: 'sess-uuid-1' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())
    await vi.waitFor(() => expect(useChat.getState().get('epic-1').turns.length).toBe(1))

    // Replayed buffer event landed as an 'event' turn with its kind preserved.
    const replayed = useChat.getState().get('epic-1').turns[0]
    expect(replayed.role).toBe('event')
    expect(replayed.kind).toBe('queue-operation')

    // A live JSONL-only event also lands.
    mock.emit('epic-1', makeEv('mode', { mode: 'plan' }, { byteOffset: 200 }))
    const turns = useChat.getState().get('epic-1').turns
    expect(turns.length).toBe(2)
    expect(turns[1].kind).toBe('mode')
    mock.emit('epic-1', makeEv('attachment', { file: 'a.png' }, { byteOffset: 300 }))
    expect(useChat.getState().get('epic-1').turns[2].kind).toBe('attachment')
  })

  it('de-dupes a streamed-then-persisted assistant turn: JSONL lands first, chatRunner complete merges', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-2', cwd: '/proj', sessionUuid: 'sess-uuid-2' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    // JSONL assistant line lands (authoritative).
    mock.emit('epic-2', makeEv('assistant', 'Here is the answer.', { byteOffset: 400 }))
    expect(useChat.getState().get('epic-2').turns.filter((t) => t.role === 'assistant').length).toBe(1)

    // chatRunner's stream-json result arrives with the same text — must merge, not duplicate.
    mock.getCompleteHandler()?.({ tabId: 'epic-2', sessionId: 'sess-uuid-2', finalMessage: 'Here is the answer.' })
    const assistants = useChat.getState().get('epic-2').turns.filter((t) => t.role === 'assistant')
    expect(assistants.length).toBe(1)
    // The merge still carries the completion's outcome label.
    expect(assistants[0].outcome).toBe('Landed')
    expect(useChat.getState().get('epic-2').running).toBe(false)
  })

  it('de-dupes in the reverse order: complete lands first, the later JSONL line is skipped', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-3', cwd: '/proj', sessionUuid: 'sess-uuid-3' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    mock.getCompleteHandler()?.({ tabId: 'epic-3', sessionId: 'sess-uuid-3', finalMessage: 'Same text.' })
    expect(useChat.getState().get('epic-3').turns.filter((t) => t.role === 'assistant').length).toBe(1)

    mock.emit('epic-3', makeEv('assistant', 'Same text.', { byteOffset: 500 }))
    expect(useChat.getState().get('epic-3').turns.filter((t) => t.role === 'assistant').length).toBe(1)
  })

  it('does NOT de-dupe identical completions on a tab with no transcript feed (plain dormant tab)', async () => {
    const mock = installWindowApiMock()
    const { useChat } = await import('../chat')

    // Two genuinely separate runs answering "Done." twice must both render.
    mock.getCompleteHandler()?.({ tabId: 'tab-plain', sessionId: 's', finalMessage: 'Done.' })
    mock.getCompleteHandler()?.({ tabId: 'tab-plain', sessionId: 's', finalMessage: 'Done.' })
    expect(useChat.getState().get('tab-plain').turns.filter((t) => t.role === 'assistant').length).toBe(2)
  })

  it('a replayed buffer is not double-ingested on re-attach (view switch and back)', async () => {
    const events = [
      makeEv('user', 'hello', { byteOffset: 0 }),
      makeEv('assistant', 'hi there', { byteOffset: 50 }),
    ]
    const mock = installWindowApiMock({ bufferEvents: events })
    const { useChat, attachTranscriptFeed, detachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-4', cwd: '/proj', sessionUuid: 'sess-uuid-4' })
    await vi.waitFor(() => expect(useChat.getState().get('epic-4').turns.length).toBe(2))

    detachTranscriptFeed('epic-4')
    expect(mock.unsubscribe).toHaveBeenCalledWith('epic-4')

    // Re-attach: main-side LRU cache returns the same ring buffer as replay.
    attachTranscriptFeed({ tabId: 'epic-4', cwd: '/proj', sessionUuid: 'sess-uuid-4' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalledTimes(2))
    // Still exactly two turns — no duplication, no reorder.
    const turns = useChat.getState().get('epic-4').turns
    expect(turns.length).toBe(2)
    expect(turns[0].text).toBe('hello')
    expect(turns[1].text).toBe('hi there')
  })

  it('an Epic whose transcript does not yet exist renders an empty-but-valid slice', async () => {
    const mock = installWindowApiMock({ bufferEvents: [] })
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-new', cwd: '/proj', sessionUuid: 'sess-uuid-new' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    const slice = useChat.getState().get('epic-new')
    expect(slice.turns).toEqual([])
    expect(slice.running).toBe(false)
    // Feed attach supersedes exchange hydration for this tab.
    expect(useChat.getState().hydratedTabs['epic-new']).toBe(true)
  })

  it('rolls back the hydration marker when the subscription is rejected (cap reached)', async () => {
    installWindowApiMock({ subscribeResult: { ok: false, path: null, error: 'too many active subscriptions' } })
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-cap', cwd: '/proj', sessionUuid: 'sess-uuid-cap' })
    await vi.waitFor(() => expect(useChat.getState().hydratedTabs['epic-cap']).toBeUndefined())
    // Slice is still valid and empty — never errors or spins.
    expect(useChat.getState().get('epic-cap').turns).toEqual([])
  })

  it('excises the matching streamed prefix from the live tap when the authoritative JSONL line lands mid-run', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-5', cwd: '/proj', sessionUuid: 'sess-uuid-5' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    // Simulate an in-flight run whose stream already accumulated block text.
    useChat.setState({
      chats: {
        ...useChat.getState().chats,
        'epic-5': { ...useChat.getState().get('epic-5'), running: true, stream: 'First block text. tail' },
      },
    })
    mock.emit('epic-5', makeEv('assistant', 'First block text.', { byteOffset: 600 }))
    const slice = useChat.getState().get('epic-5')
    // The turn landed once, and the streamed copy of the same text is gone.
    expect(slice.turns.filter((t) => t.role === 'assistant').length).toBe(1)
    expect(slice.stream).toBe(' tail')
  })
})
