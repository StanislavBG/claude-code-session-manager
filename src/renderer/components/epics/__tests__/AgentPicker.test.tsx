// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentPicker } from '../AgentPicker'
import type { AgentPersona } from '../../../../preload/api'

function makeAgent(overrides: Partial<AgentPersona>): AgentPersona {
  return {
    name: 'architect',
    description: null,
    tools: [],
    model: null,
    effort: null,
    color: null,
    tags: [],
    projects: [],
    action: null,
    actionLabel: null,
    title: null,
    seedVersion: null,
    path: '/fake/architect.md',
    body: '',
    overridingProjects: [],
    ...overrides,
  }
}

const AGENTS: AgentPersona[] = [
  makeAgent({ name: 'architect', title: 'Engineering — Architect' }),
  makeAgent({ name: 'builder', title: 'Engineering — Builder' }),
  makeAgent({ name: 'designer', title: 'Design — Designer' }),
]

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  if (container) container.remove()
  root = null
  container = null
})

describe('AgentPicker', () => {
  it('groups options by department', () => {
    const el = mount(<AgentPicker agents={AGENTS} value="architect" onChange={() => {}} />)
    const select = el.querySelector('[data-testid="new-epic-agent-select"]') as HTMLSelectElement
    const groups = Array.from(select.querySelectorAll('optgroup'))
    expect(groups.map((g) => g.label)).toEqual(['Engineering', 'Design'])
    expect(groups[0].querySelectorAll('option')).toHaveLength(2)
    expect(groups[1].querySelectorAll('option')).toHaveLength(1)
  })

  it('marks the selected option data-selected=true', () => {
    const el = mount(<AgentPicker agents={AGENTS} value="builder" onChange={() => {}} />)
    const builderOpt = el.querySelector('[data-testid="new-epic-agent-builder"]') as HTMLOptionElement
    const architectOpt = el.querySelector('[data-testid="new-epic-agent-architect"]') as HTMLOptionElement
    expect(builderOpt.getAttribute('data-selected')).toBe('true')
    expect(architectOpt.getAttribute('data-selected')).toBe('false')
  })

  it('calls onChange with the picked name on change', () => {
    let picked: string | null = null
    const el = mount(<AgentPicker agents={AGENTS} value="architect" onChange={(name) => (picked = name)} />)
    const select = el.querySelector('[data-testid="new-epic-agent-select"]') as HTMLSelectElement
    act(() => {
      select.value = 'designer'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(picked).toBe('designer')
  })

  it('renders an empty-library state with a disabled select', () => {
    const el = mount(<AgentPicker agents={[]} value="" onChange={() => {}} />)
    expect(el.textContent).toContain('No agents in library')
    const select = el.querySelector('[data-testid="new-epic-agent-select"]') as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })
})
