// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { AgentRoster, sortRoster } from '../AgentRoster'
import type { AgentPersona } from '../../../../../preload/api'

const mk = (name: string, loadout?: string): AgentPersona =>
  ({
    name, description: `${name} desc`, tools: ['Read'], model: 'opus', effort: 'high', color: 'red',
    tags: [], projects: [], action: null, actionLabel: null, path: `/x/${name}.md`, body: '',
    overridingProjects: [], overrideDetails: [], ...(loadout ? { loadout } : {}),
  }) as AgentPersona

let container: HTMLDivElement
let root: Root
const onOpen = vi.fn()

async function mount(personas: AgentPersona[]) {
  ;(window as unknown as { api: unknown }).api = { agents: { armory: vi.fn().mockResolvedValue({ mcpServers: [] }) } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(AgentRoster, { personas, filter: '', onFilterChange: () => {}, onOpen, onNew: () => {}, view: 'personas', onView: () => {} }))
    await Promise.resolve()
  })
}
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click() })
const names = () => [...container.querySelectorAll('[data-testid="agent-card"]')].map((c) => c.getAttribute('data-agent-row'))

beforeEach(() => onOpen.mockClear())
afterEach(() => { act(() => root.unmount()); container.remove(); delete (window as unknown as { api?: unknown }).api })

const SET = [mk('zed', 'equipped'), mk('amy', 'bare'), mk('mid', 'undecided'), mk('bob', 'unbound'), mk('ann', 'undecided'), mk('eve', 'equipped')]

describe('AgentRoster', () => {
  it('chips carry counts and filter the cards', async () => {
    await mount(SET)
    const chip = (k: string) => container.querySelector(`[data-testid="roster-chip-${k}"]`)!
    expect(chip('all').textContent).toContain('6')
    expect(chip('undecided').textContent).toContain('2')
    expect(chip('equipped').textContent).toContain('2')
    expect(chip('bare').textContent).toContain('1')
    expect(chip('unbound').textContent).toContain('1')
    await click(chip('equipped'))
    expect(names()).toEqual(['eve', 'zed'])
    await click(chip('all'))
    expect(names()).toHaveLength(6)
  })

  it('banner shows for undecided agents and Review filters to them; hidden at 0', async () => {
    await mount(SET)
    expect(container.querySelector('[data-testid="roster-banner"]')!.textContent).toContain('2 agents have no loadout decision')
    await click(container.querySelector('[data-testid="roster-review"]'))
    expect(names()).toEqual(['ann', 'mid'])
    act(() => root.unmount()); container.remove()
    await mount([mk('a', 'equipped'), mk('b', 'bare')])
    expect(container.querySelector('[data-testid="roster-banner"]')).toBeNull()
  })

  it('sorts Undecided → Unbound → Equipped → Bare, then by name; unbound gets the hatch', async () => {
    expect(sortRoster(SET).map((p) => p.name)).toEqual(['ann', 'mid', 'bob', 'eve', 'zed', 'amy'])
    await mount(SET)
    expect(names()).toEqual(['ann', 'mid', 'bob', 'eve', 'zed', 'amy'])
    expect(container.querySelectorAll('[data-testid="agent-card-hatch"]')).toHaveLength(1)
  })

  it('override footer names the project and keys; undecided cards offer a loadout', async () => {
    const o = { ...mk('olly', 'equipped'), overridingProjects: ['Self'], overrideDetails: [{ project: 'Self', cwd: '/s', fields: ['model', 'tools'], bodyOverridden: false, issue: null }] } as AgentPersona
    await mount([o, mk('u', 'undecided')])
    expect(container.querySelector('[data-agent-row="olly"] [data-testid="agent-card-note"]')!.textContent).toBe('Overridden in Self — model, gear')
    expect(container.querySelector('[data-agent-row="u"]')!.textContent).toContain('Choose a loadout →')
  })

  it('arrow keys move focus and Enter opens the focused card', async () => {
    await mount(SET)
    const cards = [...container.querySelectorAll<HTMLElement>('[data-testid="agent-card"]')]
    cards[0].focus()
    await act(async () => { cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(document.activeElement).toBe(cards[1])
    await act(async () => { cards[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpen).toHaveBeenCalledWith('mid')
    await click(cards[2])
    expect(onOpen).toHaveBeenLastCalledWith('bob')
  })
})
