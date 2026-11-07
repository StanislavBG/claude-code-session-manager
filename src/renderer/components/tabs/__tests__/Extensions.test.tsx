// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Extensions } from '../Extensions'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { useConfig } from '../../../state/config'
import { HOME, PROJECT_CWD, PROJECT_TAB } from './_navfaceHarness'

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div'),
}))

function installApi() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      readText: vi.fn().mockResolvedValue({ text: '', exists: false, mtimeMs: 0, error: null }),
      readJson: vi.fn().mockResolvedValue({ raw: '{"mcpServers":{"srv":{"command":"x"}}}', data: { mcpServers: { srv: { command: 'x' } } }, exists: true, mtimeMs: 1, parseError: null, error: null }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    claudeConfig: {
      read: vi.fn().mockResolvedValue({ path: '', data: { disabledMcpjsonServers: ['old'] } }),
      patch: vi.fn().mockResolvedValue({ ok: true, path: '', data: {} }),
    },
    files: { delete: vi.fn() },
    mcp: { status: vi.fn().mockResolvedValue({ ok: true, error: null, servers: [] }) },
    plugins: {},
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

let container: HTMLDivElement
let root: Root
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}
const btn = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement

describe('Extensions', () => {
  let api: ReturnType<typeof installApi>
  beforeEach(async () => {
    api = installApi()
    useLayout.setState({ navFace: 'home' })
    useSessions.setState({ tabs: [], activeTabId: null })
    useConfig.setState({ files: {}, watchRefs: {} })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(createElement(Extensions)) })
    await flush()
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('renders three tabs with the right SourceChip per tab', async () => {
    expect(['Skills', 'MCP Servers', 'Plugins'].every((l) => !!btn(l))).toBe(true)
    const chips = () => Array.from(container.querySelectorAll('[data-testid="source-chip-path"]')).map((e) => e.textContent)
    expect(chips()).toEqual(['~/.claude/skills'])
    await act(async () => { btn('MCP Servers').click() }); await flush()
    expect(chips()).toEqual(['~/.claude.json › mcpServers'])
    await act(async () => { btn('Plugins').click() }); await flush()
    expect(chips()).toEqual(['~/.claude/plugins/installed_plugins.json', '~/.claude/settings.json › enabledPlugins'])
  })

  it('pages have no Library toggle; Add… opens the catalog drawer', async () => {
    expect(btn('Library')).toBeUndefined()
    expect(btn('Installed')).toBeUndefined()
    await act(async () => { btn('Add…').click() }); await flush()
    expect(document.querySelector('[data-testid="home-drawer"]')).not.toBeNull()
  })

  it('MCP project scope patches disabledMcpjsonServers and enableAllProjectMcpServers on <cwd>/.claude/settings.json', async () => {
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      btn('MCP Servers').click()
    })
    await flush()
    await act(async () => { btn('Project').click() }); await flush()
    const target = { fileId: 'settings', scope: 'project', cwd: PROJECT_CWD }
    const gate = container.querySelector('[data-testid="mcp-gate-srv"]') as HTMLInputElement
    expect(gate).not.toBeNull()
    await act(async () => { gate.click() }); await flush()
    expect(api.claudeConfig.patch).toHaveBeenCalledWith({ ...target, keyPath: ['disabledMcpjsonServers'], value: ['old', 'srv'] })
    const all = container.querySelector('[data-testid="mcp-enable-all"]') as HTMLInputElement
    await act(async () => { all.click() }); await flush()
    expect(api.claudeConfig.patch).toHaveBeenCalledWith({ ...target, keyPath: ['enableAllProjectMcpServers'], value: true })
  })
})
