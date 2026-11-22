// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { McpServerDetail, MCP_TOOL_CHIP_LIMIT } from '../McpServerDetail'
import { mcpCheckKey, useMcpChecks } from '../../../../state/mcpChecks'
import type { McpCheckRequest, McpCheckResult } from '../../../../../preload/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REQ: McpCheckRequest = { source: 'user', name: 'playwright' }
const PRISTINE = useMcpChecks.getState()

const connected = (n: number): McpCheckResult => ({
  ok: true,
  status: 'connected',
  tools: Array.from({ length: n }, (_, i) => ({ name: `tool${i}` })),
  checkedAt: Date.now() - 2 * 60_000,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useMcpChecks.setState(PRISTINE, true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const chips = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="mcp-tool-row-"]')).map((c) => c.textContent)

function render(result?: McpCheckResult) {
  if (result) useMcpChecks.setState({ results: { [mcpCheckKey(REQ)]: result } })
  act(() => {
    root.render(
      <McpServerDetail
        name="playwright"
        server={{ command: 'npx', args: ['@playwright/mcp@latest'] }}
        scope="user"
        fileLabel="~/.claude.json"
        checkRequest={REQ}
        origin="community"
        footer={<span>Saved — matches ~/.claude.json</span>}
      />,
    )
  })
}

describe('McpServerDetail TOOLS chips', () => {
  it('shows the first 8 tools as chips, then "+N more"; clicking it lists the rest', () => {
    render(connected(20))
    expect(MCP_TOOL_CHIP_LIMIT).toBe(8)
    expect(q('mcp-tools')!.textContent).toContain('Tools · 20')
    expect(q('mcp-detail-checked')!.textContent).toBe('checked 2m ago')
    expect(chips()).toEqual(Array.from({ length: 8 }, (_, i) => `tool${i}`))
    expect(q('mcp-tools-more')!.textContent).toBe('+12 more')

    act(() => q('mcp-tools-more')!.click())
    expect(chips()).toHaveLength(20)
    expect(q('mcp-tools-more')).toBeNull()
  })

  it('has no "+N more" with 8 tools or fewer', () => {
    render(connected(8))
    expect(chips()).toHaveLength(8)
    expect(q('mcp-tools-more')).toBeNull()
  })

  it('an unchecked server checks only on click of "Check <name>"', () => {
    const check = vi.fn(async (): Promise<McpCheckResult> => connected(0))
    useMcpChecks.setState({ check })
    render()
    expect(check).not.toHaveBeenCalled()
    expect(q('mcp-tools-empty')!.textContent).toContain('Tools appear after a check')
    act(() => q('mcp-tools-check')!.click())
    expect(check).toHaveBeenCalledWith(REQ)
  })

  it('heads with the eyebrow, name + pill, Check again / Edit JSON; ENVIRONMENT · 0 + Add variable; the footer closes the body; no Enabled switch', () => {
    render(connected(1))
    expect(q('mcp-detail-meta')!.textContent).toBe('Community · stdio · User scope · ~/.claude.json › mcpServers › playwright')
    expect(q('mcp-detail-name')!.textContent).toBe('playwright')
    expect(q('mcp-detail-status')!.textContent).toBe('Connected')
    expect(q('mcp-check-again')).not.toBeNull()
    expect(q('mcp-edit-json')).not.toBeNull()
    expect(q('mcp-command')!.textContent).toBe('npx @playwright/mcp@latest')
    expect(q('mcp-env')!.textContent).toContain('Environment · 0')
    expect(q('mcp-env-add')!.textContent).toBe('+ Add variable')
    expect(container.textContent).toContain('Saved — matches ~/.claude.json')
    expect(container.querySelector('[role="switch"]')).toBeNull()
  })

  it('Copy carries the copy icon', () => {
    render(connected(1))
    const copy = q('mcp-command-copy')!
    expect(copy.textContent).toBe('Copy')
    expect(copy.querySelector('[data-testid="mcp-command-copy-icon"] svg')).not.toBeNull()
  })
})

describe('McpServerDetail footer and approval', () => {
  function renderWith(props: Partial<Parameters<typeof McpServerDetail>[0]>) {
    act(() => {
      root.render(
        <McpServerDetail
          name="burrow"
          server={{ type: 'http', url: 'http://127.0.0.1:8767/mcp', headers: { 'x-bot-id': 'bot-secret-42' } }}
          scope="project"
          fileLabel=".mcp.json"
          checkRequest={null}
          origin="community"
          footer={
            <span>
              <button type="button">Revert</button>
              <button type="button">Save</button>
            </span>
          }
          {...props}
        />,
      )
    })
  }
  const buttons = () => Array.from(container.querySelectorAll('button')).map((b) => b.textContent)

  it('clean: only "Saved — matches <file>", no Save / Revert', () => {
    renderWith({ cleanLabel: 'Saved — matches .mcp.json' })
    expect(q('savebar-clean')!.textContent).toBe('Saved — matches .mcp.json')
    expect(buttons()).not.toContain('Save')
    expect(buttons()).not.toContain('Revert')
  })

  it('dirty: the footer (Save / Revert) replaces the saved line', () => {
    renderWith({})
    expect(q('savebar-clean')).toBeNull()
    expect(buttons()).toEqual(expect.arrayContaining(['Save', 'Revert']))
  })

  it('masks header values until Show is pressed, like env values', () => {
    renderWith({ cleanLabel: 'Saved — matches .mcp.json' })
    expect(q('mcp-headers')!.textContent).toContain('Headers · 1')
    expect(q('mcp-headers-value-x-bot-id')!.textContent).toBe('••••••••')
    expect(container.innerHTML).not.toContain('bot-secret-42')
    expect(q('mcp-headers-reveal-x-bot-id')!.textContent).toBe('Show')
    act(() => q('mcp-headers-reveal-x-bot-id')!.click())
    expect(q('mcp-headers-value-x-bot-id')!.textContent).toBe('bot-secret-42')
    expect(q('mcp-headers-reveal-x-bot-id')!.textContent).toBe('Hide')
  })

  it('an "Approved" toggle in the header reflects and changes approval; none without approval', () => {
    const onChange = vi.fn()
    renderWith({ approval: { approved: true, busy: false, onChange } })
    const sw = q('mcp-detail-approved')!.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(q('mcp-detail-approved')!.textContent).toBe('Approved')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    act(() => sw.click())
    expect(onChange).toHaveBeenCalledWith(false)

    renderWith({ approval: undefined })
    expect(q('mcp-detail-approved')).toBeNull()
  })
})
