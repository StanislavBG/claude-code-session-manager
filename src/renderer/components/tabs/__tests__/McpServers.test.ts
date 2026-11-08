// @vitest-environment jsdom
import { createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpServers, nextServerName, serialize, diffServerPatches, type McpAddContext } from '../McpServers'
import { buildInstallEntry, mcpPatchTarget } from '../Library'
import { useConfig } from '../../../state/config'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { useMcpChecks, mcpCheckKey } from '../../../state/mcpChecks'
import type { McpCheckRequest, McpCheckResult } from '../../../../preload/api'
import { HOME, PROJECT_CWD, PROJECT_TAB } from './_navfaceHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('nextServerName', () => {
  it('picks server-1 for an empty set', () => {
    expect(nextServerName({})).toBe('server-1')
  })

  it('picks the next unused index by default', () => {
    expect(nextServerName({ 'server-1': {} })).toBe('server-2')
  })

  it('does not collide with an existing key after a deletion', () => {
    // Regression: {server-1, server-2} with server-1 deleted leaves count=1,
    // so a naive `server-${count+1}` recomputes to "server-2" and silently
    // clobbers the surviving entry instead of adding a new one.
    const servers = { 'server-2': {} }
    expect(nextServerName(servers)).not.toBe('server-2')
    expect(nextServerName(servers)).toBe('server-3')
  })

  it('walks past multiple collisions', () => {
    const servers = { 'server-2': {}, 'server-3': {}, 'server-4': {} }
    expect(nextServerName(servers)).toBe('server-5')
  })
})

describe('serialize', () => {
  it('strips a stale enabled key from server entries', () => {
    const out = JSON.parse(
      serialize({ other: 1 }, { a: { command: 'x', enabled: false } as never, b: { url: 'u' } }),
    )
    expect(out.mcpServers.a).toEqual({ command: 'x' })
    expect(out.mcpServers.b).toEqual({ url: 'u' })
    expect(out.other).toBe(1)
  })
})

describe('diffServerPatches', () => {
  it('add: patches only the new key', () => {
    expect(diffServerPatches({ a: { command: 'x' } }, { a: { command: 'x' }, b: { type: 'stdio', command: '' } }))
      .toEqual([{ name: 'b', value: { type: 'stdio', command: '' } }])
  })
  it('rename: new name first, then old name to undefined', () => {
    const p = diffServerPatches({ old: { command: 'x' } }, { fresh: { command: 'x' } })
    expect(p).toEqual([
      { name: 'fresh', value: { command: 'x' } },
      { name: 'old', value: undefined },
    ])
  })
})

describe('McpLibrary install payload', () => {
  it('writes URL entries with type http', () => {
    expect(buildInstallEntry({ url: 'https://x/mcp', headers: { a: 'b' } })).toEqual({ url: 'https://x/mcp', headers: { a: 'b' }, type: 'http' })
  })
  it('keeps a declared type', () => {
    expect(buildInstallEntry({ url: 'https://x/sse', type: 'sse' } as never).type).toBe('sse')
  })
  it('targets the page scope', () => {
    expect(mcpPatchTarget('project', '/p')).toEqual({ fileId: 'mcpJson', scope: 'project', cwd: '/p' })
    expect(mcpPatchTarget('user', '/p')).toEqual({ fileId: 'claudeJson', scope: 'user' })
  })
})

/* ── The 3a list: toolbar, status dots, selection, Check all, + Add server ── */

const CLAUDE_JSON = `${HOME}/.claude.json`
const MCP_JSON = `${PROJECT_CWD}/.mcp.json`

// Listed sorted: alpha (Anthropic package), beta (remote URL → Community), delta, gamma (Local).
const SERVERS: Record<string, unknown> = {
  gamma: { command: 'node', args: ['gamma.js'] },
  alpha: { command: 'npx', args: ['-y', '@anthropic-ai/alpha-mcp'] },
  delta: { command: 'node', args: ['delta.js'] },
  beta: { type: 'http', url: 'https://beta.example.com/mcp' },
}

