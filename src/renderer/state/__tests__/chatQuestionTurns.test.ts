import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TranscriptEvent } from '../../../preload/api'
import { normalizeQuestions, parseStopSignalQuestions, STOP_SENTINEL } from '../../lib/stopSignal'

/**
 * PRD question-turns-from-transcript-feed: the JSONL feed must create the
 * question turn from the assistant line's stop-signal block, reconciled with
 * the live chat:run:needs-input turn so each ask has exactly one card.
 * Harness copied from chatTranscriptFeed.test.ts.
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
  let needsInputHandler:
    | ((e: { tabId: string; sessionId: string; questions: string[]; answerBody?: string }) => void)
    | null = null
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
      onNeedsInput: vi.fn((handler) => {
        needsInputHandler = handler
        return () => {
          needsInputHandler = null
        }
      }),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(),
      createPrd: vi.fn(),
    },
    transcripts: {
      pathFor: vi.fn().mockResolvedValue('/tmp/fake.jsonl'),
      exists: vi.fn().mockResolvedValue(false),
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
    getNeedsInputHandler: () => needsInputHandler,
  }
}


const block = (questions: unknown) => `\n\n${STOP_SENTINEL}\n${JSON.stringify({ questions })}`

async function setup(tabId: string) {
  const mock = installWindowApiMock()
  const mod = await import('../chat')
  mod.attachTranscriptFeed({ tabId, cwd: '/proj', sessionUuid: `sess-${tabId}` })
  await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())
  return { mock, ...mod }
}

describe('stopSignal question parsing', () => {
  it('normalizeQuestions keeps non-empty trimmed strings in order, [] for non-arrays', () => {
    expect(normalizeQuestions(['  a ', '', 3, null, '   ', 'b'])).toEqual(['a', 'b'])
    expect(normalizeQuestions('a')).toEqual([])
    expect(normalizeQuestions(undefined)).toEqual([])
    expect(normalizeQuestions({ 0: 'a' })).toEqual([])
  })

  it('parseStopSignalQuestions: null without a valid block, normalized questions otherwise', () => {
    expect(parseStopSignalQuestions('plain reply')).toBeNull()
    expect(parseStopSignalQuestions(`body\n${STOP_SENTINEL}\n{not json`)).toBeNull()
    expect(parseStopSignalQuestions(`body${block([' Q1 ', '', 'Q2'])}`)).toEqual(['Q1', 'Q2'])
    expect(parseStopSignalQuestions(`body${block([])}`)).toEqual([])
  })
})

describe('chat.ts question turns from the transcript feed', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('a feed assistant line with a stop-signal block appends a question turn right after it', async () => {
    const { mock, useChat } = await setup('q-1')
    const ev = makeEv('assistant', `Body text.${block(['Deploy?', ' Which env? '])}`, { byteOffset: 500 })
    mock.emit('q-1', ev)
    const turns = useChat.getState().get('q-1').turns
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'question'])
    const q = turns[1]
    expect(q.questions).toEqual(['Deploy?', 'Which env?'])
    expect(q.text).toBe('Deploy?\nWhich env?')
    expect(q.ref).toEqual(ev.ref)
    expect(typeof q.at).toBe('number')
    expect(q.at).toBe(turns[0].at)
  })

  it('zero normalized questions or malformed JSON adds no question turn', async () => {
    const { mock, useChat } = await setup('q-2')
    mock.emit('q-2', makeEv('assistant', `First.${block(['', '  '])}`, { byteOffset: 600 }))
    mock.emit('q-2', makeEv('assistant', `Second.\n${STOP_SENTINEL}\n{"questions": [`, { byteOffset: 700 }))
    const turns = useChat.getState().get('q-2').turns
    expect(turns.filter((t) => t.role === 'question')).toHaveLength(0)
    expect(turns.filter((t) => t.role === 'assistant')).toHaveLength(2)
  })

  it('live needs-input first, feed second: one question turn, feed sets its ref', async () => {
    const { mock, useChat } = await setup('q-3')
    const body = 'Need a decision.'
    mock.getNeedsInputHandler()?.({ tabId: 'q-3', sessionId: 'sess-q-3', questions: ['Ship it?'], answerBody: body })
    const liveQ = useChat.getState().get('q-3').turns.find((t) => t.role === 'question')!
    expect(liveQ.ref).toBeFalsy()
    const ev = makeEv('assistant', `${body}${block(['Ship it?'])}`, { byteOffset: 800 })
    mock.emit('q-3', ev)
    const qs = useChat.getState().get('q-3').turns.filter((t) => t.role === 'question')
    expect(qs).toHaveLength(1)
    expect(qs[0].id).toBe(liveQ.id)
    expect(qs[0].ref).toEqual(ev.ref)
  })

  it('live needs-input with no answerBody first, feed second: still one question turn', async () => {
    const { mock, useChat } = await setup('q-3b')
    mock.getNeedsInputHandler()?.({ tabId: 'q-3b', sessionId: 'sess-q-3b', questions: ['Ship it?'] })
    mock.emit('q-3b', makeEv('assistant', block(['Ship it?']).trim(), { byteOffset: 850 }))
    expect(useChat.getState().get('q-3b').turns.filter((t) => t.role === 'question')).toHaveLength(1)
  })

  it('feed first, live needs-input second: appends nothing, ticket points at the existing turn, run closed', async () => {
    const { mock, useChat } = await setup('q-4')
    useChat.getState().send({ tabId: 'q-4', sessionId: 'sess-q-4', cwd: '/proj', prompt: 'go' })
    expect(useChat.getState().get('q-4').running).toBe(true)
    const body = 'Need a decision.'
    mock.emit('q-4', makeEv('assistant', `${body}${block(['Ship it?'])}`, { byteOffset: 900 }))
    const feedQ = useChat.getState().get('q-4').turns.find((t) => t.role === 'question')!
    const before = useChat.getState().get('q-4').turns.length
    mock.getNeedsInputHandler()?.({ tabId: 'q-4', sessionId: 'sess-q-4', questions: ['Ship it?'], answerBody: body })
    const c = useChat.getState().get('q-4')
    expect(c.turns.length).toBe(before)
    expect(c.turns.filter((t) => t.role === 'question')).toHaveLength(1)
    expect(c.running).toBe(false)
    expect(c.activeTicket).toBeNull()
    const ticket = (c.ticketHistory ?? []).find((t) => t.status === 'needs-input')
    expect(ticket?.questionTurnId).toBe(feedQ.id)
  })

  it('the same questions asked in two exchanges give two question turns', async () => {
    const { mock, useChat } = await setup('q-5')
    mock.emit('q-5', makeEv('assistant', `One.${block(['Ship it?'])}`, { byteOffset: 1000 }))
    mock.getNeedsInputHandler()?.({ tabId: 'q-5', sessionId: 'sess-q-5', questions: ['Ship it?'], answerBody: 'One.' })
    mock.emit('q-5', makeEv('user', 'not yet', { byteOffset: 1100 }))
    mock.getNeedsInputHandler()?.({ tabId: 'q-5', sessionId: 'sess-q-5', questions: ['Ship it?'], answerBody: 'Two.' })
    mock.emit('q-5', makeEv('assistant', `Two.${block(['Ship it?'])}`, { byteOffset: 1200 }))
    expect(useChat.getState().get('q-5').turns.filter((t) => t.role === 'question')).toHaveLength(2)
  })

  it('send() stamps origin human, send({external}) stamps external, and the JSONL upgrade keeps it', async () => {
    const { mock, useChat } = await setup('q-6')
    useChat.getState().send({ tabId: 'q-6', sessionId: 'sess-q-6', cwd: '/proj', prompt: 'hello human' })
    expect(useChat.getState().get('q-6').turns.at(-1)).toMatchObject({ role: 'user', origin: 'human' })
    mock.emit('q-6', makeEv('user', 'hello human', { byteOffset: 1300 }))
    const upgraded = useChat.getState().get('q-6').turns.filter((t) => t.role === 'user')
    expect(upgraded).toHaveLength(1)
    expect(upgraded[0].ref).toBeTruthy()
    expect(upgraded[0].origin).toBe('human')
    // Still running → the external send is queued and dispatched on completion.
    useChat.getState().send({ tabId: 'q-6', sessionId: 'sess-q-6', cwd: '/proj', prompt: 'hello ext', external: true })
    mock.getCompleteHandler()?.({ tabId: 'q-6', sessionId: 'sess-q-6', finalMessage: 'done' })
    await vi.waitFor(() =>
      expect(useChat.getState().get('q-6').turns.find((t) => t.text === 'hello ext')).toMatchObject({ origin: 'external' }),
    )
  })

  it('fresh external send stamps external; feed-only turns carry no origin', async () => {
    const { mock, useChat } = await setup('q-7')
    mock.emit('q-7', makeEv('user', 'from the feed', { byteOffset: 1400 }))
    expect(useChat.getState().get('q-7').turns[0].origin).toBeUndefined()
    useChat.getState().send({ tabId: 'q-7', sessionId: 'sess-q-7', cwd: '/proj', prompt: 'ext', external: true })
    expect(useChat.getState().get('q-7').turns.at(-1)).toMatchObject({ role: 'user', origin: 'external' })
  })

  it('onNeedsInput normalizes questions; an empty list keeps the old behaviour', async () => {
    const { mock, useChat } = await setup('q-8')
    mock.getNeedsInputHandler()?.({ tabId: 'q-8', sessionId: 'sess-q-8', questions: ['  A ', '', 'B'] })
    const q = useChat.getState().get('q-8').turns.find((t) => t.role === 'question')!
    expect(q.questions).toEqual(['A', 'B'])
    expect(q.text).toBe('A\nB')
    mock.getNeedsInputHandler()?.({ tabId: 'q-8', sessionId: 'sess-q-8', questions: ['', ' '] })
    const qs = useChat.getState().get('q-8').turns.filter((t) => t.role === 'question')
    expect(qs).toHaveLength(2)
    expect(qs[1].questions).toEqual([])
    expect(qs[1].text).toBe('')
  })
})
