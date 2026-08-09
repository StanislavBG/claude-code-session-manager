import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TranscriptEvent } from '../../../preload/api'
import { INJECTED_PROMPT_BLOCKS } from '../../lib/promptPreamble'

/** A realistic chatRunner preamble, composed from the REAL anchor constants
 *  (src/main/__tests__/chat-preamble-anchors.test.cjs keeps those honest
 *  against the main-process strings) rather than a copied literal. */
const INJECTED_PREAMBLE = INJECTED_PROMPT_BLOCKS.map((b) => `${b.start} …filler… ${b.end}`).join('\n\n')

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
  const onEventHandlers = new Map<string, (events: TranscriptEvent[]) => void>()
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
      onEvent: vi.fn((tabId: string, handler: (events: TranscriptEvent[]) => void) => {
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
    // Accepts a single event (wrapped as a 1-element batch, matching a real
    // one-event flush) or an explicit array (a multi-event batch/flush).
    emit: (tabId: string, evOrEvents: TranscriptEvent | TranscriptEvent[]) =>
      onEventHandlers.get(tabId)?.(Array.isArray(evOrEvents) ? evOrEvents : [evOrEvents]),
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

  // The prompt rendered TWICE in the Discussion: beginRun pushes an optimistic
  // user turn holding exactly what the human typed, while the JSONL records
  // what chatRunner actually sent — the same message with ~1.4k chars of
  // injected preamble on the front. A raw text=== comparison never matched.
  it('de-dupes the optimistic user turn against the JSONL line carrying the injected preamble', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-preamble', cwd: '/proj', sessionUuid: 'sess-uuid-p' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    // What beginRun pushes on send: the human's own words, no ref, no kind.
    const cur = useChat.getState().get('epic-preamble')
    useChat.setState({
      chats: {
        ...useChat.getState().chats,
        'epic-preamble': {
          ...cur,
          turns: [...cur.turns, { id: 'optimistic', role: 'user' as const, text: 'Fix the composer', at: Date.now() }],
        },
      },
    })

    // The JSONL line for that same message, preamble and all.
    mock.emit('epic-preamble', makeEv('user', `${INJECTED_PREAMBLE}\n\nFix the composer`, { byteOffset: 700 }))

    const users = useChat.getState().get('epic-preamble').turns.filter((t) => t.role === 'user')
    expect(users).toHaveLength(1)
    // Upgraded in place, not dropped: the byte-exact text and `ref` survive so
    // Show raw / the ≡ preamble disclosure still work.
    expect(users[0].ref).toBeTruthy()
    expect(users[0].kind).toBe('user')
    expect(users[0].text).toContain('Fix the composer')
    expect(users[0].text).toContain(INJECTED_PROMPT_BLOCKS[0].start)
  })

  it('still renders two genuinely different prompts sent back to back', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-two', cwd: '/proj', sessionUuid: 'sess-uuid-two' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    mock.emit('epic-two', makeEv('user', `${INJECTED_PREAMBLE}\n\nFirst ask`, { byteOffset: 800 }))
    mock.emit('epic-two', makeEv('user', `${INJECTED_PREAMBLE}\n\nSecond ask`, { byteOffset: 900 }))

    const users = useChat.getState().get('epic-two').turns.filter((t) => t.role === 'user')
    expect(users).toHaveLength(2)
  })

  // DEFECT A (PRD 1029): DEDUP_WINDOW=20 only scanned the last 20 turns, but
  // the two sources are separated by every EVENT of a run (tool_use,
  // tool_result, usage…), not by conversation turns — measured up to a
  // median gap of 104 in real transcripts. findRecentDuplicateTurn must scan
  // the whole live `turns` array so a twin is still found past 100+
  // intervening event turns.
  it('finds the JSONL twin after 60+ intervening non-text event turns (DEFECT A)', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-gap', cwd: '/proj', sessionUuid: 'sess-uuid-gap' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    // chatRunner's completion lands first.
    mock.getCompleteHandler()?.({ tabId: 'epic-gap', sessionId: 'sess-uuid-gap', finalMessage: 'Deep answer.' })
    expect(useChat.getState().get('epic-gap').turns.filter((t) => t.role === 'assistant')).toHaveLength(1)

    // 60 intervening non-text transcript events — far more than the old
    // fixed 20-turn window could ever see past.
    for (let i = 0; i < 60; i++) {
      mock.emit('epic-gap', makeEv('tool_use', { name: 'Bash', input: {} }, { byteOffset: 10000 + i }))
    }

    // The JSONL line for the same reply lands last, well outside the old window.
    mock.emit('epic-gap', makeEv('assistant', 'Deep answer.', { byteOffset: 20000 }))

    const assistants = useChat.getState().get('epic-gap').turns.filter((t) => t.role === 'assistant')
    expect(assistants).toHaveLength(1)
    // The JSONL record wins the merge (upgrade-in-place rule): it carries `ref`.
    expect(assistants[0].ref).toBeTruthy()
    expect(assistants[0].text).toBe('Deep answer.')
  })

  // DEFECT B (PRD 1029): dedupe used to be gated on `feedRefs` (the currently
  // -attached IPC listener), which detachTranscriptFeed clears — so a run
  // completing while the Chat view was switched away appended with NO
  // dedupe, and the next re-attach's replay landed the JSONL twin unfolded.
  // Reconciliation must stay gated on "this tab has ever been feed-backed"
  // (feedBacked / feedIngest), which survives detach.
  it('still dedupes a run that completes entirely while the feed is detached (DEFECT B)', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed, detachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-detached', cwd: '/proj', sessionUuid: 'sess-uuid-detached' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    detachTranscriptFeed('epic-detached')
    expect(mock.unsubscribe).toHaveBeenCalledWith('epic-detached')

    // A run completes entirely while detached (Epic switched to Terminal /
    // another Epic open) — chatRunner's completion is the only thing that
    // lands, with no live feed turn to merge into yet.
    mock.getCompleteHandler()?.({
      tabId: 'epic-detached',
      sessionId: 'sess-uuid-detached',
      finalMessage: 'While you were away.',
    })
    expect(useChat.getState().get('epic-detached').turns.filter((t) => t.role === 'assistant')).toHaveLength(1)

    // Re-attach and replay the run's events, including the JSONL assistant text.
    attachTranscriptFeed({ tabId: 'epic-detached', cwd: '/proj', sessionUuid: 'sess-uuid-detached' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalledTimes(2))
    mock.emit('epic-detached', makeEv('assistant', 'While you were away.', { byteOffset: 30000 }))

    const assistants = useChat.getState().get('epic-detached').turns.filter((t) => t.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].ref).toBeTruthy()
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

/**
 * PRD transcript-batch-flush: transcripts.cjs now sends a whole flush's
 * events as one ordered array per IPC message, and window.api.transcripts
 * .onEvent's handler is array-shaped to match. ingestTranscriptEvents folds
 * a whole batch through ONE store commit instead of one per event. These
 * tests cover the commit-count reduction, order preservation, and
 * byte-identical results vs. the old per-event path (including the
 * streamed-then-persisted dedupe rule, which depends on event order).
 */
describe('chat.ts ingestTranscriptEvents — batched IPC events land as one commit, in order', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('a live batch (array) emitted on the transcript feed channel lands as one commit with all turns in order', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-batch', cwd: '/proj', sessionUuid: 'sess-uuid-batch' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    const batch = [
      makeEv('mode', { mode: 'plan' }, { byteOffset: 1000 }),
      makeEv('user', `${INJECTED_PREAMBLE}\n\nDo the thing`, { byteOffset: 1001 }),
      makeEv('assistant', 'Working on it.', { byteOffset: 1002 }),
      makeEv('queue-operation', { operation: 'enqueue' }, { byteOffset: 1003 }),
    ]

    const setSpy = vi.spyOn(useChat, 'setState')
    setSpy.mockClear()
    mock.emit('epic-batch', batch)
    expect(setSpy).toHaveBeenCalledTimes(1)
    setSpy.mockRestore()

    const turns = useChat.getState().get('epic-batch').turns
    expect(turns.map((t) => t.kind)).toEqual(['mode', 'user', 'assistant', 'queue-operation'])
    expect(turns[2].text).toBe('Working on it.')
  })

  it('a replay buffer containing 20+ events lands as one commit (benchmark: N commits → 1)', async () => {
    const events = Array.from({ length: 24 }, (_, i) => makeEv('queue-operation', { i }, { byteOffset: 2000 + i }))
    const mock = installWindowApiMock({ bufferEvents: events })
    const { useChat, attachTranscriptFeed } = await import('../chat')

    const setSpy = vi.spyOn(useChat, 'setState')
    setSpy.mockClear()
    attachTranscriptFeed({ tabId: 'epic-bench', cwd: '/proj', sessionUuid: 'sess-uuid-bench' })
    await vi.waitFor(() => expect(useChat.getState().get('epic-bench').turns.length).toBe(24))
    // The one hydratedTabs write (attach) + one write for the whole 24-event
    // replay batch — NOT 24 separate per-event commits.
    expect(setSpy.mock.calls.length).toBeLessThanOrEqual(2)
    setSpy.mockRestore()
    mock.emit('epic-bench', []) // no-op sanity: emitting an empty batch is safe
  })

  it('preserves the streamed-then-persisted dedupe rule when the JSONL line arrives inside a batch, not alone', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-batch-dedupe', cwd: '/proj', sessionUuid: 'sess-uuid-bd' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    // Optimistic user turn (what beginRun pushes on send).
    const cur = useChat.getState().get('epic-batch-dedupe')
    useChat.setState({
      chats: {
        ...useChat.getState().chats,
        'epic-batch-dedupe': {
          ...cur,
          turns: [...cur.turns, { id: 'optimistic', role: 'user' as const, text: 'Fix the composer', at: Date.now() }],
        },
      },
    })

    // The JSONL line for that same message arrives as part of a larger batch
    // (mode event before it, queue-operation after) — the dedupe must still
    // upgrade the optimistic turn in place, not append a duplicate.
    mock.emit('epic-batch-dedupe', [
      makeEv('mode', { mode: 'plan' }, { byteOffset: 3000 }),
      makeEv('user', `${INJECTED_PREAMBLE}\n\nFix the composer`, { byteOffset: 3001 }),
      makeEv('queue-operation', { operation: 'enqueue' }, { byteOffset: 3002 }),
    ])

    const users = useChat.getState().get('epic-batch-dedupe').turns.filter((t) => t.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0].ref).toBeTruthy()
    expect(users[0].text).toContain('Fix the composer')
  })

  it('byte-identical result: a whole fixture ingested as one batch matches feeding it one event at a time', async () => {
    installWindowApiMock()
    const { useChat, ingestTranscriptEvent, ingestTranscriptEvents } = await import('../chat')

    const fixture = [
      makeEv('mode', { mode: 'plan' }, { byteOffset: 4000, timestamp: '2026-01-01T00:00:00.000Z' }),
      makeEv('user', `${INJECTED_PREAMBLE}\n\nFirst ask`, { byteOffset: 4001, timestamp: '2026-01-01T00:00:01.000Z' }),
      makeEv('assistant', 'On it.', { byteOffset: 4002, timestamp: '2026-01-01T00:00:02.000Z' }),
      makeEv('queue-operation', { operation: 'enqueue' }, { byteOffset: 4003, timestamp: '2026-01-01T00:00:03.000Z' }),
      makeEv('user', `${INJECTED_PREAMBLE}\n\nSecond ask`, { byteOffset: 4004, timestamp: '2026-01-01T00:00:04.000Z' }),
      makeEv('attachment', { file: 'a.png' }, { byteOffset: 4005, timestamp: '2026-01-01T00:00:05.000Z' }),
    ]

    for (const ev of fixture) ingestTranscriptEvent('tab-seq', ev)
    ingestTranscriptEvents('tab-batch', fixture)

    const strip = (turns: ReturnType<typeof useChat.getState>['chats'][string]['turns']) =>
      turns.map(({ id: _id, ...rest }) => rest)

    expect(strip(useChat.getState().get('tab-batch').turns)).toEqual(strip(useChat.getState().get('tab-seq').turns))
  })
})
