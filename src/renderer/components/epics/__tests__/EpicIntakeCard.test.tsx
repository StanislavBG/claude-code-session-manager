// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { EpicIntakeSection } from '../../../lib/epicIntake'

/**
 * EpicIntakeCard — the Epic's first turn rendered as a compact "Launch
 * briefing" card from composeEpicIntake's `sections` (epicIntake.ts).
 * Collapsed by default (header + chips only); Show or a chip reveals the
 * section bodies. Covers: badge/subtitle/count text, default-collapsed
 * state, chip-click expansion, and the never-regex-parse-openingPrompt
 * guarantee.
 */

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
  { kind: 'actor', part: 'persona', label: 'Actor', text: 'You are acting as the "debugger" agent: Diagnoses failures.', source: 'debugger' },
  { kind: 'input', part: 'grounding', label: 'Grounding', text: 'Grounding: System (CLAUDE.md) · Project (skills)' },
  { kind: 'input', part: 'injection', label: 'General behaviour', text: 'Work concisely and verify before claiming done.', source: 'general-behavior' },
  { kind: 'mission', part: 'job-type', label: 'Job type', text: 'You are diagnosing a reported bug.', source: 'bug' },
  { kind: 'mission', part: 'goal', label: 'Goal', text: 'Goal: Fix the flaky test\n\nThe CI run fails intermittently.' },
  { kind: 'input', part: 'reference', label: 'Reference', text: 'Reference: /tmp/log.txt', source: '/tmp/log.txt' },
  { kind: 'input', part: 'reference', label: 'Reference', text: 'Reference: /tmp/trace.txt', source: '/tmp/trace.txt' },
]

// The wire-identical string a real composeEpicIntake would send — deliberately
// worded differently from any individual section's text so a test asserting
// against it can prove the card is NOT reconstructing its display from this
// string (no regex-parsing of the flat prompt).
const OPENING_PROMPT_STAND_IN = 'THIS-IS-THE-FLAT-OPENING-PROMPT-NEVER-PARSED-FOR-DISPLAY'

