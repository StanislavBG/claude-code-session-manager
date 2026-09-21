// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { fakePromptSessionsCreate } from '../../../testUtils/fakePromptSessionsCreate'

/**
 * EpicDetail memoizes buildEpicTimeline on [turns, sessionEvents, verbosity]:
 * stream-only chat updates (one per chat:run:output block) must not re-run it.
 */
const buildSpy = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/epicTimeline', async (orig) => {
  const actual = await orig<typeof import('../../../lib/epicTimeline')>()
  return {
    ...actual,
    buildEpicTimeline: (...args: Parameters<typeof actual.buildEpicTimeline>) => {
      buildSpy()
      return actual.buildEpicTimeline(...args)
    },
  }
})

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onQueued: vi.fn(),
      onRunStarted: vi.fn(),
      onOutput: vi.fn(),
      onToolUse: vi.fn(),
      onComplete: vi.fn(() => () => {}),
      onNeedsInput: vi.fn(),
      onError: vi.fn(),
      onNotice: vi.fn(),
      onExternalSend: vi.fn(),
      classifyTicket: vi.fn(async () => 'inline' as const),
      createPrd: vi.fn(async () => ({ ok: true as const, nn: 1, filename: '1-fake.md' })),
    },
    pty: { kill: vi.fn() },
    transcripts: { pathFor: vi.fn().mockResolvedValue('/tmp/fake/transcript.jsonl') },
    epicDelegationStats: { get: vi.fn().mockResolvedValue({ prdsQueued: 0, inlineEdits: 0 }) },
    config: {
      exists: vi.fn().mockResolvedValue(true),
      readText: vi.fn().mockResolvedValue({ exists: false, text: '' }),
      readJson: vi.fn().mockResolvedValue({ exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    logs: { write: vi.fn() },
    schedule: { listPrds: vi.fn().mockResolvedValue([]) },
    promptSessionTranscript: {
      append: vi.fn().mockResolvedValue({ ok: true }),
      read: vi.fn().mockResolvedValue({ turns: [] }),
    },
    promptSessions: { create: fakePromptSessionsCreate(), onEventAppended: vi.fn() },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

describe('EpicDetail timeline memoization', () => {
  beforeEach(() => {
    vi.resetModules()
    buildSpy.mockClear()
    delete (window as unknown as { api?: unknown }).api
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('derives the timeline once across 20 stream-only updates', async () => {
    installWindowApiMock()
    const { usePromptSessions } = await import('../../../state/promptSessions')
    const { useChat } = await import('../../../state/chat')
    const { EpicDetail } = await import('../EpicDetail')

    const session = await usePromptSessions.getState().createPromptSession('/tmp/proj', 'Ship it', 'feature')
    const turns = [
      { id: 'u1', role: 'user', text: 'hello', at: 1 },
      { id: 'a1', role: 'assistant', text: 'hi there', at: 2 },
    ]
    const setChat = (stream: string) =>
      useChat.setState({
        chats: { [session.id]: { turns, running: true, stream, queuedPosition: 0, liveToolUses: [] } as any },
      })
    setChat('')

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(createElement(EpicDetail, { promptSession: session })))
    const baseline = buildSpy.mock.calls.length
    expect(baseline).toBe(1)

    for (let i = 1; i <= 20; i++) act(() => setChat('x'.repeat(i)))

    expect(buildSpy.mock.calls.length).toBe(baseline)
  }, 60_000)
})
