// @vitest-environment jsdom
import { createElement, memo, type ReactNode } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Turn } from '../ChatTranscriptTurn'
import type { ChatTurn } from '../../state/chat'

/**
 * perf-memo-list-rows (Round 2), case 2: Turn (ChatTranscriptTurn.tsx) is
 * ~430 lines and is rendered once per timeline item by EpicDetail.tsx, over
 * a feed capped at FEED_TURNS_CAP (1000), with no memoization and no
 * virtualization. This file proves Turn is now React.memo, so appending one
 * turn to an existing timeline re-renders only the new turn — every earlier
 * turn keeps its object identity (chat.ts appends immutably, see
 * pushTurn/`turns: [...cur.turns, ...]`) and every other Turn prop EpicDetail
 * passes is otherwise a stable primitive/callback, so the memo bails for all
 * of them.
 *
 * It also proves the two invariants that outrank this optimization
 * (CLAUDE.md): a 'question' turn still renders on every pass (memo never
 * "hides" it — it only skips re-render when output would be byte-identical),
 * and the in-flight bubble (EpicDetail passes a brand-new `turn` object
 * literal every render while `chat.stream` grows) keeps updating live.
 */

function installWindowApiMock() {
  const api = {
    chat: {
      run: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    transcripts: { readRef: vi.fn().mockResolvedValue({ ok: true, text: '' }) },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
  }
  ;(window as unknown as { api: typeof api }).api = api
}

const renderCounts = vi.hoisted(() => ({ counts: {} as Record<string, number> }))

// Reaches through Turn's own memo (`Turn.type`) to the real underlying render
// function, and wraps it in an outer counting memo — the real component body
// still runs on every genuine re-render; this only counts how often that
// happens per turn id.
function countedTurn(real: { type: (props: unknown) => ReactNode }) {
  return memo((props: { turn: ChatTurn } & Record<string, unknown>) => {
    renderCounts.counts[props.turn.id] = (renderCounts.counts[props.turn.id] ?? 0) + 1
    return real.type(props)
  })
}

const CountedTurn = countedTurn(Turn as unknown as { type: (props: unknown) => ReactNode })

function makeTurn(i: number): ChatTurn {
  return { id: `turn-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}`, at: i }
}

const stableOnQuote = vi.fn()

function Timeline({ turns }: { turns: ChatTurn[] }) {
  return createElement(
    'div',
    null,
    ...turns.map((t) =>
      createElement(CountedTurn, {
        key: t.id,
        turn: t,
        cwd: '/proj',
        tabId: 'epic-1',
        sessionId: 'sess-1',
        runActive: false,
        onQuote: stableOnQuote,
      }),
    ),
  )
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

describe('Turn stays memoized across a timeline append', () => {
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    renderCounts.counts = {}
    delete (window as unknown as { api?: unknown }).api
  })

  it('appending one turn to a 50-turn timeline re-renders only the new turn', () => {
    installWindowApiMock()
    const turns = Array.from({ length: 50 }, (_, i) => makeTurn(i))
    mount(createElement(Timeline, { turns }))

    const before = { ...renderCounts.counts }
    expect(Object.keys(before)).toHaveLength(50)
    expect(Object.values(before).every((c) => c === 1)).toBe(true)

    const appended = [...turns, makeTurn(50)]
    act(() => {
      root!.render(createElement(Timeline, { turns: appended }))
    })

    const after = renderCounts.counts
    expect(Object.keys(after)).toHaveLength(51)
    for (let i = 0; i < 50; i++) {
      expect(after[`turn-${i}`]).toBe(before[`turn-${i}`])
    }
    expect(after['turn-50']).toBe(1)
  })

  it('a question turn keeps rendering on every pass — memo never hides it', () => {
    installWindowApiMock()
    const question: ChatTurn = { id: 'q-1', role: 'question', text: 'Deploy now?', questions: ['Deploy now?'], at: 0 }
    const el = mount(createElement(Timeline, { turns: [question] }))
    expect(el.textContent).toContain('Deploy now?')

    // A genuinely new turn object (same content) — still renders every time,
    // proving the memo's shallow-prop check never suppresses this role.
    act(() => {
      root!.render(createElement(Timeline, { turns: [{ ...question }] }))
    })
    expect(renderCounts.counts['q-1']).toBe(2)
    expect(el.textContent).toContain('Deploy now?')
  })

  it('the in-flight assistant bubble keeps updating live while chat.stream grows', () => {
    installWindowApiMock()
    function LiveHarness({ streamText }: { streamText: string }) {
      return createElement(CountedTurn, {
        turn: { id: 'epic-1-live', role: 'assistant', text: streamText, at: Date.now() },
        cwd: '/proj',
        tabId: 'epic-1',
        sessionId: 'sess-1',
        runActive: true,
      })
    }
    const el = mount(createElement(LiveHarness, { streamText: 'partial resp' }))
    expect(el.textContent).toContain('partial resp')
    expect(renderCounts.counts['epic-1-live']).toBe(1)

    act(() => {
      root!.render(createElement(LiveHarness, { streamText: 'partial response now complete' }))
    })
    expect(el.textContent).toContain('partial response now complete')
    expect(renderCounts.counts['epic-1-live']).toBe(2)
  })
})