describe('EpicIntakeCard', () => {
  beforeEach(() => {})
  afterEach(() => {
    if (root && container) {
      act(() => root!.unmount())
      container.remove()
    }
    container = null
    root = null
  })

  it('CORE: renders the Launch briefing badge, subtitle, and section/token count', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))

    expect(el.querySelector('[data-testid="epic-intake-badge"]')?.textContent).toBe('Launch briefing')
    expect(el.textContent).toContain('Sent to the agent at start — not part of the conversation')

    // 3 AIM slots: actor, input, mission.
    const expectedTokens = Math.ceil(OPENING_PROMPT_STAND_IN.length / 4)
    expect(el.textContent).toContain(`3 sections · ${expectedTokens.toLocaleString()} tok`)
  })

  it('CORE: the 8-entry legacy fixture yields exactly 3 chips in AIM order; an AIM-shaped fixture yields the same', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const legacy: EpicIntakeSection[] = [
      ...FULL_SECTIONS.slice(0, 1),
      { kind: 'persona-body', label: 'Persona notes', text: 'Be terse.' },
      { kind: 'injection', label: 'General behaviour', text: 'Work concisely.', source: 'general-behavior' },
      ...FULL_SECTIONS.slice(1, 6),
    ]
    expect(legacy).toHaveLength(8)
    const el = mount(createElement(EpicIntakeCard, { sections: legacy, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    const chips = Array.from(el.querySelectorAll('[data-testid="epic-intake-chip"]'))
    expect(chips.map((c) => c.getAttribute('data-chip-kind'))).toEqual(['actor', 'input', 'mission'])
    expect(chips.map((c) => c.textContent)).toEqual(['Actor', 'Input', 'Mission'])
    act(() => (el.querySelector('[data-testid="epic-intake-toggle"]') as HTMLButtonElement).click())
    const actor = el.querySelector('[data-section-kind="actor"]')!
    expect(actor.textContent).toContain('Be terse.')
    expect(actor.textContent).toContain('Persona')
    act(() => (el.querySelector('[data-chip-kind="input"]') as HTMLButtonElement).click())
    const input = el.querySelector('[data-section-kind="input"]')!
    expect(input.textContent).toContain('General behaviour · general-behavior')
    expect(input.textContent).toContain('Reference · /tmp/log.txt')

    act(() => root!.unmount())
    container!.remove()
    const aim: EpicIntakeSection[] = [
      { kind: 'actor', part: 'persona', label: 'Actor', text: 'You are X' },
      { kind: 'input', part: 'grounding', label: 'Input', text: 'Grounding' },
      { kind: 'mission', part: 'goal', label: 'Goal', text: 'Fix it' },
    ]
    const el2 = mount(createElement(EpicIntakeCard, { sections: aim, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    expect(Array.from(el2.querySelectorAll('[data-testid="epic-intake-chip"]')).map((c) => c.getAttribute('data-chip-kind'))).toEqual(['actor', 'input', 'mission'])
  })

  it('CORE: collapsed by default — no section body or chip-triggered content renders until Show or a chip is clicked', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))

    expect(el.querySelector('[data-testid="epic-intake-section"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-intake-section-body"]')).toBeNull()
    expect(el.querySelector('[data-testid="epic-intake-toggle"]')?.textContent).toBe('Show ▾')
  })

  it('CORE: clicking Show reveals every section group and flips the toggle to Hide', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    const toggle = el.querySelector('[data-testid="epic-intake-toggle"]') as HTMLButtonElement
    act(() => toggle.click())

    expect(toggle.textContent).toBe('Hide ▴')
    const cards = Array.from(el.querySelectorAll('[data-testid="epic-intake-section"]'))
    expect(cards.map((c) => c.getAttribute('data-section-kind'))).toEqual([
      'actor',
      'input',
      'mission',
    ])
  })

  it('CORE: clicking a chip expands the card and opens that section specifically', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))

    const injectionChip = el.querySelector('[data-chip-kind="input"]') as HTMLButtonElement
    await act(async () => {
      injectionChip.click()
      await Promise.resolve()
    })

    const injectionSection = el.querySelector('[data-section-kind="input"]')!
    expect(injectionSection.querySelector('[data-testid="epic-intake-section-body"]')).toBeTruthy()
    expect(injectionSection.textContent).toContain('Work concisely and verify before claiming done.')
  })

  it('EDGE: a caller passing only the mandatory goal section renders a single chip, not an error', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(
      createElement(EpicIntakeCard, {
        sections: [{ kind: 'goal', label: 'Goal', text: 'Fix the thing.' }],
        at: Date.now(),
        openingPrompt: 'Fix the thing.',
      }),
    )
    const chips = el.querySelectorAll('[data-testid="epic-intake-chip"]')
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toBe('Mission')
  })

  it('CORE: never falls back to prose-parsing openingPrompt — rendered text comes only from `sections`', async () => {
    const { EpicIntakeCard } = await import('../EpicIntakeCard')
    const el = mount(createElement(EpicIntakeCard, { sections: FULL_SECTIONS, at: Date.now(), openingPrompt: OPENING_PROMPT_STAND_IN }))
    expect(el.textContent).not.toContain(OPENING_PROMPT_STAND_IN)

    const toggle = el.querySelector('[data-testid="epic-intake-toggle"]') as HTMLButtonElement
    act(() => toggle.click())
    expect(el.textContent).toContain('You are acting as the "debugger" agent: Diagnoses failures.')
    expect(el.textContent).toContain('You are diagnosing a reported bug.')
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
    const toggle = el.querySelector('[data-testid="epic-intake-toggle"]') as HTMLButtonElement
    act(() => toggle.click())

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
    act(() => (el.querySelector('[data-testid="epic-intake-toggle"]') as HTMLButtonElement).click())
    const sectionToggle = el.querySelector('[data-testid="epic-intake-section-toggle"]') as HTMLButtonElement
    act(() => sectionToggle.click())
    const body = el.querySelector('[data-testid="epic-intake-section-body"]')!
    expect(body.textContent).toContain('Rewrite the importer.')
    expect(body.className).toContain('overflow-y-auto')
  })
})
