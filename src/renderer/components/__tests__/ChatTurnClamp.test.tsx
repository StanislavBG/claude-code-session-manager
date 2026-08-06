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
