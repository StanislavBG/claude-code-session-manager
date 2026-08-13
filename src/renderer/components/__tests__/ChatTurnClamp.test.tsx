// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * Turn's `clampBodyChars` / `toolStripVariant='hidden'` props — the rendering
 * half of the chat verbosity dial (lib/chatVerbosity.ts). The filtering half
 * is covered by lib/__tests__/chatVerbosity.test.ts.
 */

function installWindowApiMock() {
  const api = {
    chat: {
      run: async () => undefined,
      cancel: async () => undefined,
      onQueued: () => {},
      onRunStarted: () => {},
      onOutput: () => {},
      onToolUse: () => {},
      onComplete: () => () => {},
      onNeedsInput: () => {},
      onError: () => {},
      onNotice: () => {},
      onExternalSend: () => {},
      classifyTicket: async () => 'inline' as const,
      createPrd: async () => ({ ok: true as const, nn: 1, filename: '1-fake.md' }),
    },
    transcripts: { pathFor: async () => '/tmp/f.jsonl', readRef: async () => ({ ok: false as const }) },
    config: { exists: async () => true },
    logs: { write: () => {} },
    clipboard: { writeText: vi.fn(async () => ({ ok: true })) },
  }
  ;(window as unknown as { api: typeof api }).api = api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

const LONG = `Short lead line.\n\n${'Detail sentence that goes on. '.repeat(60)}`

function assistantTurn() {
  return { id: 't-1', role: 'assistant' as const, text: LONG, at: Date.now() }
}

const base = { cwd: '/tmp/proj', tabId: 'tab-1', sessionId: 'sess-1' }

const PREAMBLE =
  'IMPORTANT: First deliver everything you CAN answer or produce right now — findings, the ' +
  'requested content, work already completed — as normal output. Only THEN, if something still ' +
  'blocks you from finishing, end your turn by emitting, as the very last line, exactly:\n' +
  '<<<SM_NEEDS_INPUT>>>\nfollowed on the next line by a single-line JSON object. ' +
  'Otherwise complete the task and end with a concise summary of what you did.\n\n'
const HUMAN = 'Review the Alpaca limits and report back.'

describe('Turn — injectedPreamble disclosure', () => {
  beforeEach(() => installWindowApiMock())
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  const userTurn = () => ({ id: 'u-1', role: 'user' as const, text: PREAMBLE + HUMAN, at: Date.now() })

  it("CORE: 'hidden' shows only the human's words behind a ≡ toggle, and restores in place", async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(createElement(Turn, { turn: userTurn(), ...base, injectedPreamble: 'hidden' } as any))

    expect(el.textContent).toContain(HUMAN)
    expect(el.textContent).not.toContain('IMPORTANT: First deliver everything')
    expect(el.querySelector('[data-testid="chat-turn-preamble"]')).toBeFalsy()

    const toggle = el.querySelector('[data-testid="chat-turn-preamble-toggle"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    act(() => toggle.click())
    expect(el.querySelector('[data-testid="chat-turn-preamble"]')!.textContent).toContain(
      'IMPORTANT: First deliver everything',
    )
    expect(el.textContent).toContain(HUMAN)
  })

  it("EDGE: 'shown' (the default for every non-Epic caller) renders the raw prompt with no toggle", async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(createElement(Turn, { turn: userTurn(), ...base } as any))
    expect(el.querySelector('[data-testid="chat-turn-preamble-toggle"]')).toBeFalsy()
    expect(el.textContent).toContain('IMPORTANT: First deliver everything')
  })

  it('EDGE: a plain human prompt gets no toggle at all', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: { id: 'u-2', role: 'user' as const, text: HUMAN, at: Date.now() },
        ...base,
        injectedPreamble: 'hidden',
      } as any),
    )
    expect(el.querySelector('[data-testid="chat-turn-preamble-toggle"]')).toBeFalsy()
    expect(el.textContent).toContain(HUMAN)
  })

  it('CORE: Quote yields the human’s words, not the boilerplate', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const quoted: string[] = []
    const el = mount(
      createElement(Turn, {
        turn: userTurn(),
        ...base,
        injectedPreamble: 'hidden',
        onQuote: (t: string) => quoted.push(t),
      } as any),
    )
    act(() => (el.querySelector('[data-testid="chat-turn-quote"]') as HTMLButtonElement).click())
    expect(quoted).toEqual([HUMAN])
  })
})

