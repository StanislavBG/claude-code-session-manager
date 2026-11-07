// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HomeAgentTools } from '../HomeAgentTools'

const GROUPS = ['scheduler', 'chat', 'feedback', 'help', 'project-home', 'macros', 'customer-feedback', 'mystery-group']
const tools = GROUPS.map((group) => ({
  name: `tool_in_${group.replace(/-/g, '_')}`,
  group,
  purpose: `Purpose for ${group}`,
  whenToUse: '',
  whenNotToUse: '',
  exampleArgs: {},
  notes: null,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    mcp: { catalog: vi.fn().mockResolvedValue({ ok: true, tools, recipes: [] }) },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HomeAgentTools groups', () => {
  it('renders a section per group (7 known + 1 unknown) and every tool', async () => {
    await act(async () => { root.render(createElement(HomeAgentTools)) })
    await act(async () => { await Promise.resolve() })
    act(() => { (container.querySelector('[data-testid="home-agent-tools-toggle"]') as HTMLButtonElement).click() })
    const sections = container.querySelectorAll('[data-testid^="home-agent-group-"]')
    expect(sections.length).toBe(8)
    const text = container.textContent ?? ''
    for (const t of tools) expect(text).toContain(t.name)
    expect(text).toContain('Project Home')
    expect(text).toContain('Macros')
    expect(text).toContain('Customer feedback')
    expect(text).toContain('mystery-group')
  })
})
