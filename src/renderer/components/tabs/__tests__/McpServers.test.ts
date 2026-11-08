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
import { useToast } from '../../../state/toast'
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

interface FakePlugin {
  key: string
  name: string
  enabled: boolean
  /** The plugin's .mcp.json `mcpServers`. */
  servers: Record<string, unknown>
}

const pluginPath = (name: string) => `${HOME}/.claude/plugins/cache/${name}`

function installApi(servers: Record<string, unknown> = SERVERS, plugins: FakePlugin[] = []) {
  const files: Record<string, string> = {
    [CLAUDE_JSON]: JSON.stringify({ mcpServers: servers }, null, 2) + '\n',
    [MCP_JSON]: JSON.stringify({ mcpServers: servers }, null, 2) + '\n',
  }
  for (const p of plugins) files[`${pluginPath(p.name)}/.mcp.json`] = JSON.stringify({ mcpServers: p.servers })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    plugins: {
      list: vi.fn(async () =>
        plugins.map((p) => ({
          key: p.key,
          name: p.name,
          marketplace: p.key.split('@')[1] ?? '',
          version: '1.0.0',
          scope: 'user',
          installPath: pluginPath(p.name),
          enabled: p.enabled,
        })),
      ),
    },
    config: {
      exists: vi.fn(async (path: string) => path in files),
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
    // lib/clipboard.ts copyText writes through main (navigator.clipboard is denied in Electron).
    clipboard: { writeText: vi.fn(async () => ({ ok: true })) },
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
const detailName = () => q('mcp-detail-name')?.textContent ?? null
/** The SaveBar's Save button — its label carries the "Ctrl S" shortcut hint after "Save". */
const saveButton = () =>
  Array.from(container!.querySelectorAll('button')).find((b) => /^Save(Ctrl S|⌘S)?$/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement | undefined
const toastMessages = () => useToast.getState().toasts.map((t) => t.message)
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

/** React's onBlur listens for focusout. */
async function blur(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
  useConfig.setState({ files: {}, watchRefs: {} })
  useMcpChecks.setState(PRISTINE_CHECKS, true)
  useToast.setState({ toasts: [] })
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
    expect(detailName()).toBe('alpha')

    // delete lives in today's per-server form, behind Edit JSON.
    await click(q('mcp-edit-json'))
    await click(buttonByText('delete')!)
    expect(rowNames()).toEqual(['beta', 'delta', 'gamma'])
    expect(selectedRows()).toEqual(['beta'])
    expect(detailName()).toBe('beta')
    // The server that moves up opens in the 3a detail, not the form.
    expect(nameInput()).toBeNull()
    expect(q('mcp-command')).not.toBeNull()

    // Removing the last row selects the one now last.
    await click(q('mcp-row-gamma'))
    expect(detailName()).toBe('gamma')
    await click(q('mcp-edit-json'))
    await click(buttonByText('delete')!)
    expect(selectedRows()).toEqual(['delta'])
    expect(detailName()).toBe('delta')
    expect(container!.textContent).not.toContain('No MCP servers yet')
  })

  it('shows the empty state only when the file has zero servers', async () => {
    installApi({})
    await mount()
    expect(rowNames()).toEqual([])
    expect(q('extensions-toolbar-summary')!.textContent).toBe('0 servers · 0 checked')
    expect(container!.textContent).toContain('No MCP servers yet')
    expect(q('mcp-detail')).toBeNull()
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
    // A blank server opens straight in today's form — name and command are all it needs.
    expect(detailName()).toBe('server-5')
    expect(nameInput()?.value).toBe('server-5')
    expect(q('mcp-edit-done')).not.toBeNull()
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
    expect(q('mcp-detail-scope')!.textContent).toBe('Project scope')
    expect(q('mcp-detail-keypath')!.textContent).toBe('.mcp.json › mcpServers › srv')
    expect(q('savebar-clean')!.textContent).toBe('Saved — matches .mcp.json')

    await click(q('mcp-check-all'))
    expect(checkAll).toHaveBeenCalledWith([{ source: 'project', name: 'srv', cwd: PROJECT_CWD }])
  })
})

