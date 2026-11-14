// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import { BuildResultCard } from '../BuildResultCard'
import type { PromptSessionEvent } from '../../../state/promptSessions'

/** PRD 3119 — the DONE / FAILED card a macro background build's finish notice renders as. */

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
  vi.restoreAllMocks()
})

function event(overrides: Partial<PromptSessionEvent>): PromptSessionEvent {
  return {
    id: 'pevt-1',
    promptSessionId: 'epic-1',
    kind: 'response',
    causedByEventId: null,
    at: '2026-11-14T23:00:00.000Z',
    text: 'DONE — Demo Video: “Tour” is saved (30 s · warm). Watch it in Project Home ▸ Videos.',
    prdSlug: '3200-demo-video',
    notice: 'build-done',
    buildOutput: { kind: 'video', id: 'tour', title: 'Tour' },
    ...overrides,
  } as PromptSessionEvent
}

function stubTranscript(turns: unknown[]) {
  const read = vi.fn().mockResolvedValue({ turns })
  ;(window as unknown as { api: unknown }).api = { promptSessionTranscript: { read } }
  return read
}

describe('BuildResultCard', () => {
  it('renders a DONE card with the event text and an Open in Project Home button', () => {
    stubTranscript([])
    const el = mount(createElement(BuildResultCard, { event: event({}), cwd: '/p', epicId: 'epic-1', onOpenProjectHome: vi.fn() }))
    const card = el.querySelector('[data-testid="epic-build-result-card"]')!
    expect(card.getAttribute('data-notice')).toBe('build-done')
    expect(card.getAttribute('role')).toBeNull()
    expect(card.className).toMatch(/accent/)
    expect(el.querySelector('[data-testid="epic-build-result-marker"]')?.textContent).toContain('DONE')
    expect(el.querySelector('[data-testid="epic-build-result-text"]')?.textContent).toContain('“Tour” is saved')
    expect(el.querySelector('[data-testid="epic-build-result-open"]')?.textContent).toContain('Open in Project Home')
  })

  it('renders a FAILED card (red, role=alert) with the event text and no open button', () => {
    stubTranscript([])
    const el = mount(createElement(BuildResultCard, {
      event: event({ notice: 'build-failed', buildOutput: undefined, text: 'FAILED — Demo Video: the background build failed (timeout). Press it again in Project Home to retry.' }),
      cwd: '/p',
      epicId: 'epic-1',
      onOpenProjectHome: vi.fn(),
    }))
    const card = el.querySelector('[data-testid="epic-build-result-card"]')!
    expect(card.getAttribute('role')).toBe('alert')
    expect(card.getAttribute('data-notice')).toBe('build-failed')
    expect(card.className).toMatch(/red/)
    expect(el.querySelector('[data-testid="epic-build-result-marker"]')?.textContent).toContain('FAILED')
    expect(el.querySelector('[data-testid="epic-build-result-text"]')?.textContent).toContain('(timeout)')
    expect(el.querySelector('[data-testid="epic-build-result-open"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-build-result-report-toggle"]')).toBeNull()
  })

  it('Open in Project Home calls onOpenProjectHome with the cwd and buildOutput', () => {
    stubTranscript([])
    const onOpen = vi.fn()
    const el = mount(createElement(BuildResultCard, { event: event({}), cwd: '/p', epicId: 'epic-1', onOpenProjectHome: onOpen }))
    act(() => (el.querySelector('[data-testid="epic-build-result-open"]') as HTMLButtonElement).click())
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('/p', { kind: 'video', id: 'tour', title: 'Tour' })
  })

  it("the collapsed report toggle shows the builder's prd-result turn read from the transcript", async () => {
    const read = stubTranscript([
      { v: 1, epicId: 'epic-1', eventId: 'prd-result:9999-other:r1', role: 'assistant', at: '2026-11-14T22:00:00.000Z', text: 'wrong report' },
      { v: 1, epicId: 'epic-1', eventId: null, role: 'assistant', at: '2026-11-14T23:00:00.000Z', text: 'closest but untagged' },
      { v: 1, epicId: 'epic-1', eventId: 'prd-result:3200-demo-video:run-7', role: 'assistant', at: '2026-11-14T22:59:00.000Z', text: 'Built the **tour** video.' },
    ])
    const el = mount(createElement(BuildResultCard, { event: event({}), cwd: '/p', epicId: 'epic-1', onOpenProjectHome: vi.fn() }))
    const toggle = el.querySelector('[data-testid="epic-build-result-report-toggle"]') as HTMLButtonElement
    expect(toggle.textContent).toContain("Show the builder's report")
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector('[data-testid="epic-build-result-report"]')).toBeNull()
    expect(read).not.toHaveBeenCalled()

    act(() => toggle.click())
    await flushAsync()
    expect(read).toHaveBeenCalledWith('/p', 'epic-1')
    const report = el.querySelector('[data-testid="epic-build-result-report"]')!
    expect(report.textContent).toContain('Built the tour video.')
    expect(report.textContent).not.toContain('wrong report')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    act(() => toggle.click())
    expect(el.querySelector('[data-testid="epic-build-result-report"]')).toBeNull()
  })

  it('omits the report toggle when the event names no PRD slug', () => {
    stubTranscript([])
    const el = mount(createElement(BuildResultCard, { event: event({ prdSlug: undefined }), cwd: '/p', epicId: 'epic-1', onOpenProjectHome: vi.fn() }))
    expect(el.querySelector('[data-testid="epic-build-result-report-toggle"]')).toBeNull()
  })
})
