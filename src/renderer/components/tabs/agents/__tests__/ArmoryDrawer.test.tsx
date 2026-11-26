// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GearPanel } from '../GearPanel'
import { BLANK_DRAFT, type Draft } from '../AgentDetail'

const item = (id: string, badges: Array<'risky' | 'banned' | 'floor'> = []) => ({ id, label: id, badges })
const ARMORY = {
  builtins: [item('Read', ['floor']), item('Bash', ['risky']), item('Edit')],
  bundledSkills: [],
  mcpServers: [{ ...item('blender'), status: 'checked', scope: 'user', tools: [item('mcp__blender__a')] }],
  packs: [{ ...item('dev'), skills: ['develop'], source: 'plugin' }],
  unpackedSkills: ['pdf', 'docx'],
  errors: [],
}

let container: HTMLDivElement
let root: Root
let latest: Draft
const armory = vi.fn()

async function mount(initial: Partial<Draft>) {
  armory.mockResolvedValue(ARMORY)
  ;(window as unknown as { api: unknown }).api = { agents: { armory, onChanged: () => () => {} } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const Host = () => {
    const [d, setD] = useState<Draft>({ ...BLANK_DRAFT, ...initial })
    latest = d
    return createElement(GearPanel, { obj: d, set: (p: Partial<Draft>) => setD((x) => ({ ...x, ...p })) })
  }
  await act(async () => { root.render(createElement(Host)); await Promise.resolve() })
  await act(async () => { (container.querySelector('[data-testid="agent-open-armory"]') as HTMLElement).click() })
}
const q = (sel: string) => document.querySelector(sel) as HTMLElement
const item$ = (id: string) => q(`[data-testid="armory-item"][data-item="${id}"]`)
const fire = (el: Element, type: string) => act(async () => { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })) })
afterEach(() => { act(() => root.unmount()); container.remove(); armory.mockReset() })

describe('ArmoryDrawer', () => {
  it('searches across kinds', async () => {
    await mount({ tools: ['Edit'] })
    expect(item$('blender')).toBeTruthy()
    const input = q('[data-testid="armory-search"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'bash')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(item$('Bash')).toBeTruthy()
    expect(item$('blender')).toBeNull()
  })

  it('Equip button equips and marks the item on sheet', async () => {
    await mount({ tools: ['Edit'] })
    await act(async () => { (item$('Bash').querySelector('[data-testid="armory-equip"]') as HTMLElement).click() })
    expect(latest.tools).toContain('Bash')
    expect(item$('Bash').querySelector('[data-testid="armory-on-sheet"]')).toBeTruthy()
    await act(async () => { (item$('Bash').querySelector('[data-testid="armory-unequip"]') as HTMLElement).click() })
    expect(latest.tools).not.toContain('Bash')
  })

  it('dropping on the matching row equips', async () => {
    await mount({ tools: ['Edit'] })
    await fire(item$('dev'), 'dragstart')
    expect(q('[data-testid="agent-packs-row"]').getAttribute('data-drop-target')).toBe('ready')
    await fire(q('[data-testid="agent-packs-row"]'), 'drop')
    expect(latest.packs).toContain('dev')
  })

  it('dropping on the wrong kind of row does nothing', async () => {
    await mount({ tools: ['Edit'] })
    await fire(item$('dev'), 'dragstart')
    expect(q('[data-testid="agent-mcp-row"]').getAttribute('data-drop-target')).toBeNull()
    await fire(q('[data-testid="agent-mcp-row"]'), 'drop')
    expect(latest.packs ?? []).not.toContain('dev')
    expect(latest.mcpServers ?? []).toEqual([])
  })

  it('Escape cancels a drag, then closes', async () => {
    await mount({ tools: ['Edit'] })
    await fire(item$('dev'), 'dragstart')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(q('[data-testid="agent-packs-row"]').getAttribute('data-drop-target')).toBeNull()
    expect(q('[data-testid="agent-armory"]')).toBeTruthy()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(q('[data-testid="agent-armory"]')).toBeNull()
  })

  it('unpacked skills are listed but not equippable', async () => {
    await mount({ tools: ['Edit'] })
    const box = q('[data-testid="armory-unpacked"]')
    expect(box.textContent).toContain('pdf')
    expect(box.textContent).toContain('only inside packs')
    expect(box.querySelector('button')).toBeNull()
    expect(box.getAttribute('draggable')).toBeNull()
  })
})