/* ── The 3a detail: header, COMMAND / ENVIRONMENT / TOOLS, Edit JSON, the SaveBar ── */

describe('McpServers 3a detail', () => {
  const ago = (ms: number) => Date.now() - ms

  it('heads the detail with the 22px name, a Connected pill, "checked <ago>", provenance + transport badges, scope and key path', async () => {
    useMcpChecks.setState({ results: { [mcpCheckKey(userReq('alpha'))]: { ...connected(2), checkedAt: ago(5 * 60_000) } } })
    installApi()
    await mount()

    const name = q('mcp-detail-name')!
    expect(name.textContent).toBe('alpha')
    expect(name.className.split(/\s+/)).toEqual(expect.arrayContaining(['text-[22px]', 'font-semibold']))

    const pill = q('mcp-detail-status')!
    expect(pill.textContent).toBe('Connected')
    expect(pill.dataset.status).toBe('connected')
    expect(pill.className.split(/\s+/)).toEqual(expect.arrayContaining(['bg-sage/15', 'text-sage-dark']))
    expect(pill.querySelector('.bg-sage')).not.toBeNull()
    expect(q('mcp-detail-checked')!.textContent).toBe('checked 5m ago')

    // The origin as ProvenanceBadge resolves it (accent tone = Anthropic); display-only here.
    const origin = q('mcp-detail-meta')!.querySelector<HTMLElement>('.text-accent-dark')!
    expect(origin.textContent).toBe('Anthropic')
    expect(origin.title).toMatch(/^Auto-detected Anthropic/)
    expect(q('mcp-detail-transport')!.textContent).toBe('stdio')
    expect(q('mcp-detail-transport')!.querySelector('.uppercase')).not.toBeNull()
    expect(q('mcp-detail-scope')!.textContent).toBe('User scope')
    expect(q('mcp-detail-keypath')!.textContent).toBe('~/.claude.json › mcpServers › alpha')
    expect(q('mcp-detail-keypath')!.className).toContain('font-mono')

    // DESIGN_SPEC §7.1: Claude Code has no per-server enabled field, so there is no Enabled switch.
    expect(container!.querySelector('[role="switch"]')).toBeNull()
    expect(container!.textContent).not.toMatch(/Enabled/)
  })

  it('draws the Failed, Needs auth and Not checked pill variants — a failure names its error on hover', async () => {
    useMcpChecks.setState({
      results: { [mcpCheckKey(userReq('beta'))]: failed, [mcpCheckKey(userReq('delta'))]: needsAuth },
    })
    installApi()
    await mount()
    const pill = () => q('mcp-detail-status')!
    const classes = () => pill().className.split(/\s+/)

    // alpha has never been checked.
    expect(pill().textContent).toBe('Not checked')
    expect(pill().dataset.status).toBe('unchecked')
    expect(pill().querySelector('.border-fg-faint\\/60')).not.toBeNull()
    expect(q('mcp-detail-checked')).toBeNull()

    await click(q('mcp-row-beta'))
    expect(pill().textContent).toBe('Failed')
    expect(pill().dataset.status).toBe('failed')
    expect(classes()).toEqual(expect.arrayContaining(['bg-red-500/10', 'text-red-700']))
    expect(pill().title).toBe('spawn ENOENT')
    expect(q('mcp-detail-checked')!.textContent).toMatch(/^checked \d+d ago$/)
    expect(q('mcp-detail-transport')!.textContent).toBe('http')

    await click(q('mcp-row-delta'))
    expect(pill().textContent).toBe('Needs auth')
    expect(pill().dataset.status).toBe('needs-auth')
    expect(classes()).toEqual(expect.arrayContaining(['bg-honey/15', 'text-honey-dark']))
    expect(pill().querySelector('.bg-honey')).not.toBeNull()
  })

  it('Check again runs this server\'s check through the mcpChecks store and shows the checking state until it settles', async () => {
    const api = installApi()
    let settle!: (r: McpCheckResult) => void
    api.mcp.checkServer.mockImplementationOnce(() => new Promise<McpCheckResult>((r) => { settle = r }))
    await mount()

    const button = () => q('mcp-check-again') as HTMLButtonElement
    expect(button().textContent).toBe('Check again')
    await click(button())
    expect(api.mcp.checkServer).toHaveBeenCalledTimes(1)
    expect(api.mcp.checkServer).toHaveBeenCalledWith(userReq('alpha'))
    expect(useMcpChecks.getState().checking[mcpCheckKey(userReq('alpha'))]).toBe(true)
    expect(button().textContent).toBe('Checking…')
    expect(button().disabled).toBe(true)
    expect(q('mcp-detail-checked')!.textContent).toBe('checking…')
    // The list row follows the same in-flight check.
    expect(q('mcp-status-alpha')!.textContent).toBe('Anthropic · checking…')

    await act(async () => { settle({ ...connected(1), checkedAt: Date.now() }) })
    await flush()
    expect(button().textContent).toBe('Check again')
    expect(button().disabled).toBe(false)
    expect(q('mcp-detail-status')!.textContent).toBe('Connected')
    expect(q('mcp-detail-checked')!.textContent).toBe('checked just now')
    expect(q('mcp-tools-count')!.textContent).toBe('1')
  })

  it('TOOLS lists the last check as mono name | description | mono mcp__<server>__<tool>; unchecked and failed servers say why there are none', async () => {
    const tools = [
      { name: 'fetch', description: 'Fetches a URL from the internet.' },
      { name: 'read_page', description: '' },
    ]
    useMcpChecks.setState({
      results: {
        [mcpCheckKey(userReq('alpha'))]: { ok: true, status: 'connected', tools, checkedAt: ago(1_000) },
        [mcpCheckKey(userReq('beta'))]: failed,
      },
    })
    installApi()
    await mount()

    expect(q('mcp-tools-count')!.textContent).toBe('2')
    expect(q('mcp-tools')!.textContent).toContain('from the last check')
    const rows = Array.from(container!.querySelectorAll<HTMLElement>('[data-testid^="mcp-tool-row-"]'))
    expect(rows.map((r) => Array.from(r.children).map((c) => c.textContent))).toEqual([
      ['fetch', 'Fetches a URL from the internet.', 'mcp__alpha__fetch'],
      ['read_page', '', 'mcp__alpha__read_page'],
    ])
    expect(rows[0].children[0].className).toContain('font-mono')
    expect(rows[0].children[2].className).toContain('font-mono')

    await click(q('mcp-row-gamma'))
    expect(q('mcp-tools-empty')!.textContent).toBe('Check this server to list its tools.')
    expect(q('mcp-tools-count')).toBeNull()
    expect(container!.querySelectorAll('[data-testid^="mcp-tool-row-"]')).toHaveLength(0)

    await click(q('mcp-row-beta'))
    expect(q('mcp-tools-empty')!.textContent).toBe('The last check failed: spawn ENOENT')
  })

  it('COMMAND shows "$ <command> <args…>" (an http server: its URL) in a mono box, and Copy writes it to the clipboard with a toast', async () => {
    const api = installApi({ ...SERVERS, spaced: { command: 'node', args: ['server.js', '--root', '/tmp/my dir'] } })
    await mount()

    const box = q('mcp-command-box')!
    expect(box.className.split(/\s+/)).toEqual(expect.arrayContaining(['font-mono', 'bg-bg-hi']))
    expect(box.textContent!.startsWith('$')).toBe(true)
    expect(q('mcp-command')!.textContent).toBe('npx -y @anthropic-ai/alpha-mcp')

    await click(q('mcp-command-copy'))
    expect(api.clipboard.writeText).toHaveBeenCalledWith('npx -y @anthropic-ai/alpha-mcp')
    expect(toastMessages()).toEqual(['Command copied'])

    // An argument with a space is quoted, so the copied line runs as configured.
    await click(q('mcp-row-spaced'))
    expect(q('mcp-command')!.textContent).toBe("node server.js --root '/tmp/my dir'")

    await click(q('mcp-row-beta'))
    expect(q('mcp-command')!.textContent).toBe('https://beta.example.com/mcp')
    expect(q('mcp-command-box')!.textContent).not.toContain('$')
    await click(q('mcp-command-copy'))
    expect(api.clipboard.writeText).toHaveBeenLastCalledWith('https://beta.example.com/mcp')
  })

  it('ENVIRONMENT masks every value until its row is revealed; no variables = the dashed "No variables set" box', async () => {
    installApi({
      envy: { command: 'node', args: ['envy.js'], env: { API_TOKEN: 'sekrit-123', REGION: 'us-west-2' } },
      plain: { command: 'node', args: ['plain.js'] },
    })
    await mount()

    const envRows = () => Array.from(q('mcp-env')!.querySelectorAll<HTMLElement>('[data-testid^="mcp-env-row-"]'))
    expect(envRows().map((r) => r.dataset.testid)).toEqual(['mcp-env-row-API_TOKEN', 'mcp-env-row-REGION'])
    expect(envRows()[0].textContent).toContain('API_TOKEN')
    expect(container!.innerHTML).not.toContain('sekrit-123')
    expect(container!.innerHTML).not.toContain('us-west-2')

    await click(q('mcp-env-reveal-API_TOKEN'))
    expect(q('mcp-env-value-API_TOKEN')!.textContent).toBe('sekrit-123')
    expect(q('mcp-env-reveal-API_TOKEN')!.textContent).toBe('Hide')
    // Revealing one row leaves the others masked.
    expect(container!.innerHTML).not.toContain('us-west-2')

    await click(q('mcp-env-reveal-API_TOKEN'))
    expect(container!.innerHTML).not.toContain('sekrit-123')

    await click(q('mcp-row-plain'))
    const empty = q('mcp-env-empty')!
    expect(empty.textContent).toContain('No variables set')
    expect(empty.className.split(/\s+/)).toContain('border-dashed')
    expect(empty.querySelector('[data-testid="mcp-env-add"]')!.textContent).toBe('+ Add variable')
  })

  it('+ Add variable puts KEY=value in the draft (SaveBar dirty) and Save patches the server\'s env — the value is never toasted', async () => {
    const api = installApi()
    await mount()
    expect(q('savebar-clean')!.textContent).toBe('Saved — matches ~/.claude.json')

    await click(q('mcp-env-add'))
    expect((q('mcp-env-add-confirm') as HTMLButtonElement).disabled).toBe(true)
    await typeInto(q('mcp-env-new-key') as HTMLInputElement, 'API_TOKEN')
    await typeInto(q('mcp-env-new-value') as HTMLInputElement, 'sekrit-123')
    await click(q('mcp-env-add-confirm'))

    const file = useConfig.getState().files[CLAUDE_JSON]
    expect(file.dirty).toBe(true)
    expect(JSON.parse(file.draftRaw).mcpServers.alpha.env).toEqual({ API_TOKEN: 'sekrit-123' })
    expect(q('savebar-clean')).toBeNull()
    expect(container!.textContent).toContain('unsaved')
    // The new row is masked like the rest.
    expect(q('mcp-env-row-API_TOKEN')).not.toBeNull()
    expect(container!.innerHTML).not.toContain('sekrit-123')

    await click(saveButton()!)
    expect(api.claudeConfig.patch).toHaveBeenCalledTimes(1)
    expect(api.claudeConfig.patch).toHaveBeenCalledWith({
      fileId: 'claudeJson',
      scope: 'user',
      keyPath: ['mcpServers', 'alpha'],
      value: { command: 'npx', args: ['-y', '@anthropic-ai/alpha-mcp'], env: { API_TOKEN: 'sekrit-123' } },
    })
    expect(toastMessages().some((m) => m.includes('sekrit-123'))).toBe(false)
  })

  it('a remote server lists HEADERS (masked) instead of ENVIRONMENT, and + Add header patches headers', async () => {
    installApi({ remote: { type: 'http', url: 'https://r.example.com/mcp', headers: { Authorization: 'Bearer tok-123456' } } })
    await mount()

    expect(q('mcp-env')).toBeNull()
    expect(q('mcp-headers-row-Authorization')).not.toBeNull()
    expect(container!.innerHTML).not.toContain('tok-123456')

    await click(q('mcp-headers-add'))
    await typeInto(q('mcp-headers-new-key') as HTMLInputElement, 'X-Team')
    await typeInto(q('mcp-headers-new-value') as HTMLInputElement, 'core')
    await click(q('mcp-headers-add-confirm'))
    expect(JSON.parse(useConfig.getState().files[CLAUDE_JSON].draftRaw).mcpServers.remote.headers).toEqual({
      Authorization: 'Bearer tok-123456',
      'X-Team': 'core',
    })
  })

  it('Edit JSON swaps the body for today\'s per-server form; Done brings the 3a detail back with the edit kept in the draft', async () => {
    installApi()
    await mount()
    expect(q('mcp-command')).not.toBeNull()
    expect(nameInput()).toBeNull()

    await click(q('mcp-edit-json'))
    for (const gone of ['mcp-command-box', 'mcp-env', 'mcp-tools', 'mcp-edit-json']) expect(q(gone)).toBeNull()
    expect(nameInput()?.value).toBe('alpha')
    // The header stays: name, pill, Check again — and Done in Edit JSON's place.
    expect(detailName()).toBe('alpha')
    expect(q('mcp-detail-status')).not.toBeNull()
    expect(container!.querySelectorAll('[data-testid="mcp-check-again"]')).toHaveLength(1)
    expect(q('mcp-edit-done')!.textContent).toBe('Done')
    // The form keeps the origin override menu the old form header had.
    expect(q('mcp-json-form')!.querySelector('button[aria-label^="Origin: Anthropic"]')).not.toBeNull()

    const command = Array.from(container!.querySelectorAll('input')).find((i) => i.placeholder === 'npx / node / python …')!
    await typeInto(command, 'bunx')
    expect(useConfig.getState().files[CLAUDE_JSON].dirty).toBe(true)

    await click(q('mcp-edit-done'))
    expect(nameInput()).toBeNull()
    expect(q('mcp-edit-json')).not.toBeNull()
    expect(q('mcp-command')!.textContent).toBe('bunx -y @anthropic-ai/alpha-mcp')
    expect(useConfig.getState().files[CLAUDE_JSON].dirty).toBe(true)
  })

  it('a rename inside Edit JSON keeps the form open on the renamed server; picking another server closes it', async () => {
    installApi()
    await mount()
    await click(q('mcp-edit-json'))
    const input = nameInput()!
    await typeInto(input, 'alpha-2')
    await blur(input)

    expect(selectedRows()).toEqual(['alpha-2'])
    expect(detailName()).toBe('alpha-2')
    expect(nameInput()?.value).toBe('alpha-2')
    expect(q('mcp-edit-done')).not.toBeNull()

    await click(q('mcp-row-beta'))
    expect(detailName()).toBe('beta')
    expect(nameInput()).toBeNull()
    expect(q('mcp-edit-json')).not.toBeNull()
  })

  it('the SaveBar names the scope\'s file when clean, shows the save shortcut, and Ctrl+S saves while focus is in the pane', async () => {
    const api = installApi()
    await mount()
    expect(q('savebar-clean')!.textContent).toBe('Saved — matches ~/.claude.json')
    expect(saveButton()!.querySelector('kbd')?.textContent).toBe('Ctrl S')
    expect(saveButton()!.getAttribute('aria-keyshortcuts')).toBe('Control+S')

    await click(q('mcp-env-add'))
    await typeInto(q('mcp-env-new-key') as HTMLInputElement, 'REGION')
    await click(q('mcp-env-add-confirm'))
    expect(useConfig.getState().files[CLAUDE_JSON].dirty).toBe(true)

    q('mcp-row-alpha')!.focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    await flush()
    expect(api.claudeConfig.patch).toHaveBeenCalledTimes(1)
    expect(api.claudeConfig.patch).toHaveBeenCalledWith(expect.objectContaining({
      keyPath: ['mcpServers', 'alpha'],
      value: expect.objectContaining({ env: { REGION: '' } }),
    }))
  })
})

