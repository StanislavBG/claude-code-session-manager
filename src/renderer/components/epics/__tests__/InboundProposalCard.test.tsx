// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach } from 'vitest'
import type { PromptSession } from '../../../state/promptSessions'
import { inboundSeriesSiblings } from '../../../lib/epicOrigin'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root && container) {
    act(() => root!.unmount())
    container.remove()
  }
  container = null
  root = null
})

const PROPOSAL = {
  motivation: 'Contract drift between A and B.',
  originAsk: 'wiring the D2D flow',
  plan: ['Step one', 'Step two'],
  acceptanceCriteria: ['AC one', 'AC two'],
  outOfScope: ['Not this'],
  series: { key: 'k', title: 'Series T', index: 2, total: 3 },
}

function epic(over: Record<string, unknown> = {}, proposal: unknown = PROPOSAL): PromptSession {
  return {
    id: 'e2',
    status: 'proposed',
    goalText: 'Title two',
    openingPrompt: 'FULL OPENING PROMPT BODY',
    source: { producer: 'cross-project-feedback', fromCwd: '/home/u/Projects/sender', proposal },
    ...over,
  } as unknown as PromptSession
}

async function mount(e: PromptSession, siblings: ReturnType<typeof inboundSeriesSiblings> = []) {
  const { InboundProposalCard } = await import('../epic-primitives')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(InboundProposalCard, { epic: e, siblings })))
  return container
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`)

describe('InboundProposalCard', () => {
  it('renders nothing for a non-inbound Epic', async () => {
    const el = await mount({ id: 'x', status: 'proposed', goalText: 't' } as unknown as PromptSession)
    expect(q(el, 'inbound-proposal-card')).toBeNull()
  })

  it('renders every section in order', async () => {
    const el = await mount(epic())
    const ids = ['from', 'series', 'why', 'plan', 'criteria', 'out-of-scope'].map((s) => `inbound-proposal-${s}`)
    const nodes = ids.map((id) => q(el, id))
    nodes.forEach((n) => expect(n).not.toBeNull())
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const from = q(el, 'inbound-proposal-from')!
    expect(from.textContent).toContain('sender')
    expect(from.textContent).toContain('raised while working on wiring the D2D flow')
    expect(from.querySelector('[title="/home/u/Projects/sender"]')).not.toBeNull()
    expect(q(el, 'inbound-proposal-series')!.textContent).toBe('Part 2 of 3 · Series T')
    expect(q(el, 'inbound-proposal-why')!.textContent).toContain('Contract drift')
    expect(q(el, 'inbound-proposal-plan')!.querySelectorAll('ol > li').length).toBe(2)
    expect(q(el, 'inbound-proposal-criteria')!.querySelectorAll('li').length).toBe(2)
  })

  it('hides out-of-scope when empty', async () => {
    const el = await mount(epic({}, { ...PROPOSAL, outOfScope: [] }))
    expect(q(el, 'inbound-proposal-out-of-scope')).toBeNull()
  })

  it('renders the siblings strip for a series', async () => {
    const sibs = [
      { id: 'e1', index: 1, status: 'active', goalText: 'Title one' },
      { id: 'e2', index: 2, status: 'proposed', goalText: 'Title two' },
    ] as ReturnType<typeof inboundSeriesSiblings>
    const el = await mount(epic(), sibs)
    const strip = q(el, 'inbound-proposal-siblings')!
    expect(strip.textContent).toContain('1/3 Title one active')
    expect(strip.textContent).toContain('2/3 Title two proposed')
    expect(strip.querySelectorAll('[aria-current="true"]').length).toBe(1)
  })

  it('omits the siblings strip for a single sibling', async () => {
    const el = await mount(epic(), [{ id: 'e2', index: 2, status: 'proposed', goalText: 'x' }])
    expect(q(el, 'inbound-proposal-siblings')).toBeNull()
  })

  it('legacy: shows the report text from sections, else openingPrompt', async () => {
    const withSections = await mount(
      epic({ sections: [{ kind: 'goal', label: 'Goal', text: 'SECTION GOAL TEXT' }] }, null),
    )
    expect(q(withSections, 'inbound-proposal-from')).not.toBeNull()
    expect(q(withSections, 'inbound-proposal-why')).toBeNull()
    expect(q(withSections, 'inbound-proposal-report')!.textContent).toBe('SECTION GOAL TEXT')
    act(() => root!.unmount())
    container!.remove()
    const el = await mount(epic({}, null))
    expect(q(el, 'inbound-proposal-report')!.textContent).toBe('FULL OPENING PROMPT BODY')
  })
})
