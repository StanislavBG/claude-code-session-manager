// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GearPanel } from '../GearPanel'
import { BLANK_DRAFT, type Draft } from '../AgentDetail'
import { useToast } from '../../../../state/toast'

const item = (id: string, badges: Array<'risky' | 'banned' | 'floor'> = []) => ({ id, label: id, badges })
const ARMORY = {
  builtins: [item('Read', ['floor']), item('Bash', ['risky']), item('Edit'), item('Task', ['banned'])],
  bundledSkills: [],
  mcpServers: [
    { ...item('blender'), status: 'checked', scope: 'user', tools: [item('mcp__blender__a'), item('mcp__blender__b')] },
    { ...item('pw'), status: 'failing', scope: 'user', tools: [] },
  ],
  packs: [{ ...item('dev'), skills: ['develop', 'builder'], source: 'plugin' }],
  unpackedSkills: [],
  errors: [],
}

let container: HTMLDivElement
let root: Root
let latest: Draft
const armory = vi.fn()

async function mount(initial: Partial<Draft>) {
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
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement
afterEach(() => { act(() => root.unmount()); container.remove(); armory.mockReset() })

describe('GearPanel', () => {
  it('toggles a built-in chip into the draft', async () => {
    armory.mockResolvedValue(ARMORY)
    await mount({ tools: ['Edit'] })
    expect(q('[data-tool="Bash"]').className).toContain('border-dashed')
    expect(q('[data-tool="Bash"] [data-badge="risky"]')).toBeTruthy()
    await act(async () => { q('[data-tool="Bash"]').click() })
    expect(latest.tools).toContain('Bash')
    await act(async () => { q('[data-tool="Edit"]').click() })
    expect(latest.tools).not.toContain('Edit')
  })

  it('floor chips are shown and are not buttons', async () => {
    armory.mockResolvedValue(ARMORY)
    await mount({ tools: ['Edit'] })
    expect(q('[data-floor="Read"]')).toBeTruthy()
    expect(q('[data-floor="Read"]').tagName).toBe('SPAN')
    expect(q('[data-tool="Read"]')).toBeNull()
  })

  it('equipping and removing an MCP server keeps tools and mcpServers in step', async () => {
    armory.mockResolvedValue(ARMORY)
    await mount({ tools: ['Edit'] })
    const sel = q('[data-testid="agent-mcp-equip"]') as HTMLSelectElement
    await act(async () => {
      sel.value = 'blender'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(latest.mcpServers).toEqual(['blender'])
    expect(latest.tools).toEqual(['Edit', 'mcp__blender__a', 'mcp__blender__b'])
    expect(q('[data-testid="agent-mcp-item"]').textContent).toContain('2 of 2 powers')
    await act(async () => { q('[data-testid="agent-mcp-remove"]').click() })
    expect(latest.mcpServers).toEqual([])
    expect(latest.tools).toEqual(['Edit'])
  })

  it('equips and removes a pack', async () => {
    armory.mockResolvedValue(ARMORY)
    await mount({ tools: ['Edit'] })
    const sel = q('[data-testid="agent-pack-equip"]') as HTMLSelectElement
    await act(async () => { sel.value = 'dev'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(latest.packs).toEqual(['dev'])
    expect(q('[data-testid="agent-pack-item"]').textContent).toContain('/develop')
    await act(async () => { q('[data-testid="agent-pack-remove"]').click() })
    expect(latest.packs).toEqual([])
  })

  it('an armory failure toasts and still renders the persona gear', async () => {
    armory.mockRejectedValue(new Error('boom'))
    const before = useToast.getState().history.length
    await mount({ tools: ['Edit', 'mcp__blender__a'] })
    const h = useToast.getState().history
    expect(h.length).toBe(before + 1)
    expect(h[h.length - 1]?.message ?? h[0]?.message).toContain('boom')
    expect(q('[data-tool="Edit"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-server="blender"]')).toBeTruthy()
  })
})