/* ── FROM PLUGINS: servers enabled plugins add, read-only ── */

const PLUGINS: FakePlugin[] = [
  { key: 'stripe@claude-plugins-official', name: 'stripe', enabled: true, servers: { stripe: { command: 'npx', args: ['-y', '@stripe/mcp'] } } },
  { key: 'linear@community', name: 'linear', enabled: true, servers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } },
  { key: 'off@community', name: 'off', enabled: false, servers: { hidden: { command: 'node' } } },
]
const STRIPE_ID = 'stripe@claude-plugins-official/stripe'
const LINEAR_ID = 'linear@community/linear'
const stripeReq: McpCheckRequest = { source: 'plugin', name: 'stripe', pluginKey: 'stripe@claude-plugins-official' }
const linearReq: McpCheckRequest = { source: 'plugin', name: 'linear', pluginKey: 'linear@community' }
const pluginRowIds = () =>
  Array.from(container!.querySelectorAll<HTMLElement>('[data-testid^="mcp-plugin-row-"]')).map((r) => r.dataset.testid!.slice('mcp-plugin-row-'.length))

describe('McpServers FROM PLUGINS', () => {
  it('lists the servers enabled plugins add under FROM PLUGINS with a count, READ-ONLY, transport plugin and "via the <plugin> plugin · <status>"', async () => {
    useMcpChecks.setState({ results: { [mcpCheckKey(stripeReq)]: connected(2) } })
    installApi(SERVERS, PLUGINS)
    await mount()

    const header = q('mcp-plugins-header')!
    expect(header.firstChild?.textContent).toBe('From plugins')
    expect(header.className.split(/\s+/)).toContain('uppercase')
    expect(q('mcp-plugins-count')!.textContent).toBe('2')
    expect(q('mcp-plugins-readonly')!.textContent).toBe('READ-ONLY')

    // Disabled plugins add nothing; sorted by plugin name.
    expect(pluginRowIds()).toEqual([LINEAR_ID, STRIPE_ID])
    expect(rowNames()).toEqual(['alpha', 'beta', 'delta', 'gamma'])
    expect(q(`mcp-plugin-row-${STRIPE_ID}`)!.querySelector('.font-mono')?.textContent).toBe('plugin')
    expect(q(`mcp-plugin-status-${STRIPE_ID}`)!.textContent).toBe('via the stripe plugin · connected · 2 tools')
    expect(q(`mcp-plugin-status-${LINEAR_ID}`)!.textContent).toBe('via the linear plugin · not checked')
    expect(q(`mcp-plugin-dot-${STRIPE_ID}`)!.dataset.status).toBe('connected')

    // The summary counts plugin servers, checked ones included.
    expect(q('extensions-toolbar-summary')!.textContent).toBe('6 servers · 1 checked')
    // The config server stays selected by default.
    expect(selectedRows()).toEqual(['alpha'])
  })

  it('has no FROM PLUGINS section in project scope or with no enabled plugin servers', async () => {
    installApi(SERVERS, [PLUGINS[2]])
    await mount()
    expect(q('mcp-plugins-header')).toBeNull()
    act(() => root?.unmount())
    container?.remove()

    const api = installApi(SERVERS, PLUGINS)
    useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
    await mount({ scope: 'project' })
    expect(q('mcp-plugins-header')).toBeNull()
    expect(api.plugins.list).not.toHaveBeenCalled()
  })

  it('opens a plugin server read-only: no Edit JSON, no + Add variable, no SaveBar — Check again checks it as source plugin with its plugin key', async () => {
    const api = installApi(SERVERS, PLUGINS)
    await mount()

    await click(q(`mcp-plugin-row-${STRIPE_ID}`))
    expect(q(`mcp-plugin-row-${STRIPE_ID}`)!.getAttribute('aria-current')).toBe('true')
    expect(selectedRows()).toEqual([])
    expect(detailName()).toBe('stripe')
    expect(q('mcp-detail-transport')!.textContent).toBe('plugin')
    expect(q('mcp-detail-plugin')!.textContent).toBe('via the stripe plugin')
    expect(q('mcp-detail-keypath')).toBeNull()
    expect(q('mcp-command')!.textContent).toBe('npx')
    expect(q('mcp-edit-json')).toBeNull()
    expect(q('mcp-edit-done')).toBeNull()
    expect(q('mcp-env')).toBeNull()
    expect(q('mcp-env-add')).toBeNull()
    expect(q('mcp-headers-add')).toBeNull()
    expect(saveButton()).toBeUndefined()
    expect(container!.textContent).not.toContain('Saved — matches')

    await click(q('mcp-check-again'))
    await flush()
    expect(api.mcp.checkServer).toHaveBeenCalledTimes(1)
    expect(api.mcp.checkServer).toHaveBeenCalledWith(stripeReq)
    expect(q('mcp-detail-status')!.dataset.status).toBe('failed')
    expect(q(`mcp-plugin-status-${STRIPE_ID}`)!.textContent).toBe('via the stripe plugin · failed')

    // Back to a config server: the editable detail and the SaveBar return.
    await click(q('mcp-row-beta'))
    expect(detailName()).toBe('beta')
    expect(q('mcp-edit-json')).not.toBeNull()
    expect(saveButton()).toBeDefined()
  })

  it('Check all includes the listed plugin servers and the "<m> checked" summary counts them', async () => {
    const api = installApi(SERVERS, PLUGINS)
    await mount()

    await click(q('mcp-check-all'))
    await flush()
    expect(api.mcp.checkServer).toHaveBeenCalledTimes(6)
    expect(api.mcp.checkServer).toHaveBeenCalledWith(stripeReq)
    expect(api.mcp.checkServer).toHaveBeenCalledWith(linearReq)
    expect(q('extensions-toolbar-summary')!.textContent).toBe('6 servers · 6 checked')
  })

  it('the filter narrows plugin rows and Check all to them too', async () => {
    const checkAll = vi.fn(async () => {})
    useMcpChecks.setState({ checkAll })
    installApi(SERVERS, PLUGINS)
    await mount()

    await typeInto(q('extensions-toolbar-filter') as HTMLInputElement, 'str')
    expect(rowNames()).toEqual([])
    expect(pluginRowIds()).toEqual([STRIPE_ID])
    // With no config row listed, the plugin row is the selected one.
    expect(detailName()).toBe('stripe')
    await click(q('mcp-check-all'))
    expect(checkAll).toHaveBeenCalledWith([stripeReq])
  })

  it('selects the first plugin server when the file has none of its own', async () => {
    installApi({}, PLUGINS)
    await mount()
    expect(container!.textContent).not.toContain('No MCP servers yet')
    expect(detailName()).toBe('linear')
    expect(q('mcp-detail-transport')!.textContent).toBe('plugin')
    expect(q('mcp-command')!.textContent).toBe('https://mcp.linear.app/mcp')
  })
})
