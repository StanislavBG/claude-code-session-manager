// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Turn } from '../../ChatTranscriptTurn'
import { EpicComposer } from '../EpicComposer'
import { useChat } from '../../../state/chat'
import { useVoice } from '../../../state/voice'
import type { PromptSession } from '../../../state/promptSessions'
import type { EpicSnapshots } from '../../../lib/epicDerive'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * Full round trip for the reply-context quote affordance: a turn's hover
 * "Quote" button (ChatTranscriptTurn.tsx's `onQuote` prop, wired by
 * EpicDetail's Discussion timeline) feeding EpicComposer's dismissible
 * strip. EpicDetail.test.tsx already covers onQuote firing with the turn's
 * text, and EpicComposer.test.tsx already covers the strip rendering/
 * clearing once `quote` is set — this file closes the remaining gap: that
 * the two wire together the way EpicsWorkspace.tsx actually wires them
 * (one `quote` state value threaded to both siblings), without mounting the
 * full EpicsWorkspace and its many stores.
 */

;(globalThis as any).window.api = {
  chat: { cancel: vi.fn() },
  browser: { saveBinary: vi.fn(async () => ({ ok: true })) },
}

vi.mock('../../../state/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('../../../lib/speechRecognition', () => ({
  createRecognition: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    setVadThresholds: vi.fn(),
    getAnalyser: vi.fn(() => null),
  })),
  isRecognitionSupported: vi.fn(() => true),
  preloadModel: vi.fn(),
  resetModel: vi.fn(),
}))
vi.mock('../../../lib/vadDucking', () => ({ attachVadDucking: vi.fn(() => () => {}) }))
vi.mock('../../../lib/speechSynthesis', () => ({
  stopSpeaking: vi.fn(),
  isSpeaking: vi.fn(() => false),
  getSpeakStartedAt: vi.fn(() => null),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function epic(overrides: Partial<PromptSession> = {}): PromptSession {
  return {
    id: 'epic-1',
    cwd: '/home/bilko/Projects/alpha',
    goalText: 'Ship the thing',
    claudeSessionId: 'sess-1',
    status: 'active',
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    tag: 'feature',
    ...overrides,
  }
}

function snapshots(overrides: Partial<EpicSnapshots> = {}): EpicSnapshots {
  return { sessions: {}, chats: {}, jobs: [], prds: [], ...overrides }
}

/** Mirrors EpicsWorkspace.tsx's own wiring: `quote` state lives above both
 *  the Discussion timeline (Turn) and EpicComposer, which are siblings. */
function QuoteReplyHarness({ e }: { e: PromptSession }) {
  const [quote, setQuote] = useState<string | undefined>(undefined)
  return createElement(
    'div',
    null,
    createElement(Turn, {
      turn: { id: 't-1', role: 'user', text: 'the earlier message', at: 1000 },
      cwd: e.cwd,
      tabId: e.id,
      sessionId: e.claudeSessionId,
      onQuote: setQuote,
    }),
    createElement(EpicComposer, {
      epic: e,
      snapshots: snapshots(),
      quote,
      onClearQuote: () => setQuote(undefined),
    }),
  )
}

beforeEach(() => {
  useChat.setState({ chats: {} })
  useVoice.setState({
    isRecording: false,
    modelStatus: 'ready',
    permissionState: 'granted',
    error: null,
    errorKind: null,
  } as any)
})

afterEach(() => {
  if (useVoice.getState().isRecording) useVoice.getState().stopRecording()
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.restoreAllMocks()
})

describe('quote-reply round trip (Turn onQuote -> EpicComposer strip)', () => {
  it('clicking a turn\'s Quote button shows the quoted text in the composer strip', () => {
    const e = epic()
    const el = mount(createElement(QuoteReplyHarness, { e }))

    expect(el.querySelector('[data-testid="epic-composer-quote-strip"]')).toBeNull()
    const quoteBtn = el.querySelector('[data-testid="chat-turn-quote"]') as HTMLButtonElement
    act(() => quoteBtn.click())

    const strip = el.querySelector('[data-testid="epic-composer-quote-strip"]')
    expect(strip).not.toBeNull()
    expect(strip!.textContent).toContain('the earlier message')
  })

  it('the strip\'s X button clears the quote', () => {
    const e = epic()
    const el = mount(createElement(QuoteReplyHarness, { e }))
    const quoteBtn = el.querySelector('[data-testid="chat-turn-quote"]') as HTMLButtonElement
    act(() => quoteBtn.click())
    expect(el.querySelector('[data-testid="epic-composer-quote-strip"]')).not.toBeNull()

    const clearBtn = el.querySelector('[data-testid="epic-composer-quote-clear"]') as HTMLButtonElement
    act(() => clearBtn.click())
    expect(el.querySelector('[data-testid="epic-composer-quote-strip"]')).toBeNull()
  })

  it('a successful send clears the quote', async () => {
    const send = vi.fn()
    useChat.setState({ send } as any)
    const e = epic()
    const el = mount(createElement(QuoteReplyHarness, { e }))
    const quoteBtn = el.querySelector('[data-testid="chat-turn-quote"]') as HTMLButtonElement
    act(() => quoteBtn.click())
    expect(el.querySelector('[data-testid="epic-composer-quote-strip"]')).not.toBeNull()

    const textarea = el.querySelector('[data-testid="epic-composer-textarea"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(textarea, 'my follow-up')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = el.querySelector('[data-testid="epic-composer-send"]') as HTMLButtonElement
    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushAsync(2)

    expect(send).toHaveBeenCalledWith({ tabId: 'epic-1', sessionId: 'sess-1', cwd: e.cwd, prompt: 'my follow-up' })
    expect(el.querySelector('[data-testid="epic-composer-quote-strip"]')).toBeNull()
  })
})
