// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach } from 'vitest'
import { CrossProjectReplyCard, CrossProjectReplyReceipt } from '../CrossProjectReplyCard'
import type { PromptSessionEvent } from '../../../state/promptSessions'

/** A cross-project reply landing in the asking Epic renders as a distinct card. */

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReturnType<typeof createElement>): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

type Reply = NonNullable<PromptSessionEvent['reply']>

function event(overrides: Partial<PromptSessionEvent>, reply?: Partial<Reply> | null): PromptSessionEvent {
  const base = {
    id: 'pevt-1',
    promptSessionId: 'epic-1',
    kind: 'response',
    causedByEventId: null,
    at: '2026-11-16T10:00:00.000Z',
    text: 'Fixed the **relay** contract.',
    notice: 'cross-project-reply',
    ...overrides,
  } as PromptSessionEvent
  if (reply !== null) {
    base.reply = {
      fromCwd: '/home/u/Projects/bilko-run',
      fromEpicId: 'epic-other',
      outcome: 'done',
      referencePaths: [],
      ...reply,
    }
  }
  return base
}

describe('CrossProjectReplyCard', () => {
  it.each([
    ['done', 'done', /sage/],
    ['blocked', 'blocked', /accent/],
    ['question', 'question', /butter/],
  ] as const)('renders the %s outcome chip', (outcome, label, tone) => {
    const el = mount(createElement(CrossProjectReplyCard, { event: event({}, { outcome }) }))
    const card = el.querySelector('[data-testid="cross-project-reply-card"]')!
    expect(card.getAttribute('data-notice')).toBe('cross-project-reply')
    expect(card.textContent).toContain('Reply from bilko-run')
    const chip = el.querySelector('[data-testid="cross-project-reply-outcome"]')!
    expect(chip.textContent).toBe(label)
    expect(chip.className).toMatch(tone)
    expect(el.querySelector('[data-testid="cross-project-reply-text"]')?.innerHTML).toContain('<strong>relay</strong>')
  })

  it('lists the reference paths', () => {
    const el = mount(createElement(CrossProjectReplyCard, {
      event: event({}, { referencePaths: ['src/a.ts', 'docs/b.md'] }),
    }))
    const items = el.querySelectorAll('[data-testid="cross-project-reply-references"] li')
    expect(Array.from(items).map((li) => li.textContent)).toEqual(['src/a.ts', 'docs/b.md'])
  })

  it('omits the reference list when there are none', () => {
    const el = mount(createElement(CrossProjectReplyCard, { event: event({}) }))
    expect(el.querySelector('[data-testid="cross-project-reply-references"]')).toBeNull()
  })

  it('renders the text without crashing when the event has no reply metadata', () => {
    const el = mount(createElement(CrossProjectReplyCard, { event: event({}, null) }))
    const card = el.querySelector('[data-testid="cross-project-reply-card"]')!
    expect(card.textContent).toContain('Reply from another project')
    expect(el.querySelector('[data-testid="cross-project-reply-outcome"]')).toBeNull()
    expect(el.querySelector('[data-testid="cross-project-reply-text"]')?.textContent).toContain('Fixed the relay contract.')
  })
})

describe('CrossProjectReplyReceipt', () => {
  it('renders a one-line receipt carrying the notice', () => {
    const el = mount(createElement(CrossProjectReplyReceipt, {
      event: event({ notice: 'cross-project-reply-sent', text: 'Reply sent to bilko-run.' }),
    }))
    const receipt = el.querySelector('[data-testid="cross-project-reply-receipt"]')!
    expect(receipt.getAttribute('data-notice')).toBe('cross-project-reply-sent')
    expect(receipt.textContent).toContain('Reply sent to bilko-run.')
  })
})
