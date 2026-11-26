// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LoadoutFirstRun, showsFirstRun } from '../LoadoutFirstRun'
import { BLANK_DRAFT, type Draft } from '../AgentDetail'

let container: HTMLDivElement
let root: Root
let latest: Draft
const armory = vi.fn()
const listPersonas = vi.fn()

async function mount() {
  ;(window as unknown as { api: unknown }).api = { agents: { armory, listPersonas } }
  listPersonas.mockResolvedValue([{ name: 'dev-lead', tools: ['Edit', 'mcp__sm__x'] }])
  armory.mockResolvedValue({ builtins: [{ id: 'Edit', label: 'Edit', badges: [] }], bundledSkills: [], mcpServers: [], packs: [], unpackedSkills: [], errors: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const Host = () => {
    const [d, setD] = useState<Draft>({ ...BLANK_DRAFT, name: 'builder', tools: [] })
    const [picking, setPicking] = useState(false)
    const [dismissed, setDismissed] = useState(false)
    latest = d
    if (!showsFirstRun(true, d, [], picking, dismissed)) return null
    return createElement(LoadoutFirstRun, { obj: d, set: (p: Partial<Draft>) => setD((x) => ({ ...x, ...p })), picking, setPicking, onDismiss: () => setDismissed(true) })
  }
  await act(async () => { root.render(createElement(Host)); await Promise.resolve() })
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('LoadoutFirstRun', () => {
  it('shows the three choices', async () => {
    await mount()
    expect(q('[data-testid="agent-undecided-choice"]')).toBeTruthy()
    expect(q('[data-testid="agent-choose-bare"]')).toBeTruthy()
    expect(q('[data-testid="agent-choose-pick"]')).toBeTruthy()
    expect(q('[data-testid="agent-choose-unbound"]')).toBeTruthy()
  })

  it('lists where the agent runs and seeds the draft from another persona', async () => {
    await mount()
    expect(q('[data-testid="agent-runs-today"]')!.textContent).toMatch(/Epic chat.*Scheduler jobs.*Tasks/)
    expect(q('[data-choice="pick"]')!.textContent).toContain('RECOMMENDED')
    const sel = q('[data-testid="agent-start-from"]') as HTMLSelectElement
    await act(async () => { sel.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await Promise.resolve() })
    await act(async () => { sel.value = 'dev-lead'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(latest.tools).toEqual(['Edit', 'mcp__sm__x'])
    expect(latest.loadout).toBe('equipped')
  })

  it('Bare sets the bare encoding and the view disappears', async () => {
    await mount()
    await act(async () => { q('[data-testid="agent-choose-bare"]')!.click() })
    expect(latest.loadout).toBe('bare')
    expect(latest.tools).toEqual([])
    expect(q('[data-testid="agent-undecided-choice"]')).toBeNull()
  })

  it('Unbound sets tools to * and the view disappears', async () => {
    await mount()
    await act(async () => { q('[data-testid="agent-choose-unbound"]')!.click() })
    expect(latest.loadout).toBe('unbound')
    expect(latest.tools).toEqual(['*'])
    expect(q('[data-testid="agent-undecided-choice"]')).toBeNull()
  })

  it('Pick gear opens the Armory empty; equipping decides the draft', async () => {
    await mount()
    await act(async () => { q('[data-testid="agent-choose-pick"]')!.click(); await Promise.resolve() })
    expect(q('[data-testid="agent-armory"]')).toBeTruthy()
    expect(q('[data-equipped="true"]')).toBeNull()
    expect(latest.loadout).toBeUndefined()
    await act(async () => { (q('[data-item="Edit"] button') as HTMLElement).click() })
    expect(latest.tools).toEqual(['Edit'])
    expect(latest.loadout).toBe('equipped')
  })
})
