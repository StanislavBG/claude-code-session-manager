// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HomeAgentTools } from '../HomeAgentTools'
import { useSessions } from '../../../../state/sessions'

const LONG = 'Write a new PRD file. '.repeat(70)
const CATALOG = {
  ok: true,
  tools: [
    { name: 'scheduler_create_prd', group: 'scheduler', purpose: LONG, whenToUse: 'WTU-A', whenNotToUse: 'WNTU-A', exampleArgs: { a: 1 }, notes: null },
    { name: 'chat_send_prompt', group: 'chat', purpose: 'Push a prompt into an open tab.', whenToUse: 'WTU-B', whenNotToUse: 'WNTU-B', exampleArgs: {}, notes: null },
  ],
  recipes: [],
}

let container: HTMLDivElement
let root: Root
const delegationReadiness = vi.fn()
const catalog = vi.fn()

async function mount() {
  await act(async () => { root.render(createElement(HomeAgentTools)) })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  delegationReadiness.mockReset()
  catalog.mockReset()
  ;(window as unknown as { api: unknown }).api = { mcp: { catalog }, app: { delegationReadiness } }
  useSessions.setState({ tabs: [], activeTabId: null } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HomeAgentTools', () => {
  it('is collapsed by default, showing the tool count, with no cwd/readiness call', async () => {
    catalog.mockResolvedValue(CATALOG)
    await mount()
    const text = container.textContent ?? ''
    expect(text).toContain('Agent tools')
    expect(text).toContain('2 MCP tools')
    expect(text).not.toContain('scheduler_create_prd')
    expect(catalog).toHaveBeenCalledTimes(1)
    expect(delegationReadiness).not.toHaveBeenCalled()
  })

  it('expands to every tool name and purpose exactly once, dropping the verbose fields', async () => {
    catalog.mockResolvedValue(CATALOG)
    await mount()
    act(() => { (container.querySelector('[data-testid="home-agent-tools-toggle"]') as HTMLButtonElement).click() })
    const text = container.textContent ?? ''
    for (const t of CATALOG.tools) {
      expect(text.split(t.name).length - 1).toBe(1)
      expect(text.split(t.purpose).length - 1).toBe(1)
    }
    expect(text).not.toContain('WTU-A')
    expect(text).not.toContain('WNTU-A')
    expect(text).not.toContain('example call')
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.some((b) => b.textContent?.includes('Copy example'))).toBe(false)
  })

  it('clamps the purpose to one line and carries the full text in title', async () => {
    catalog.mockResolvedValue(CATALOG)
    await mount()
    act(() => { (container.querySelector('[data-testid="home-agent-tools-toggle"]') as HTMLButtonElement).click() })
    const purpose = container.querySelector('[data-testid="home-agent-tool-purpose"]') as HTMLElement
    expect(purpose.className).toContain('line-clamp-1')
    expect(purpose.getAttribute('title')).toBe(LONG)
  })

  it('renders the fallback line without a toast when the catalog is not ok', async () => {
    catalog.mockResolvedValue({ ok: false })
    await mount()
    expect(container.querySelector('[data-testid="home-agent-tools-error"]')?.textContent).toBe('The MCP tool catalog is unavailable.')
  })

  it('renders the fallback line when the catalog call rejects', async () => {
    catalog.mockRejectedValue(new Error('boom'))
    await mount()
    expect(container.textContent).toContain('The MCP tool catalog is unavailable.')
  })
})
