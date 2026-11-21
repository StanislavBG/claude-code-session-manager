// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HomeAgentTools } from '../HomeAgentTools'
import { useSessions } from '../../../../state/sessions'
// The exact object the main process's `mcp:catalog` IPC handler returns (src/main/index.cjs
// passes MCP_TOOL_CATALOG through verbatim — no zod schema, no field mapping).
import { createRequire } from 'node:module'
import type { McpToolCatalogEntry } from '../../../../../preload/api'

const nodeRequire = createRequire(import.meta.url)
const { MCP_TOOL_CATALOG } = nodeRequire('../../../../../main/lib/mcpToolCatalog.cjs') as {
  MCP_TOOL_CATALOG: McpToolCatalogEntry[]
}

const LONG = 'Write a new PRD file. '.repeat(70)
const CATALOG = {
  ok: true,
  tools: [
    { name: 'scheduler_create_prd', group: 'scheduler', purpose: LONG, summary: 'Create one PRD file in an Epic.', whenToUse: 'WTU-A', whenNotToUse: 'WNTU-A', exampleArgs: { a: 1 }, notes: null },
    { name: 'chat_send_prompt', group: 'chat', purpose: 'Push a prompt into an open tab.', summary: 'Send a prompt to an open tab.', whenToUse: 'WTU-B', whenNotToUse: 'WNTU-B', exampleArgs: {}, notes: null },
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

  it('expands to every tool name and summary exactly once, dropping the verbose fields', async () => {
    catalog.mockResolvedValue(CATALOG)
    await mount()
    act(() => { (container.querySelector('[data-testid="home-agent-tools-toggle"]') as HTMLButtonElement).click() })
    const text = container.textContent ?? ''
    for (const t of CATALOG.tools) {
      expect(text.split(t.name).length - 1).toBe(1)
      expect(text.split(t.summary).length - 1).toBe(1)
    }
    expect(text).not.toContain(LONG.trim())
    expect(text).not.toContain('WTU-A')
    expect(text).not.toContain('WNTU-A')
    expect(text).not.toContain('example call')
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.some((b) => b.textContent?.includes('Copy example'))).toBe(false)
  })

  it('shows the summary as the one-line row text and carries the full purpose in title', async () => {
    catalog.mockResolvedValue(CATALOG)
    await mount()
    act(() => { (container.querySelector('[data-testid="home-agent-tools-toggle"]') as HTMLButtonElement).click() })
    const rows = Array.from(container.querySelectorAll('[data-testid="home-agent-tool-purpose"]')) as HTMLElement[]
    expect(rows.length).toBe(CATALOG.tools.length)
    CATALOG.tools.forEach((t, i) => {
      expect(rows[i].textContent).toBe(t.summary)
      expect(rows[i].getAttribute('title')).toBe(t.purpose)
      expect(rows[i].className).toContain('line-clamp-1')
    })
  })

  it('renders the real catalog served over mcp:catalog with every summary intact', async () => {
    const real = MCP_TOOL_CATALOG
    expect(real.length).toBeGreaterThan(0)
    catalog.mockResolvedValue({ ok: true, tools: real, recipes: [] })
    await mount()
    act(() => { (container.querySelector('[data-testid="home-agent-tools-toggle"]') as HTMLButtonElement).click() })
    for (const t of real) {
      expect(typeof t.summary).toBe('string')
      const row = container.querySelector(`[data-testid="home-agent-tool-${t.name}"] [data-testid="home-agent-tool-purpose"]`) as HTMLElement
      expect(row.textContent).toBe(t.summary)
      expect(row.getAttribute('title')).toBe(t.purpose)
    }
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
