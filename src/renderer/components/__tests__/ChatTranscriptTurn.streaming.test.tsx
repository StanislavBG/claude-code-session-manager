// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { ChatTurn } from '../../state/chat'

const spy = vi.hoisted(() => ({ calls: [] as Array<{ src: string; opts: unknown }> }))
vi.mock('../../lib/renderChatMarkdown', async (orig) => {
  const real = await orig<typeof import('../../lib/renderChatMarkdown')>()
  return {
    ...real,
    renderChatMarkdown: (src: string, opts?: { cache?: boolean }) => {
      spy.calls.push({ src, opts })
      return real.renderChatMarkdown(src, opts)
    },
  }
})

import { Turn } from '../ChatTranscriptTurn'
import { chatMarkdownCacheSize } from '../../lib/renderChatMarkdown'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  vi.useFakeTimers()
  spy.calls.length = 0
  const api = {
    chat: { run: vi.fn(), cancel: vi.fn() },
    transcripts: { readRef: vi.fn().mockResolvedValue({ ok: true, text: '' }) },
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
  }
  ;(window as unknown as { api: typeof api }).api = api
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

function mount(turn: ChatTurn, streaming: boolean) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (t: ChatTurn) =>
    act(() => {
      root!.render(
        createElement(Turn, { turn: t, cwd: '/tmp', tabId: 't', sessionId: 's', runActive: true, streaming }),
      )
    })
  render(turn)
  return render
}

const live = (text: string): ChatTurn => ({ id: 'e-live', role: 'assistant', text, at: 1 })

describe('Turn streaming gate', () => {
  it('throttles and bypasses the cache for the live bubble', () => {
    const render = mount(live('word0'), true)
    const size = chatMarkdownCacheSize()
    spy.calls.length = 0
    let last = ''
    for (let i = 1; i <= 30; i++) {
      last = `word0${' more'.repeat(i)}`
      render(live(last))
      act(() => { vi.advanceTimersByTime(3) })
    }
    expect(spy.calls.length).toBeLessThanOrEqual(2)
    expect(spy.calls.every((c) => (c.opts as { cache?: boolean } | undefined)?.cache === false)).toBe(true)
    act(() => { vi.advanceTimersByTime(100) })
    expect(host!.textContent).toContain(last)
    expect(spy.calls.every((c) => (c.opts as { cache?: boolean } | undefined)?.cache === false)).toBe(true)
    expect(chatMarkdownCacheSize()).toBe(size)
  })

  it('keeps a finished turn (runActive, not streaming) on the cached path', () => {
    mount(live('finished text'), false)
    expect(spy.calls.length).toBeGreaterThan(0)
    expect(spy.calls.some((c) => (c.opts as { cache?: boolean } | undefined)?.cache === false)).toBe(false)
  })
})
