// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { McpLibrary } from '../Library'
import { McpServers } from '../McpServers'
import { useConfig } from '../../../state/config'
import { useToast } from '../../../state/toast'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'

const HOME = '/home/bilko'
const CLAUDE_JSON = `${HOME}/.claude.json`

function installApi(stored: Record<string, unknown>) {
  const raw = JSON.stringify({ mcpServers: stored })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      readText: vi.fn().mockResolvedValue({ text: '', exists: false, mtimeMs: 0, error: null }),
      readJson: vi.fn().mockResolvedValue({ raw, data: JSON.parse(raw), exists: true, mtimeMs: 1, parseError: null, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    files: { delete: vi.fn().mockResolvedValue({ ok: true }) },
    mcp: { status: vi.fn().mockResolvedValue({ ok: true, error: null, servers: [] }) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(el: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(el)
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  return container
}

function flush() {
  return act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

function rowFor(el: HTMLElement, name: string): HTMLElement {
  const span = Array.from(el.querySelectorAll('span')).find((s) => s.textContent === name)
  return span!.closest('div.px-4') as HTMLElement
}

function buttonIn(el: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(b: HTMLElement) {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
  useConfig.setState({ files: {}, watchRefs: {} })
  useToast.setState({ toasts: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('McpLibrary install with placeholders', () => {
  it('does not write sqlite until <path> is filled, then writes the substituted args', async () => {
    const api = installApi({})
    const el = await mount(createElement(McpLibrary))
    await click(buttonIn(rowFor(el, 'SQLite'), 'install'))
    expect(api.config.writeJson).not.toHaveBeenCalled()

    const form = el.querySelector('[data-testid="mcp-placeholder-form"]') as HTMLElement
    expect(form.textContent).toContain('--db-path <path>')
    const confirm = buttonIn(form, 'install')
    expect(confirm.disabled).toBe(true)

    await type(form.querySelector('input[aria-label="<path>"]') as HTMLInputElement, '/tmp/x.db')
    expect(buttonIn(form, 'install').disabled).toBe(false)
    await click(buttonIn(form, 'install'))

    expect(api.config.writeJson).toHaveBeenCalledTimes(1)
    const [path, data] = api.config.writeJson.mock.calls[0]
    expect(path).toBe(CLAUDE_JSON)
    expect((data as { mcpServers: Record<string, { args: string[] }> }).mcpServers.sqlite.args).toEqual([
      'mcp-server-sqlite',
      '--db-path',
      '/tmp/x.db',
    ])
    expect(el.textContent).not.toContain('edit placeholders')
  })

  it('installs a placeholder-free entry immediately', async () => {
    const api = installApi({})
    const el = await mount(createElement(McpLibrary))
    await click(buttonIn(rowFor(el, 'Fetch'), 'install'))
    expect(api.config.writeJson).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[data-testid="mcp-placeholder-form"]')).toBeNull()
  })
})

describe('McpServers placeholder surfacing', () => {
  it('renders a warning badge for a stored --db-path <path> config', async () => {
    installApi({ sqlite: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '<path>'] }, fetch: { command: 'uvx', args: ['mcp-server-fetch'] } })
    const el = await mount(createElement(McpServers))
    const badges = Array.from(el.querySelectorAll('span')).filter((s) => s.hasAttribute('title') && s.textContent?.includes('unconfigured placeholder: <path>'))
    expect(badges).toHaveLength(1)
    expect(badges[0].getAttribute('title')).toContain(CLAUDE_JSON)
  })

  it('refuses to save a changed server that still has a placeholder, via error toast', async () => {
    const api = installApi({ fetch: { command: 'uvx', args: ['mcp-server-fetch'] } })
    const el = await mount(createElement(McpServers))
    await act(async () => {
      useConfig.getState().setDraft(
        CLAUDE_JSON,
        JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['x', '<path>'] } } }),
      )
    })
    await click(buttonIn(el, 'Save'))
    expect(api.config.writeJson).not.toHaveBeenCalled()
    const errs = useToast.getState().toasts.filter((t) => t.kind === 'error')
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toContain('<path>')
  })
})