const userReq = (name: string): McpCheckRequest => ({ source: 'user', name })
const connected = (n: number): McpCheckResult => ({
  ok: true,
  status: 'connected',
  tools: Array.from({ length: n }, (_, i) => ({ name: `tool${i}` })),
  checkedAt: 1,
})
const failed: McpCheckResult = { ok: false, status: 'failed', error: 'spawn ENOENT', checkedAt: 1 }
const needsAuth: McpCheckResult = { ok: false, status: 'needs-auth', error: 'HTTP 401', checkedAt: 1 }

function installApi(servers: Record<string, unknown> = SERVERS) {
  const files: Record<string, string> = {
    [CLAUDE_JSON]: JSON.stringify({ mcpServers: servers }, null, 2) + '\n',
    [MCP_JSON]: JSON.stringify({ mcpServers: servers }, null, 2) + '\n',
  }
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn(async (path: string) => {
        const raw = files[path]
        return raw === undefined
          ? { raw: '', data: null, exists: false, mtimeMs: 0, parseError: null, error: null }
          : { raw, data: JSON.parse(raw), exists: true, mtimeMs: 1, parseError: null, error: null }
      }),
      readText: vi.fn(async (path: string) => {
        const raw = files[path]
        return raw === undefined
          ? { text: '', raw: '', exists: false, mtimeMs: 0, error: null }
          : { text: raw, raw, exists: true, mtimeMs: 1, error: null }
      }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    claudeConfig: {
      read: vi.fn().mockResolvedValue({ path: '', data: {} }),
      patch: vi.fn().mockResolvedValue({ ok: true, path: '', data: {} }),
    },
    mcp: {
      // The retired mount-time probe; the list must never call it.
      status: vi.fn().mockResolvedValue({ ok: true, error: null, servers: [] }),
      checkServer: vi.fn(async (req: McpCheckRequest): Promise<McpCheckResult> => (
        { alpha: connected(1), beta: failed, delta: needsAuth, gamma: connected(3) } as Record<string, McpCheckResult>
      )[req.name] ?? failed),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

const PRISTINE_CHECKS = useMcpChecks.getState()

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

type McpServersProps = { scope?: 'user' | 'project'; onAdd?: (ctx: McpAddContext) => void }

async function mount(props: McpServersProps = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(McpServers as ComponentType<McpServersProps>, props))
  })
  await flush()
  await flush()
  return container
}

const q = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const rowNames = () =>
  Array.from(container!.querySelectorAll<HTMLElement>('[data-testid^="mcp-row-"]')).map((r) => r.dataset.testid!.slice('mcp-row-'.length))
const selectedRows = () =>
  Array.from(container!.querySelectorAll<HTMLElement>('[data-testid^="mcp-row-"][aria-current="true"]')).map((r) => r.dataset.testid!.slice('mcp-row-'.length))
const nameInput = () => container!.querySelector<HTMLInputElement>('input[aria-label="Server name"]')
const buttonByText = (label: string) =>
  Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined

