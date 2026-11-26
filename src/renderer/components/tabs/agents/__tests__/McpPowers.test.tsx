// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GearPanel } from '../GearPanel'
import { useLayout } from '../../../../state/layout'
import { BLANK_DRAFT, type Draft } from '../AgentDetail'

const item = (id: string, badges: Array<'risky' | 'banned' | 'floor'> = []) => ({ id, label: id, badges })
const tools = [item('mcp__blender__a', ['risky']), item('mcp__blender__b'), item('mcp__blender__c')]
const armory = vi.fn()
const mk = (status: string, t = tools) => ({
  builtins: [item('Read', ['floor']), item('Edit')], bundledSkills: [], packs: [], unpackedSkills: [], errors: [],
  mcpServers: [{ ...item('blender'), status, scope: 'user', tools: t }],
})
let container: HTMLDivElement
let root: Root
let latest: Draft
async function mount(initial: Partial<Draft>) {
  ;(window as unknown as { api: unknown }).api = { agents: { armory, onChanged: () => () => {} }, toolRisk: { read: async () => ({ ok: true, marks: { mcp__blender__a: 'public', mcp__blender__c: 'read' } }) } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const Host = () => {
    const [d, setD] = useState<Draft>({ ...BLANK_DRAFT, ...initial })
    latest = d
    return createElement(GearPanel, { obj: d, set: (p: Partial<Draft>) => setD((x) => ({ ...x, ...p })) })
  }
  await act(async () => { root.render(createElement(Host)); await Promise.resolve() })
  await act(async () => { (container.querySelector('[data-testid="agent-mcp-powers-open"]') as HTMLElement).click() })
}
const q = (s: string) => container.querySelector(s) as HTMLElement
afterEach(() => { act(() => root.unmount()); container.remove(); armory.mockReset(); vi.restoreAllMocks() })

describe('McpPowers', () => {
  it('subset writes exactly the chosen tools', async () => {
    armory.mockResolvedValue(mk('checked'))
    await mount({ tools: ['Edit', 'mcp__blender__a', 'mcp__blender__b'], mcpServers: ['blender'] })
    expect(q('[data-testid="agent-mcp-powers-count"]').textContent).toBe('2 of 3 powers')
    expect(q('[data-power="mcp__blender__a"] [data-badge="risky"]').textContent).toBe('public')
    expect(q('[data-power="mcp__blender__b"] [data-badge="risky"]')).toBeNull()
    expect(q('[data-power="mcp__blender__c"] [data-badge="risky"]')).toBeNull()
    expect(q('[data-power="mcp__blender__a"] span[title]').textContent).toBe('a')
    expect(q('[data-power="mcp__blender__a"] span[title]').getAttribute('title')).toBe('mcp__blender__a')
    expect(q('[data-testid="agent-mcp-powers-name"]').textContent).toBe('blender')
    await act(async () => { (q('[data-power="mcp__blender__b"] input') as HTMLElement).click() })
    expect(latest.tools).toEqual(['Edit', 'mcp__blender__a'])
    expect(latest.mcpServers).toEqual(['blender'])
  })
  it('All writes every tool of the server', async () => {
    armory.mockResolvedValue(mk('checked'))
    await mount({ tools: ['Edit', 'mcp__blender__a'], mcpServers: ['blender'] })
    await act(async () => { q('[data-testid="agent-mcp-powers-all"]').click() })
    expect(latest.tools).toEqual(['Edit', 'mcp__blender__a', 'mcp__blender__b', 'mcp__blender__c'])
  })
  it('None confirms then unequips the server', async () => {
    armory.mockResolvedValue(mk('checked'))
    const c = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount({ tools: ['Edit', 'mcp__blender__a'], mcpServers: ['blender'] })
    await act(async () => { q('[data-testid="agent-mcp-powers-none"]').click() })
    expect(c).toHaveBeenCalled()
    expect(latest.tools).toEqual(['Edit'])
    expect(latest.mcpServers).toEqual([])
    expect(q('[data-testid="agent-mcp-powers"]')).toBeNull()
  })
  it('None declined keeps the server', async () => {
    armory.mockResolvedValue(mk('checked'))
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount({ tools: ['mcp__blender__a'], mcpServers: ['blender'] })
    await act(async () => { q('[data-testid="agent-mcp-powers-none"]').click() })
    expect(latest.tools).toEqual(['mcp__blender__a'])
  })
  it('not-checked server shows known tools and a Check in MCP link', async () => {
    armory.mockResolvedValue(mk('not-checked'))
    await mount({ tools: ['mcp__blender__a'], mcpServers: ['blender'] })
    expect(q('[data-testid="agent-mcp-powers-check"]').textContent).toBe('Check in MCP')
    expect(container.querySelectorAll('[data-power]').length).toBe(3)
    const open = vi.spyOn(useLayout.getState(), 'openPanel').mockImplementation(() => {})
    await act(async () => { q('[data-testid="agent-mcp-powers-check"]').click() })
    expect(open).toHaveBeenCalledWith('claude-config', 'mcp')
    expect(q('[data-testid="agent-mcp-powers-check"]').getAttribute('href')).toBeNull()
  })
  it('not-checked with no known tools still offers the link', async () => {
    armory.mockResolvedValue(mk('not-checked', []))
    await mount({ tools: ['Edit'], mcpServers: ['blender'] })
    expect(q('[data-testid="agent-mcp-powers-check"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-power]').length).toBe(0)
  })
})
