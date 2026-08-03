// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

/**
 * role:'event' typed renderers (PRD chat-typed-event-renderers). Covers the
 * router-never-filter contract: an unknown/made-up event kind still renders
 * (via the generic Signal card), only the two documented suppressions
 * (repeated ai-title, duplicate last-prompt) ever drop a turn, an unlisted
 * attachment subtype falls through to the generic card, and a malformed
 * payload renders an empty-state shell rather than throwing.
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
    transcripts: { pathFor: async () => '/tmp/fake/transcript.jsonl', readRef: async () => ({ ok: false as const }) },
    config: { exists: async () => true },
    logs: { write: () => {} },
    clipboard: { writeText: async () => ({ ok: true }) },
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

function baseTurnProps() {
  return { cwd: '/tmp/proj', tabId: 'tab-1', sessionId: 'sess-1' }
}

describe('ChatTranscriptTurn — role:event dispatch', () => {
  beforeEach(() => {
    installWindowApiMock()
  })

  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders a completely made-up event kind via the generic Signal card rather than dropping it', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-1',
          role: 'event',
          text: 'a made up event',
          at: Date.now(),
          kind: 'tip',
          signal: { text: 'drink water' },
        } as any,
        ...baseTurnProps(),
      }),
    )
    const card = el.querySelector('[data-testid="signal-card"]')
    expect(card).toBeTruthy()
    expect(card?.getAttribute('data-signal-kind')).toBe('tip')
    expect(el.textContent).toContain('tip')
  })

  it('falls through an unlisted attachment subtype to the generic Signal card', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-2',
          role: 'event',
          text: '',
          at: Date.now(),
          kind: 'attachment',
          signal: { subtype: 'some_future_subtype', text: 'payload' },
        } as any,
        ...baseTurnProps(),
      }),
    )
    expect(el.querySelector('[data-testid="signal-card"]')).toBeTruthy()
  })

  it('renders an explicit empty state (not a throw) for a malformed/undefined signal', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    expect(() =>
      mount(
        createElement(Turn, {
          turn: {
            id: 't-3',
            role: 'event',
            text: '',
            at: Date.now(),
            kind: 'attachment',
            signal: undefined,
          } as any,
          ...baseTurnProps(),
        }),
      ),
    ).not.toThrow()
    const card = document.querySelector('[data-testid="signal-card"]')
    expect(card?.textContent).toContain('attachment')
  })

  it('renders known typed events through their dedicated renderer, not the generic card', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const modeEl = mount(
      createElement(Turn, {
        turn: { id: 't-4', role: 'event', text: '', at: Date.now(), kind: 'mode', signal: { value: 'plan' } } as any,
        ...baseTurnProps(),
      }),
    )
    expect(modeEl.querySelector('[data-testid="event-divider"]')).toBeTruthy()
    expect(modeEl.querySelector('[data-testid="signal-card"]')).toBeFalsy()
    expect(modeEl.textContent).toContain('plan')
  })

  it('renders deferred_tools_delta as an expandable name-count chip', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-5',
          role: 'event',
          text: '',
          at: Date.now(),
          kind: 'attachment',
          signal: { subtype: 'deferred_tools_delta', names: ['Bash', 'Read'], count: 2 },
        } as any,
        ...baseTurnProps(),
      }),
    )
    expect(el.querySelector('[data-testid="name-count-chip"]')).toBeTruthy()
    expect(el.textContent).toContain('+2 tools')
  })

  it('renders a tool_result as an outcome chip with a byte count', async () => {
    const { Turn } = await import('../ChatTranscriptTurn')
    const el = mount(
      createElement(Turn, {
        turn: {
          id: 't-6',
          role: 'event',
          text: 'stdout body',
          at: Date.now(),
          kind: 'tool_result',
          signal: { value: 'stdout body', isError: false },
        } as any,
        ...baseTurnProps(),
      }),
    )
    expect(el.querySelector('[data-testid="tool-result-chip"]')).toBeTruthy()
  })
})

describe('visibleFeedTurns — the only two permitted suppressions', () => {
  it('drops a repeated ai-title but keeps the first occurrence', async () => {
    const { visibleFeedTurns } = await import('../ChatTranscriptTurn')
    const turns = [
      { id: '1', role: 'event', text: '', at: 1, kind: 'ai-title', signal: { text: 'My Session' } },
      { id: '2', role: 'event', text: '', at: 2, kind: 'ai-title', signal: { text: 'My Session' } },
    ] as any
    const out = visibleFeedTurns(turns)
    expect(out.map((t: any) => t.id)).toEqual(['1'])
  })

  it('drops a last-prompt that duplicates the immediately preceding user turn', async () => {
    const { visibleFeedTurns } = await import('../ChatTranscriptTurn')
    const turns = [
      { id: '1', role: 'user', text: 'do the thing', at: 1 },
      { id: '2', role: 'event', text: '', at: 2, kind: 'last-prompt', signal: { text: 'do the thing' } },
    ] as any
    const out = visibleFeedTurns(turns)
    expect(out.map((t: any) => t.id)).toEqual(['1'])
  })

  it('keeps every other event kind — including a second, DIFFERENT ai-title and a non-duplicate last-prompt', async () => {
    const { visibleFeedTurns } = await import('../ChatTranscriptTurn')
    const turns = [
      { id: '1', role: 'user', text: 'do the thing', at: 1 },
      { id: '2', role: 'event', text: '', at: 2, kind: 'last-prompt', signal: { text: 'a different prompt' } },
      { id: '3', role: 'event', text: '', at: 3, kind: 'ai-title', signal: { text: 'Title A' } },
      { id: '4', role: 'event', text: '', at: 4, kind: 'ai-title', signal: { text: 'Title B' } },
      { id: '5', role: 'event', text: '', at: 5, kind: 'mode', signal: { value: 'plan' } },
      { id: '6', role: 'event', text: '', at: 6, kind: 'queue-operation', signal: { value: 'enqueue' } },
      { id: '7', role: 'event', text: '', at: 7, kind: 'usage', signal: { text: '10 in · 5 out' } },
    ] as any
    const out = visibleFeedTurns(turns)
    expect(out.map((t: any) => t.id)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  })
})

describe('nearestPrecedingUserPrompt', () => {
  it('skips over intervening event turns to find the nearest user turn', async () => {
    const { nearestPrecedingUserPrompt } = await import('../ChatTranscriptTurn')
    const turns = [
      { id: '1', role: 'user', text: 'please deploy', at: 1 },
      { id: '2', role: 'event', text: '', at: 2, kind: 'mode', signal: { value: 'plan' } },
      { id: '3', role: 'notice', text: 'needs consent', at: 3 },
    ] as any
    expect(nearestPrecedingUserPrompt(turns, 2)).toBe('please deploy')
  })

  it('returns undefined when the nearest non-event turn is not a user turn', async () => {
    const { nearestPrecedingUserPrompt } = await import('../ChatTranscriptTurn')
    const turns = [
      { id: '1', role: 'assistant', text: 'ok', at: 1 },
      { id: '2', role: 'event', text: '', at: 2, kind: 'mode', signal: { value: 'plan' } },
      { id: '3', role: 'notice', text: 'needs consent', at: 3 },
    ] as any
    expect(nearestPrecedingUserPrompt(turns, 2)).toBeUndefined()
  })
})
