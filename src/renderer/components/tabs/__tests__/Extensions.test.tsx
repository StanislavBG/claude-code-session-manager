// @vitest-environment jsdom
import { createElement, type ComponentType } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Extensions } from '../Extensions'
import { McpServers } from '../McpServers'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { useConfig } from '../../../state/config'
import { HOME, PROJECT_CWD, PROJECT_TAB } from './_navfaceHarness'

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div'),
}))

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const SKILLS_DIR = `${HOME}/.claude/skills`
const COMMANDS_DIR = `${HOME}/.claude/commands`
const CLAUDE_JSON = `${HOME}/.claude.json`
const USER_SETTINGS = `${HOME}/.claude/settings.json`

function installApi() {
  const now = Date.now()
  // Files that exist on the fake disk. Absent here = missing (ENOENT): the skills dir
  // and ~/.claude/plugins/installed_plugins.json read "created on first save".
  const files: Record<string, { text: string; mtimeMs: number }> = {
    [`${COMMANDS_DIR}/refresh.md`]: { text: '# refresh\n', mtimeMs: now },
    [CLAUDE_JSON]: { text: '{}', mtimeMs: now - 15 * DAY - MINUTE }, // "15d ago"
    [USER_SETTINGS]: { text: '{}', mtimeMs: now - 3 * HOUR - 5 * MINUTE - 10_000 }, // "3h 5m ago"
  }
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      // One user command and no skills folder: the Skills count is 0 skills + 1 command.
      listDir: vi.fn(async (path: string) => ({
        ok: true,
        error: null,
        entries: path === COMMANDS_DIR
          ? [{ name: 'refresh.md', path: `${COMMANDS_DIR}/refresh.md`, isDirectory: false, isFile: true, mtimeMs: now, size: 10 }]
          : [],
      })),
      readText: vi.fn(async (path: string) => {
        const f = files[path]
        return f
          ? { text: f.text, exists: true, mtimeMs: f.mtimeMs, error: null }
          : { text: '', exists: false, mtimeMs: 0, error: null }
      }),
      exists: vi.fn(async (path: string) => path !== SKILLS_DIR),
      readJson: vi.fn().mockResolvedValue({ raw: '{"mcpServers":{"srv":{"command":"x"}}}', data: { mcpServers: { srv: { command: 'x' } } }, exists: true, mtimeMs: 1, parseError: null, error: null }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    claudeConfig: {
      // ~/.claude.json carries two servers (the MCP count); every settings file carries the
      // project-gating fixture the McpServers scope="project" case patches.
      read: vi.fn(async (input: { fileId: string }) => (input.fileId === 'claudeJson'
        ? { path: CLAUDE_JSON, data: { mcpServers: { srv: { command: 'x' }, two: { command: 'y' } } } }
        : { path: '', data: { disabledMcpjsonServers: ['old'] } })),
      patch: vi.fn().mockResolvedValue({ ok: true, path: '', data: {} }),
    },
    files: { delete: vi.fn() },
    mcp: { status: vi.fn().mockResolvedValue({ ok: true, error: null, servers: [] }) },
    plugins: {
      list: vi.fn().mockResolvedValue(['alpha', 'beta', 'gamma'].map((name, i) => ({
        key: `${name}@market`, name, marketplace: 'market', version: '1.0.0', scope: 'user', installPath: `/plugins/${name}`, enabled: i !== 1,
      }))),
    },
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

let container: HTMLDivElement
let root: Root
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}
/** Flushes until `ready()` holds (bounded) — the assertions after it report the real state. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 50 && !ready(); i++) await flush()
}
const btn = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement

const tabEls = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Extensions"] [role="tab"]'))
/** The folder tab's label is its first text node; the count is the mono span after it. */
const tabs = () => tabEls().map((t) => ({
  label: t.firstChild?.textContent ?? '',
  count: t.querySelector('[data-testid^="folder-tab-count-"]')?.textContent ?? null,
  selected: t.getAttribute('aria-selected') === 'true',
}))
const tab = (label: string) => tabEls().find((t) => t.firstChild?.textContent === label) as HTMLButtonElement
const selectedTab = () => tabs().find((t) => t.selected)?.label
const sourceEls = () => Array.from(container.querySelectorAll('[data-testid="extensions-source"]'))
const sources = () => sourceEls().map((e) => e.textContent)
const agesLoaded = () => sourceEls().length > 0 && sources().every((s) => !!s?.includes(' · '))

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

  it('renders Skills / MCP Servers / Plugins as folder tabs (role=tab) with their useExtensionCounts totals', async () => {
    await until(() => tabs().length === 3 && tabs().every((t) => t.count !== null))
    expect(tabs()).toEqual([
      { label: 'Skills', count: '1', selected: true },
      { label: 'MCP Servers', count: '2', selected: false },
      { label: 'Plugins', count: '3', selected: false },
    ])
    await act(async () => { tab('Plugins').click() }); await flush()
    expect(selectedTab()).toBe('Plugins')
  })

  it('lists the active tab’s sources as "<mono path> · <age>" in place of the SourceChip row', async () => {
    await until(agesLoaded)
    expect(sources()).toEqual(['~/.claude/skills · created on first save'])
    expect(sourceEls().map((e) => e.querySelector('.font-mono')?.textContent)).toEqual(['~/.claude/skills'])

    await act(async () => { tab('MCP Servers').click() }); await until(agesLoaded)
    expect(sources()).toEqual(['~/.claude.json › mcpServers · 15d ago'])

    await act(async () => { tab('Plugins').click() }); await until(agesLoaded)
    expect(sources()).toEqual([
      '~/.claude/plugins/installed_plugins.json · created on first save',
      '~/.claude/settings.json › enabledPlugins · 3h 5m ago',
    ])
    expect(sourceEls().map((e) => e.querySelector('.font-mono')?.textContent)).toEqual([
      '~/.claude/plugins/installed_plugins.json',
      '~/.claude/settings.json › enabledPlugins',
    ])
    expect(container.querySelector('[data-testid="source-chip"]')).toBeNull()
  })

  it('the tab row sits 24px down and overlaps, by 1px, the bordered panel that holds the tab body', async () => {
    const row = container.querySelector('[data-testid="extensions-tabs"]') as HTMLElement
    const panel = container.querySelector('[data-testid="extensions-panel"]') as HTMLElement
    expect(row?.querySelector('[role="tablist"][aria-label="Extensions"]')).not.toBeNull()
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(['mt-6', '-mb-px', 'relative']))
    expect(row.nextElementSibling).toBe(panel)
    expect(panel.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-1', 'min-h-0', 'border', 'border-line', 'bg-bg']))
    expect(panel.contains(btn('Add…'))).toBe(true)
  })

  it('openPanel with a tab pre-selects that tab (Command palette / deep-link path)', async () => {
    await act(async () => { useLayout.getState().openPanel('extensions', 'mcp') }); await flush()
    expect(selectedTab()).toBe('MCP Servers')
    await until(agesLoaded)
    expect(sources()).toEqual(['~/.claude.json › mcpServers · 15d ago'])
    expect(useLayout.getState().panelTabHint).toBeFalsy()
  })

  it('pages have no Library toggle; Add… opens the catalog drawer, and switching tabs closes it', async () => {
    expect(btn('Library')).toBeUndefined()
    expect(btn('Installed')).toBeUndefined()
    await act(async () => { btn('Add…').click() }); await flush()
    expect(document.querySelector('[data-testid="home-drawer"]')).not.toBeNull()
    await act(async () => { tab('MCP Servers').click() }); await flush()
    expect(document.querySelector('[data-testid="home-drawer"]')).toBeNull()
  })

  it('McpServers scope="project" prop patches disabledMcpjsonServers and enableAllProjectMcpServers on <cwd>/.claude/settings.json', async () => {
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      root.render(createElement(McpServers as ComponentType<{ scope?: 'user' | 'project' }>, { scope: 'project' }))
    })
    await flush()
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
