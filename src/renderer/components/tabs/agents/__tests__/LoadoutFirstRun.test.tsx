// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LoadoutFirstRun } from '../LoadoutFirstRun'
import { BLANK_DRAFT, type Draft } from '../AgentDetail'

let container: HTMLDivElement
let root: Root
let latest: Draft
const armory = vi.fn()

async function mount() {
  ;(window as unknown as { api: unknown }).api = { agents: { armory } }
  armory.mockResolvedValue({ builtins: [{ id: 'Edit', label: 'Edit', badges: [] }], bundledSkills: [], mcpServers: [], packs: [], unpackedSkills: [], errors: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const Host = () => {
    const [d, setD] = useState<Draft>({ ...BLANK_DRAFT, tools: [] })
    latest = d
    return createElement(LoadoutFirstRun, { obj: d, savedTools: [], set: (p: Partial<Draft>) => setD((x) => ({ ...x, ...p })) })
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
