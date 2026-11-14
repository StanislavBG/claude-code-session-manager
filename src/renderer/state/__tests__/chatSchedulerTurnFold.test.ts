import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TranscriptEvent } from '../../../preload/api'

/**
 * A scheduler check-in's JSONL user turn opens with chatRunner's
 * SCHEDULER_TURN_INSTRUCTION (not the stop-signal block). The splitter must
 * know that block, or the optimistic external-send turn and its JSONL twin
 * never fold and the check-in renders twice. The literal below is anchored on
 * the real block's first and last sentence; chat-preamble-anchors.test.cjs
 * guards those anchors against the main-process constant.
 */
const SCHEDULER_BLOCK =
  'IMPORTANT: This turn was started by the scheduler and nobody is watching. ' +
  'Never ask questions. Act on the message below. Make the safest reasonable choice ' +
  'for anything left open, and end with a short report of what you did.\n\n'
const CHAT_MODE_TRUTH_BLOCK =
  'IMPORTANT: This is a one-shot headless run. ' +
  'Nothing else will happen after your turn ends, so the human must send a new ' +
  'reply for the work to continue.\n\n'
const PROMPT = 'PRD 3081 finished: needs_review. Decide the next step.'

function makeUserEv(text: string, byteOffset: number): TranscriptEvent {
  return {
    kind: 'user',
    data: text,
    raw: { timestamp: new Date().toISOString() },
    previewText: text.slice(0, 280),
    ref: { filePath: '/tmp/fake.jsonl', byteOffset, byteLength: 10 },
  }
}

function installWindowApiMock() {
  const onEventHandlers = new Map<string, (events: TranscriptEvent[]) => void>()
  const buffer = vi.fn().mockResolvedValue([])
  const api = {
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn(),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(() => () => {}),
      onNeedsInput: vi.fn(() => () => {}),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(),
      createPrd: vi.fn(),
    },
    transcripts: {
      pathFor: vi.fn().mockResolvedValue('/tmp/fake.jsonl'),
      exists: vi.fn().mockResolvedValue(false),
      subscribe: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/fake.jsonl' }),
      buffer,
      unsubscribe: vi.fn().mockResolvedValue({ ok: true }),
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
    buffer,
    emit: (tabId: string, ev: TranscriptEvent) => onEventHandlers.get(tabId)?.([ev]),
  }
}

describe('scheduler check-in user turn folds with its optimistic twin', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('external send + JSONL scheduler-block turn leaves exactly one user turn', async () => {
    const mock = installWindowApiMock()
    const { useChat, attachTranscriptFeed } = await import('../chat')

    attachTranscriptFeed({ tabId: 'epic-sched', cwd: '/proj', sessionUuid: 'sess-sched' })
    await vi.waitFor(() => expect(mock.buffer).toHaveBeenCalled())

    useChat.getState().send({ tabId: 'epic-sched', sessionId: 'sess-sched', cwd: '/proj', prompt: PROMPT, external: true })
    await vi.waitFor(() =>
      expect(useChat.getState().get('epic-sched').turns.some((t) => t.role === 'user' && t.text === PROMPT)).toBe(true),
    )

    mock.emit('epic-sched', makeUserEv(`${SCHEDULER_BLOCK}${CHAT_MODE_TRUTH_BLOCK}${PROMPT}`, 5000))

    const users = useChat
      .getState()
      .get('epic-sched')
      .turns.filter((t) => t.role === 'user' && t.text.includes(PROMPT))
    expect(users).toHaveLength(1)
    expect(users[0].ref).toBeTruthy()
  })
})
