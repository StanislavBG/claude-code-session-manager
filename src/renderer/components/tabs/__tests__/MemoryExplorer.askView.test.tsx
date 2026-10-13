// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../../VoiceButton', () => ({ VoiceButton: () => null }))

import { AskView } from '../memory/explorer/AskView'
import type { MemoryRow } from '../memory/explorer/model'

let container: HTMLDivElement | null = null
let root: Root | null = null

const mk = (slug: string, stale: boolean, ageDays: number): MemoryRow => ({
  name: `${slug}.md`, slug, path: `/m/${slug}.md`, description: '', bytes: 1, mtimeMs: 0, ageDays,
  stale, staleReasons: [], ageOnlyStale: false, deadRefs: [], broken: false, danglingLinks: [],
  outLinks: [], inLinks: [], notIndexed: false, clusterId: null, type: null, originSessionId: null,
})
const rows = [mk('fresh_a', false, 3), mk('old_b', true, 40)]

function mount(over: Record<string, unknown> = {}) {
  const p = {
    rows, context: null, onClearContext: vi.fn(), onOpen: vi.fn(), onReverify: vi.fn(), onDraft: vi.fn(),
    onAsk: vi.fn().mockResolvedValue({ ok: true, answer: 'It is so.', citations: ['fresh_a', 'old_b'] }),
    ...over,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(createElement(AskView, p as never)) })
  return p
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = (el: HTMLElement | null) => act(() => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const type = (v: string) => act(() => {
  const el = q('mx-ask-input') as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const send = async () => { await act(async () => { click(q('mx-ask-send')) }) }

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('AskView', () => {
  it('remember path makes no onAsk call and shows a draft', async () => {
    const p = mount()
    type('Remember tests use vitest')
    await send()
    expect(p.onAsk).not.toHaveBeenCalled()
    expect(q('mx-ask-draft')!.textContent).toBe('DRAFT MEMORY · NOT SAVED YET')
    expect(container!.textContent).toContain('Tests use vitest')
    click([...container!.querySelectorAll('button')].find((b) => b.textContent === 'Review draft') as HTMLElement)
    expect(p.onDraft).toHaveBeenCalledWith('Tests use vitest')
  })

  it('renders answer, citations and stale notice; citation opens', async () => {
    const p = mount()
    type('why?')
    await send()
    expect(p.onAsk).toHaveBeenCalledWith('why?', null)
    expect(container!.textContent).toContain('It is so.')
    expect(q('mx-ask-cite-old_b')!.textContent).toContain('40d')
    expect(q('mx-ask-cite-old_b')!.textContent).toContain('STALE')
    expect(q('mx-ask-cite-fresh_a')!.textContent).not.toContain('STALE')
    expect(container!.textContent).toContain('1 of these is flagged stale. Re-verify against the current code?')
    click(q('mx-ask-cite-fresh_a'))
    expect(p.onOpen).toHaveBeenCalledWith('fresh_a.md')
    click([...container!.querySelectorAll('button')].find((b) => b.textContent === 'Re-verify') as HTMLElement)
    expect(p.onReverify).toHaveBeenCalled()
  })

  it('chips fill the composer without sending; empty sends nothing', async () => {
    const p = mount()
    await send()
    expect(p.onAsk).not.toHaveBeenCalled()
    click([...container!.querySelectorAll('button')].find((b) => b.textContent === 'Find contradictions') as HTMLElement)
    expect((q('mx-ask-input') as HTMLInputElement).value).toBe('Find contradictions')
    expect(p.onAsk).not.toHaveBeenCalled()
  })

  it('context chip × clears context and uses context chips', () => {
    const p = mount({ context: 'old_b' })
    expect(q('mx-ask-context')!.textContent).toContain('old_b')
    expect(container!.textContent).toContain('Is this still accurate?')
    click(q('mx-ask-context')!.querySelector('button'))
    expect(p.onClearContext).toHaveBeenCalled()
  })

  it('failed result keeps input and clears pending', async () => {
    const p = mount({ onAsk: vi.fn().mockResolvedValue(null) })
    type('hello')
    await send()
    expect((q('mx-ask-input') as HTMLInputElement).value).toBe('hello')
    expect((q('mx-ask-send') as HTMLButtonElement).disabled).toBe(false)
    expect(container!.textContent).not.toContain('Thinking…')
    expect(p.onAsk).toHaveBeenCalledTimes(1)
  })
})