describe('Turn — clampBodyChars', () => {
  beforeEach(() => installWindowApiMock())
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('CORE: clamps a long assistant body and restores it in full on toggle', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(createElement(Turn, { turn: assistantTurn(), ...base, clampBodyChars: 420 } as any))

    const body = () => el.querySelector('.prose-chat')!.textContent ?? ''
    expect(body().length).toBeLessThan(LONG.length)
    expect(body()).toContain('Short lead line.')

    const toggle = el.querySelector('[data-testid="chat-turn-expand-body"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.textContent).toContain('Show full message')

    act(() => toggle.click())
    // Full text is restored from the turn already in hand — no re-fetch.
    expect(el.querySelector('.prose-chat')!.textContent).toContain('Detail sentence that goes on.')
    expect(
      (el.querySelector('[data-testid="chat-turn-expand-body"]') as HTMLButtonElement).textContent,
    ).toContain('Show less')
  })

  it('EDGE: no toggle at all when the caller passes no clamp (default behavior unchanged)', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(createElement(Turn, { turn: assistantTurn(), ...base } as any))
    expect(el.querySelector('[data-testid="chat-turn-expand-body"]')).toBeFalsy()
    expect(el.querySelector('.prose-chat')!.textContent).toContain('Detail sentence that goes on.')
  })

  it('EDGE: a question turn is never clamped, even with a clamp set', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: { id: 'q-1', role: 'question', text: LONG, questions: [LONG], at: Date.now() },
        ...base,
        clampBodyChars: 40,
      } as any),
    )
    expect(el.querySelector('[data-testid="chat-turn-question"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="chat-turn-expand-body"]')).toBeFalsy()
    expect(el.textContent).toContain('Detail sentence that goes on.')
  })

  it("CORE: toolStripVariant='hidden' omits the tool strip entirely", async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const turn = {
      id: 't-2',
      role: 'assistant' as const,
      text: 'done',
      at: Date.now(),
      toolUses: [{ id: 'tu-1', kind: 'tool' as const, label: 'Read' }],
    }
    const shown = mount(createElement(Turn, { turn, ...base, toolStripVariant: 'collapsible' } as any))
    expect(shown.querySelector('[data-testid="tool-strip-toggle"]')).toBeTruthy()
    act(() => root!.unmount())
    container!.remove()

    const hidden = mount(createElement(Turn, { turn, ...base, toolStripVariant: 'hidden' } as any))
    expect(hidden.querySelector('[data-testid="tool-strip-toggle"]')).toBeFalsy()
    expect(hidden.textContent).toContain('done')
  })
})

// PRD chat-stop-signal-duplicate-turn — the surviving assistant turn after
// reconciliation may hold the JSONL feed's byte-exact text, sentinel block
// and all (state/chat.ts's turnIdentity is now stop-signal-insensitive). The
// bubble must show only the body; the raw `<<<SM_NEEDS_INPUT>>>` + questions
// JSON must never render as message prose (the separate 'question' turn
// already renders those questions as its own card).
describe('Turn — stop-signal render-time strip', () => {
  beforeEach(() => installWindowApiMock())
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  const STOP_BODY = 'Here is what I found and what I still need from you.'
  const stopSignalTurn = () => ({
    id: 't-stop',
    role: 'assistant' as const,
    text: `${STOP_BODY}\n\n<<<SM_NEEDS_INPUT>>>\n${JSON.stringify({ questions: ['Deploy to prod now?'] })}`,
    at: Date.now(),
  })

  it('CORE: renders only the body, never the sentinel line or the questions JSON', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(createElement(Turn, { turn: stopSignalTurn(), ...base } as any))
    expect(el.textContent).toContain(STOP_BODY)
    expect(el.textContent).not.toContain('<<<SM_NEEDS_INPUT>>>')
    expect(el.textContent).not.toContain('Deploy to prod now?')
  })

  it('EDGE: turn.text itself stays byte-exact — Show raw still yields the sentinel block', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const turn = stopSignalTurn()
    mount(createElement(Turn, { turn, ...base } as any))
    expect(turn.text).toContain('<<<SM_NEEDS_INPUT>>>')
    expect(turn.text).toContain('Deploy to prod now?')
  })

  it('EDGE: a plain assistant reply with no sentinel renders unchanged', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const turn = { id: 't-plain', role: 'assistant' as const, text: 'Just a normal reply.', at: Date.now() }
    const el = mount(createElement(Turn, { turn, ...base } as any))
    expect(el.textContent).toContain('Just a normal reply.')
  })

  it('EDGE: Quote sends the stripped body, not the raw sentinel block', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const quoted: string[] = []
    const el = mount(createElement(Turn, { turn: stopSignalTurn(), ...base, onQuote: (t: string) => quoted.push(t) } as any))
    act(() => (el.querySelector('[data-testid="chat-turn-quote"]') as HTMLButtonElement).click())
    expect(quoted).toEqual([STOP_BODY])
  })
})