async function click(el: Element | null) {
  expect(el).not.toBeNull()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
  useConfig.setState({ files: {}, watchRefs: {} })
  useMcpChecks.setState(PRISTINE_CHECKS, true)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('McpServers 3a list', () => {
  it('renders the shared toolbar — Filter servers, "<n> servers · <m> checked", Check all, + Add server — and none of the old buttons', async () => {
    useMcpChecks.setState({ results: { [mcpCheckKey(userReq('beta'))]: failed } })
    installApi()
    await mount({ onAdd: vi.fn() })

    expect(q('extensions-toolbar')).not.toBeNull()
    expect((q('extensions-toolbar-filter') as HTMLInputElement).placeholder).toBe('Filter servers')
    expect(q('extensions-toolbar-summary')!.textContent).toBe('4 servers · 1 checked')
    expect(q('mcp-check-all')!.textContent).toBe('Check all')
    expect(q('mcp-add-server')!.textContent).toBe('+ Add server')
    for (const gone of ['Add…', '+ new server', '⟳ test connections', 'test connection']) {
      expect(buttonByText(gone)).toBeUndefined()
    }
  })

  it('heads the list with the real file and a count, and draws one status dot + "<origin> · <status>" line per server', async () => {
    useMcpChecks.setState({
      results: {
        [mcpCheckKey(userReq('alpha'))]: connected(2),
        [mcpCheckKey(userReq('beta'))]: failed,
        [mcpCheckKey(userReq('delta'))]: needsAuth,
      },
    })
    installApi()
    await mount()

    const header = q('mcp-list-header')!
    expect(header.firstChild?.textContent).toBe('In ~/.claude.json')
    expect(header.className.split(/\s+/)).toContain('uppercase')
    expect(header.querySelector('.font-mono')?.textContent).toBe('4')

    expect(rowNames()).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    const dot = (n: string) => q(`mcp-dot-${n}`)!
    const line2 = (n: string) => q(`mcp-status-${n}`)!
    expect(dot('alpha').dataset.status).toBe('connected')
    expect(dot('alpha').className).toContain('bg-sage')
    expect(dot('beta').dataset.status).toBe('failed')
    expect(dot('beta').className).toContain('bg-red-500')
    expect(dot('delta').dataset.status).toBe('needs-auth')
    expect(dot('delta').className).toContain('bg-honey')
    // Not checked = a hollow ring: a border, no fill.
    expect(dot('gamma').dataset.status).toBe('unchecked')
    expect(dot('gamma').className).toContain('border-fg-faint/60')
    expect(dot('gamma').className).not.toMatch(/(^|\s)bg-/)

    expect(line2('alpha').textContent).toBe('Anthropic · connected · 2 tools')
    expect(line2('alpha').querySelector('.text-accent-dark')?.textContent).toBe('Anthropic')
    expect(line2('beta').textContent).toBe('Community · failed')
    expect(line2('beta').querySelector('.text-honey-dark')?.textContent).toBe('Community')
    expect(line2('delta').textContent).toBe('Local · needs auth')
    expect(line2('gamma').textContent).toBe('Local · not checked')

    const transport = (n: string) => q(`mcp-row-${n}`)!.querySelector('.font-mono')?.textContent
    expect(transport('alpha')).toBe('stdio')
    expect(transport('beta')).toBe('http')
  })

  it('never probes on mount: neither mcp.status nor mcp.checkServer runs until asked', async () => {
    const api = installApi()
    await mount()
    expect(rowNames()).toHaveLength(4)
    expect(api.mcp.status).not.toHaveBeenCalled()
    expect(api.mcp.checkServer).not.toHaveBeenCalled()
  })

  it('always has a server selected: the first on load, the next one after the selected one is removed', async () => {
    installApi()
    await mount()
    expect(selectedRows()).toEqual(['alpha'])
    expect(nameInput()?.value).toBe('alpha')

    await click(buttonByText('delete')!)
    expect(rowNames()).toEqual(['beta', 'delta', 'gamma'])
    expect(selectedRows()).toEqual(['beta'])
    expect(nameInput()?.value).toBe('beta')

    // Removing the last row selects the one now last.
    await click(q('mcp-row-gamma'))
    expect(nameInput()?.value).toBe('gamma')
    await click(buttonByText('delete')!)
    expect(selectedRows()).toEqual(['delta'])
    expect(nameInput()?.value).toBe('delta')
    expect(container!.textContent).not.toContain('No MCP servers yet')
  })

  it('shows the empty state only when the file has zero servers', async () => {
    installApi({})
    await mount()
    expect(rowNames()).toEqual([])
    expect(q('extensions-toolbar-summary')!.textContent).toBe('0 servers · 0 checked')
    expect(container!.textContent).toContain('No MCP servers yet')
    expect(nameInput()).toBeNull()
  })

  it('Check all hands the store one request per listed server', async () => {
    const checkAll = vi.fn(async () => {})
    useMcpChecks.setState({ checkAll })
    installApi()
    await mount()

    await click(q('mcp-check-all'))
    expect(checkAll).toHaveBeenCalledTimes(1)
    expect(checkAll).toHaveBeenCalledWith(['alpha', 'beta', 'delta', 'gamma'].map(userReq))
  })

  it('Check all runs the real per-server check and the dots + summary follow the stored results', async () => {
    const api = installApi()
    await mount()
    expect(q('extensions-toolbar-summary')!.textContent).toBe('4 servers · 0 checked')

    await click(q('mcp-check-all'))
    await flush()
    expect(api.mcp.checkServer).toHaveBeenCalledTimes(4)
    for (const n of ['alpha', 'beta', 'delta', 'gamma']) expect(api.mcp.checkServer).toHaveBeenCalledWith(userReq(n))
    expect(api.mcp.status).not.toHaveBeenCalled()

    expect(q('extensions-toolbar-summary')!.textContent).toBe('4 servers · 4 checked')
    expect(q('mcp-dot-alpha')!.dataset.status).toBe('connected')
    expect(q('mcp-status-alpha')!.textContent).toBe('Anthropic · connected · 1 tool')
    expect(q('mcp-dot-beta')!.dataset.status).toBe('failed')
    expect(q('mcp-dot-delta')!.dataset.status).toBe('needs-auth')
    expect(q('mcp-status-gamma')!.textContent).toBe('Local · connected · 3 tools')
  })

  it('the filter narrows the rows (and Check all to them) but not the server total', async () => {
    const checkAll = vi.fn(async () => {})
    useMcpChecks.setState({ checkAll })
    installApi()
    await mount()

    await typeInto(q('extensions-toolbar-filter') as HTMLInputElement, 'ta')
    expect(rowNames()).toEqual(['beta', 'delta'])
    expect(q('mcp-list-header')!.querySelector('.font-mono')?.textContent).toBe('2')
    expect(q('extensions-toolbar-summary')!.textContent).toBe('4 servers · 0 checked')

    await click(q('mcp-check-all'))
    expect(checkAll).toHaveBeenCalledWith([userReq('beta'), userReq('delta')])
  })

  it('+ Add server ▸ New server adds a selected server-N draft; Browse catalog… calls onAdd', async () => {
    const onAdd = vi.fn()
    installApi()
    await mount({ onAdd })

    await click(q('mcp-add-server'))
    expect(Array.from(q('mcp-add-server-menu')!.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent))
      .toEqual(['New server', 'Browse catalog…'])
    await click(q('mcp-new-server'))

    expect(rowNames()).toEqual(['alpha', 'beta', 'delta', 'gamma', 'server-5'])
    expect(selectedRows()).toEqual(['server-5'])
    expect(nameInput()?.value).toBe('server-5')
    expect(q('extensions-toolbar-summary')!.textContent).toBe('5 servers · 0 checked')
    const file = useConfig.getState().files[CLAUDE_JSON]
    expect(file.dirty).toBe(true)
    expect(JSON.parse(file.draftRaw).mcpServers['server-5']).toEqual({ type: 'stdio', command: '', args: [] })

    await click(q('mcp-add-server'))
    await click(q('mcp-browse-catalog'))
    expect(onAdd).toHaveBeenCalledWith({ scope: 'user', cwd: null })
  })

  it('project scope names .mcp.json, keeps the gating row, and checks project servers by cwd', async () => {
    const checkAll = vi.fn(async () => {})
    useMcpChecks.setState({ checkAll })
    useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
    installApi({ srv: { command: 'x' } })
    await mount({ scope: 'project' })

    expect(q('mcp-list-header')!.firstChild?.textContent).toBe('In .mcp.json')
    expect(q('mcp-gating')).not.toBeNull()
    expect(selectedRows()).toEqual(['srv'])

    await click(q('mcp-check-all'))
    expect(checkAll).toHaveBeenCalledWith([{ source: 'project', name: 'srv', cwd: PROJECT_CWD }])
  })
})
