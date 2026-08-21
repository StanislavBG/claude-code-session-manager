// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { EpicIntakeSection } from '../../../lib/epicIntake'

/**
 * EpicIntakeCard — the Epic's first turn rendered as a structured AIM
 * briefing card from composeEpicIntake's `sections` (epicIntake.ts), a body
 * renderer inside the shared TurnFrame three-zone layout rather than a new
 * frame. Covers: section-kind grouping/order, default expand state per kind,
 * the never-regex-parse-openingPrompt guarantee, and the flat-fallback path
 * EpicDetail takes for an Epic with no `sections` at all.
 */

function installWindowApiMock() {
  const api = {
    transcripts: { readRef: vi.fn(async () => ({ ok: false as const })) },
    clipboard: { writeText: vi.fn(async () => ({ ok: true })) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
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

const FULL_SECTIONS: EpicIntakeSection[] = [
  { kind: 'actor', label: 'Actor', text: 'You are acting as the "debugger" agent: Diagnoses failures.', source: 'debugger' },
  { kind: 'injection', label: 'General behaviour', text: 'Work concisely and verify before claiming done.', source: 'general-behavior' },
  { kind: 'input', label: 'Input', text: 'Grounding: System (CLAUDE.md) · Project (skills)' },
  { kind: 'mission', label: 'Mission', text: 'You are diagnosing a reported bug.', source: 'bug' },
  { kind: 'goal', label: 'Goal', text: 'Goal: Fix the flaky test\n\nThe CI run fails intermittently.' },
  { kind: 'reference', label: 'Reference', text: 'Reference: /tmp/log.txt', source: '/tmp/log.txt' },
  { kind: 'reference', label: 'Reference', text: 'Reference: /tmp/trace.txt', source: '/tmp/trace.txt' },
]

// The wire-identical string a real composeEpicIntake would send — deliberately
// worded differently from any individual section's text so a test asserting
// against it can prove the card is NOT reconstructing its display from this
// string (no regex-parsing of the flat prompt).
const OPENING_PROMPT_STAND_IN = 'THIS-IS-THE-FLAT-OPENING-PROMPT-NEVER-PARSED-FOR-DISPLAY'

describe('EpicIntakeCard', () => {
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

  it('CORE: renders one section card per kind, in the same order composeEpicIntake emits them', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    const cards = Array.from(el.querySelectorAll('[data-testid="epic-intake-section"]'))
    expect(cards.map((c) => c.getAttribute('data-section-kind'))).toEqual([
      'actor',
      'injection',
      'input',
      'mission',
      'goal',
      'reference',
    ])
  })

  it('CORE: actor and mission are expanded by default; injection and input are collapsed to a one-line summary with a count', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    const byKind = (kind: string) => el.querySelector(`[data-section-kind="${kind}"]`)!

    expect(byKind('actor').querySelector('[data-testid="epic-intake-section-body"]')).toBeTruthy()
    expect(byKind('mission').querySelector('[data-testid="epic-intake-section-body"]')).toBeTruthy()

    const injectionCard = byKind('injection')
    expect(injectionCard.querySelector('[data-testid="epic-intake-section-body"]')).toBeFalsy()
    expect(injectionCard.querySelector('[data-testid="epic-intake-section-summary"]')?.textContent).toContain(
      'Work concisely and verify before claiming done.',
    )

    const inputCard = byKind('input')
    expect(inputCard.querySelector('[data-testid="epic-intake-section-body"]')).toBeFalsy()
    expect(inputCard.querySelector('[data-testid="epic-intake-section-summary"]')?.textContent).toContain('Grounding:')
  })

  it('CORE: the reference group collapses two references into one card showing a count, expandable to both', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    const refCard = el.querySelector('[data-section-kind="reference"]')!
    expect(refCard.textContent).toContain('· 2')
    const toggle = refCard.querySelector('[data-testid="epic-intake-section-toggle"]') as HTMLButtonElement
    expect(refCard.querySelector('[data-testid="epic-intake-section-body"]')).toBeFalsy()
    act(() => toggle.click())
    const body = refCard.querySelector('[data-testid="epic-intake-section-body"]')
    expect(body).toBeTruthy()
    expect(body?.textContent).toContain('Reference: /tmp/log.txt')
    expect(body?.textContent).toContain('Reference: /tmp/trace.txt')
  })

  it('EDGE: clicking a collapsed card toggle expands it, and clicking again collapses it', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    const inputToggle = el.querySelector('[data-section-kind="input"] [data-testid="epic-intake-section-toggle"]') as HTMLButtonElement
    act(() => inputToggle.click())
    expect(el.querySelector('[data-section-kind="input"] [data-testid="epic-intake-section-body"]')).toBeTruthy()
    act(() => inputToggle.click())
    expect(el.querySelector('[data-section-kind="input"] [data-testid="epic-intake-section-body"]')).toBeFalsy()
  })

  it('EDGE: a caller passing only the mandatory goal section renders a single card, not an error', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(
      createElement(EpicIntakeCard, {
        sections: [{ kind: 'goal', label: 'Goal', text: 'Fix the thing.' }],
        at: Date.now(),
        openingPrompt: 'Fix the thing.',
      }),
    )
    const cards = el.querySelectorAll('[data-testid="epic-intake-section"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].getAttribute('data-section-kind')).toBe('goal')
  })

  it('CORE: never falls back to prose-parsing openingPrompt — rendered text comes only from `sections`', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    // The flat stand-in string never appears anywhere in the rendered
    // section content — the only place it can legitimately surface is the
    // footer's hidden Copy payload, never in visible section text.
    const sectionsRoot = el.querySelector('[data-testid="epic-intake-card-sections"]')
    expect(sectionsRoot?.textContent).not.toContain(OPENING_PROMPT_STAND_IN)
    // And every visible section body text traces back to a `sections` entry
    // verbatim, not a substring cut out of the flat prompt.
    expect(el.textContent).toContain('You are acting as the "debugger" agent: Diagnoses failures.')
    expect(el.textContent).toContain('You are diagnosing a reported bug.')
  })

  it('CORE: the footer Copy button copies the exact openingPrompt, not a section', async () => {
    const api = installWindowApiMock()
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    const copyBtn = el.querySelector('[data-testid="turn-raw-footer-copy"]') as HTMLButtonElement
    expect(copyBtn).toBeTruthy()
    await act(async () => {
      copyBtn.click()
      await Promise.resolve()
    })
    expect(api.clipboard.writeText).toHaveBeenCalledWith(OPENING_PROMPT_STAND_IN)
  })

  it('CORE: renders inside the shared TurnFrame — a header badge + timestamp zone', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    expect(el.querySelector('[data-testid="turn-frame-header"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="epic-intake-badge"]')?.textContent).toBe('AIM briefing')
  })
  it('CORE: a multi-thousand-word Goal collapses to a thin one-line summary instead of rendering in full', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const huge = `Rewrite the importer. ${'word '.repeat(2000)}`
    const el = mount(
      createElement(EpicIntakeCard, {
        sections: [{ kind: 'goal', label: 'Goal', text: huge }],
        at: Date.now(),
        openingPrompt: huge,
      }),
    )
    // Collapsed: summary line present, body absent — despite goal's
    // DEFAULT_EXPANDED being true for a short goal.
    expect(el.querySelector('[data-testid="epic-intake-section-body"]')).toBeNull()
    const summary = el.querySelector('[data-testid="epic-intake-section-summary"]')!
    expect(summary.textContent!.length).toBeLessThan(120)
    expect(summary.textContent).toContain('Rewrite the importer.')
  })

  it('CORE: expanding a long Goal bounds its height rather than growing the page without limit', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const huge = `Rewrite the importer. ${'word '.repeat(2000)}`
    const el = mount(
      createElement(EpicIntakeCard, {
        sections: [{ kind: 'goal', label: 'Goal', text: huge }],
        at: Date.now(),
        openingPrompt: huge,
      }),
    )
    const toggle = el.querySelector('[data-testid="epic-intake-section-toggle"]') as HTMLButtonElement
    act(() => toggle.click())
    const body = el.querySelector('[data-testid="epic-intake-section-body"]')!
    expect(body.textContent).toContain('Rewrite the importer.')
    expect(body.className).toContain('overflow-y-auto')
  })

  it('EDGE: a SHORT goal still opens by default — the collapse is length-driven, not kind-driven', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(
      createElement(EpicIntakeCard, {
        sections: [{ kind: 'goal', label: 'Goal', text: 'Fix the thing.' }],
        at: Date.now(),
        openingPrompt: 'Fix the thing.',
      }),
    )
    const body = el.querySelector('[data-testid="epic-intake-section-body"]')!
    expect(body.textContent).toContain('Fix the thing.')
    expect(body.className).not.toContain('overflow-y-auto')
  })
})
