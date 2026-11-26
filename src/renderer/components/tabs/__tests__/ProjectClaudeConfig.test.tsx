// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectClaudeConfig } from '../ProjectClaudeConfig'
import { renderScreenComponent } from '../../screenComponents'
import { getNavItemsForFace } from '../../../lib/navGroups'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { useConfig } from '../../../state/config'
import { useConfigSearchFocus } from '../../../state/configSearchFocus'
import { useMcpChecks } from '../../../state/mcpChecks'
import { HOME, PROJECT_CWD, PROJECT_TAB } from './_navfaceHarness'

vi.mock('../../VoiceButton', () => ({ VoiceButton: () => null }))
vi.mock('../Library', async (orig) => ({
  ...(await orig<typeof import('../Library')>()),
  McpLibrary: (p: { scope?: string; cwd?: string | null }) =>
    createElement('div', { 'data-testid': 'mcp-library', 'data-scope': p.scope, 'data-cwd': p.cwd ?? '' }),
}))
vi.mock('../home/HomeSessionDrawer', () => ({
  HomeSessionDrawer: (p: { open: boolean; title: string; children?: unknown }) =>
    p.open ? createElement('div', { 'data-testid': 'drawer', 'data-title': p.title }, p.children as never) : null,
}))
// Monaco-backed editors don't render in jsdom.
vi.mock('../../ui/MarkdownEditor', () => ({ MarkdownEditor: () => createElement('div') }))
vi.mock('../../ui/JsonEditor', () => ({ JsonEditor: () => createElement('div') }))
// The document pane is a stand-in that shows its value and can "type" one line.
vi.mock('../editor/DocumentEditorPane', async () => {
  const { stubStatusBar } = await import('./_docPaneStatusBar')
  return {
    DocumentEditorPane: (p: { path: string; value: string; onChange: (v: string) => void; emptyState?: unknown }) =>
      createElement(
        'div',
        { 'data-testid': 'doc-editor', 'data-path': p.path },
        createElement('pre', { 'data-testid': 'doc-editor-text' }, p.value),
        p.emptyState as never,
        createElement('button', { type: 'button', 'data-testid': 'doc-editor-type', onClick: () => p.onChange(`${p.value}edited\n`) }, 'type'),
        stubStatusBar(p),
      ),
  }
})

const SHORT = '~' + PROJECT_CWD.slice(HOME.length)
const MEM_DIR = `${HOME}/.claude/projects/${PROJECT_CWD.replace(/\//g, '-')}/memory`
const MD = `${PROJECT_CWD}/CLAUDE.md`
const LOCAL_MD = `${PROJECT_CWD}/CLAUDE.local.md`
const EPIC_CFG = 'session-manager-operations/prompt-sessions/epic-worktree-config.json'

/** Text files on "disk", keyed by absolute path; writeText bumps the mtime. */
let disk: Record<string, { text: string; mtimeMs: number }> = {}

function installApi() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readText: vi.fn(async (path: string) => {
        const f = disk[path]
        return f ? { text: f.text, exists: true, mtimeMs: f.mtimeMs, error: null } : { text: '', exists: false, mtimeMs: 0, error: null }
      }),
      writeText: vi.fn(async (path: string, text: string) => {
        disk[path] = { text, mtimeMs: (disk[path]?.mtimeMs ?? 0) + 1 }
        return { ok: true }
      }),
      readJson: vi.fn().mockResolvedValue({ raw: '{}\n', data: {}, exists: true, mtimeMs: 1, parseError: null, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      parseImports: vi.fn().mockResolvedValue({ ok: true, imports: [] }),
      canWrite: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    claudeConfig: {
      read: vi.fn().mockResolvedValue({ path: '', data: {} }),
      patch: vi.fn().mockResolvedValue({ ok: true, path: '', data: {} }),
    },
    memory: {
      list: vi.fn().mockResolvedValue({ entries: [], workspace: 'ws', dir: MEM_DIR, autoMemoryEnabled: true, error: null }),
      stale: vi.fn().mockResolvedValue({ entries: [], workspace: 'ws', error: null }),
      aggregate: vi.fn().mockResolvedValue({ workspace: 'ws', generatedAt: null, clusters: [], orphans: [], cached: true }),
      agents: vi.fn().mockResolvedValue({ agents: [] }),
      listArchived: vi.fn().mockResolvedValue({ names: [], error: null }),
      read: vi.fn().mockResolvedValue({ content: '', exists: false, mtimeMs: 0, bytes: 0, error: null }),
    },
    promptSessions: {
      getWorktreeDisabled: vi.fn().mockResolvedValue({ disabled: true }),
      setWorktreeDisabled: vi.fn(async ({ disabled }: { disabled: boolean }) => ({ disabled })),
    },
    mcp: { status: vi.fn().mockResolvedValue({ ok: true, error: null, servers: [] }) },
    files: { delete: vi.fn() },
    clipboard: { writeText: vi.fn(async () => ({ ok: true })) },
    shell: { open: vi.fn() },
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

let api: ReturnType<typeof installApi>
let container: HTMLDivElement
let root: Root

async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}
async function mount(node: ReactNode = createElement(ProjectClaudeConfig)) {
  await act(async () => { root.render(node) })
  await flush()
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const chips = () => Array.from(container.querySelectorAll('[data-testid="source-chip-path"]')).map((c) => c.textContent)
const tabLabel = (b: Element) => b.querySelector('span.font-semibold')?.textContent?.trim()
/** Clicks a rail tab. */
async function pick(label: string) {
  const railTabs = Array.from(q('config-rail')?.querySelectorAll('[role="tab"]') ?? []) as HTMLElement[]
  const b = railTabs.find((x) => tabLabel(x) === label)
  if (!b) throw new Error(`no rail tab "${label}"`)
  await act(async () => { b.click() })
  await flush()
}
/** Clicks the Local radio row in the active tab's left-column file card (CLAUDE.md or Settings). */
async function pickLocal() {
  const rows = Array.from(container.querySelectorAll('[role="radiogroup"] [role="radio"]')) as HTMLElement[]
  const b = q('settings-file-local') ?? rows.find((x) => x.textContent?.includes('CLAUDE.local.md'))
  if (!b) throw new Error('no Local radio row')
  await act(async () => { b.click() })
  await flush()
}
/** The document pane's status-bar Save (the CLAUDE.md tab's only footer). */
async function clickSave() {
  const b = q('editor-save')
  if (!b) throw new Error('no editor Save')
  await act(async () => { b.click() })
  await flush()
}
async function clickText(label: string) {
  const b = Array.from(container.querySelectorAll('button')).find((x) => x.textContent?.trim() === label)
  if (!b) throw new Error(`no button "${label}"`)
  await act(async () => { b.click() })
  await flush()
}

beforeEach(() => {
  disk = {
    [MD]: { text: '# alpha rules\n', mtimeMs: 10 },
    [LOCAL_MD]: { text: '# my local notes\n', mtimeMs: 10 },
  }
  api = installApi()
  localStorage.clear()
  useLayout.setState({ navFace: 'project' })
  useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
  useConfig.setState({ files: {}, watchRefs: {} })
  useConfigSearchFocus.getState().clear()
  useMcpChecks.setState({ results: {}, checking: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ProjectClaudeConfig', () => {
  it('is the memory NavKey screen: labeled Claude config, with a hint naming the project files', async () => {
    const item = getNavItemsForFace('project').find((i) => i.key === 'memory')
    expect(item?.label).toBe('Claude config')
    expect(item?.hint).toBe("This project's own files — CLAUDE.md, CLAUDE.local.md, settings, MCP, skills")
    await mount(renderScreenComponent('memory', {}))
    // The screen is lazy-loaded; give the chunk a few turns to resolve.
    for (let i = 0; i < 20 && !q('project-claude-config'); i++) await flush(1)
    expect(q('project-claude-config')).not.toBeNull()
    expect(q('config-rail')?.textContent).toContain('Claude config')
  })

  it('renders the rail over the project path with exactly Memory, CLAUDE.md, Settings, MCP, Skills and live counts', async () => {
    api.memory.list.mockResolvedValue({
      entries: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], workspace: 'ws', dir: MEM_DIR, autoMemoryEnabled: true, error: null,
    })
    api.config.exists.mockImplementation(async (p: string) => p === MD)
    api.config.readJson.mockImplementation(async (p: string) => {
      const data = p.endsWith('/.mcp.json') ? { mcpServers: { one: {}, two: {} } }
        : p.endsWith('/settings.json') ? { model: 'x', permissions: {} }
        : p.endsWith('/settings.local.json') ? { model: 'y', env: {} } : {}
      return { raw: JSON.stringify(data), data, exists: true, mtimeMs: 1, parseError: null, error: null }
    })
    api.config.listDir.mockImplementation(async (p: string) => ({
      ok: true, error: null,
      entries: p.endsWith('/.claude/commands') ? [{ name: 'go.md', isDir: false }, { name: 'x.txt', isDir: false }] : [],
    }))
    await mount()
    const rail = q('config-rail')!
    expect(rail.textContent).toContain('CLAUDE CODE · PROJECT')
    expect(rail.textContent).toContain('Claude config')
    expect(rail.textContent).toContain(SHORT)
    const tabs = Array.from(rail.querySelectorAll('[role="tab"]'))
    expect(tabs.map(tabLabel)).toEqual(['Memory', 'CLAUDE.md', 'Settings', 'MCP', 'Skills'])
    // Plugins and Agents are machine-wide: Home only.
    expect(q('config-rail-tab-plugins')).toBeNull()
    expect(q('config-rail-tab-agents')).toBeNull()
    expect(tabs.some((t) => /Plugins|Agents/.test(t.textContent ?? ''))).toBe(false)
    const countOf = (key: string) => q(`config-rail-tab-${key}`)?.querySelector('[data-testid="config-rail-count"]')?.textContent
    expect(countOf('memory')).toBe('3')
    expect(countOf('claude-md')).toBe('1 file')
    // The selected (Project) scope's .claude/settings.json sets two keys.
    expect(countOf('settings')).toBe('2')
    expect(countOf('mcp')).toBe('2')
    expect(countOf('skills')).toBe('1')
    // The old ViewTabs/SourceChip header row and the source strip under the rail are gone.
    expect(q('project-claude-config-toolbar')).toBeNull()
    expect(q('project-claude-config-source')).toBeNull()
  })

  it('LEARN toggles the learn panel open and closed', async () => {
    await mount()
    const press = () => clickText('LEARN')
    expect(q('project-claude-config-learn')).toBeNull()
    await press()
    expect(q('project-claude-config-learn')).not.toBeNull()
    await press()
    expect(q('project-claude-config-learn')).toBeNull()
  })

  it('MCP Add opens the drawer titled Add MCP server with the McpLibrary at project scope for the cwd', async () => {
    await mount()
    await pick('MCP')
    expect(q('drawer')).toBeNull()
    await act(async () => { q('mcp-add-server')!.click() })
    await act(async () => { q('mcp-browse-catalog')!.click() })
    await flush()
    expect(q('drawer')?.getAttribute('data-title')).toBe('Add MCP server')
    expect(q('mcp-library')?.getAttribute('data-scope')).toBe('project')
    expect(q('mcp-library')?.getAttribute('data-cwd')).toBe(PROJECT_CWD)
  })

  const countOf = (key: string) => q(`config-rail-tab-${key}`)?.querySelector('[data-testid="config-rail-count"]')?.textContent
  const dotOn = (key: string) => q(`config-rail-tab-${key}`)?.querySelector('[data-testid="config-rail-attention"]') != null

  it("CLAUDE.md counts each present file plus its resolved @-imports as 'N files'", async () => {
    api.config.parseImports.mockImplementation(async (p: string) => ({
      ok: true,
      imports: p === MD
        ? [
            { path: `${PROJECT_CWD}/docs/a.md`, exists: true, sizeBytes: 1, tokenEstimate: 0, ok: true },
            { path: `${PROJECT_CWD}/docs/gone.md`, exists: false, sizeBytes: 0, tokenEstimate: 0, ok: false },
          ]
        : [],
    }))
    await mount()
    // CLAUDE.md + docs/a.md + CLAUDE.local.md; the unresolved import is not counted.
    expect(countOf('claude-md')).toBe('3 files')
    expect(api.config.parseImports).toHaveBeenCalledWith(MD)
    expect(api.config.parseImports).toHaveBeenCalledWith(LOCAL_MD)
  })

  it('Settings counts the keys set in the selected settings file and follows the Project / Local choice', async () => {
    api.config.readJson.mockImplementation(async (p: string) => {
      const data = p.endsWith('/settings.json') ? { model: 'x' } : p.endsWith('/settings.local.json') ? { model: 'y', env: {}, hooks: {} } : {}
      return { raw: JSON.stringify(data), data, exists: true, mtimeMs: 1, parseError: null, error: null }
    })
    await mount()
    expect(countOf('settings')).toBe('1')
    await pick('Settings')
    await pickLocal()
    expect(countOf('settings')).toBe('3')
  })

  it('MCP gets the attention dot when a checked server failed or needs sign-in', async () => {
    await mount()
    expect(dotOn('mcp')).toBe(false)
    await act(async () => {
      useMcpChecks.setState({ results: { 'project:x:a': { ok: true, status: 'connected', tools: [], checkedAt: 1 } } })
    })
    expect(dotOn('mcp')).toBe(false)
    await act(async () => {
      useMcpChecks.setState({ results: { 'project:x:a': { ok: false, status: 'needs-auth', error: 'sign in', checkedAt: 1 } } })
    })
    expect(dotOn('mcp')).toBe(true)
    await act(async () => {
      useMcpChecks.setState({ results: { 'project:x:a': { ok: false, status: 'failed', error: 'boom', checkedAt: 1 } } })
    })
    expect(dotOn('mcp')).toBe(true)
  })

  it.each([
    ['stale', { stale: true }],
    ['broken', { deadRefs: ['src/gone.ts'] }],
  ] as const)('Memory gets the attention dot when a memory is %s', async (_kind, flags) => {
    api.memory.list.mockResolvedValue({
      entries: [{ name: 'a.md', path: `${MEM_DIR}/a.md`, bytes: 1, mtimeMs: 1 }], workspace: 'ws', dir: MEM_DIR, autoMemoryEnabled: true, error: null,
    })
    api.memory.stale.mockResolvedValue({
      entries: [{ name: 'a.md', stale: false, reasons: [], deadRefs: [], danglingLinks: [], outLinks: [], ...flags }],
      workspace: 'ws', error: null,
    })
    await mount()
    expect(dotOn('memory')).toBe(true)
  })

  it('Memory has no attention dot when every memory is fresh', async () => {
    api.memory.list.mockResolvedValue({
      entries: [{ name: 'a.md', path: `${MEM_DIR}/a.md`, bytes: 1, mtimeMs: 1 }], workspace: 'ws', dir: MEM_DIR, autoMemoryEnabled: true, error: null,
    })
    api.memory.stale.mockResolvedValue({
      entries: [{ name: 'a.md', stale: false, reasons: [], deadRefs: [], danglingLinks: [], outLinks: [] }], workspace: 'ws', error: null,
    })
    await mount()
    expect(dotOn('memory')).toBe(false)
  })

  it('marks CLAUDE.md missing when neither project file exists', async () => {
    api.config.exists.mockResolvedValue(false)
    await mount()
    expect(q('config-rail-tab-claude-md')?.querySelector('[data-testid="config-rail-count"]')?.textContent).toBe('missing')
  })

  it('mounts all five tabs with no source strip under the rail; radio rows own the Project / Local choice', async () => {
    await mount()
    const panel = (key: string) => q(`project-claude-config-panel-${key}`)
    const checked = () =>
      Array.from(container.querySelectorAll('[role="radio"][aria-checked="true"]')).map((x) => x.textContent ?? '')

    // Memory: today's MemoryExplorer, over this project's memory folder.
    expect(panel('memory')).not.toBeNull()
    expect(q('mx-list-folder-count')).not.toBeNull()
    expect(api.memory.list).toHaveBeenCalledWith(expect.objectContaining({ cwd: PROJECT_CWD }))
    expect(q('project-claude-config-source')).toBeNull()

    await pick('CLAUDE.md')
    expect(panel('claude-md')).not.toBeNull()
    expect(q('project-claude-config-source')).toBeNull()
    expect(q('claude-md-file-card')).not.toBeNull()
    expect(checked()).toEqual([expect.stringContaining('CLAUDE.md')])
    expect(q('doc-editor')?.dataset.path).toBe(MD)
    await pickLocal()
    expect(checked()).toEqual([expect.stringContaining('CLAUDE.local.md')])
    expect(q('doc-editor')?.dataset.path).toBe(LOCAL_MD)

    await pick('Settings')
    expect(panel('settings')).not.toBeNull()
    expect(q('project-claude-config-source')).toBeNull()
    expect(q('settings-file-project')?.getAttribute('aria-checked')).toBe('true')
    expect(chips()).toEqual([])
    await pickLocal()
    expect(q('settings-file-local')?.getAttribute('aria-checked')).toBe('true')
    expect(chips()).toEqual([])

    await pick('MCP')
    expect(panel('mcp')).not.toBeNull()
    expect(q('project-claude-config-source')).toBeNull()

    await pick('Skills')
    expect(panel('skills')).not.toBeNull()
    expect(q('project-claude-config-source')).toBeNull()
  })

  it('CLAUDE.md tab edits <cwd>/CLAUDE.md and CLAUDE.local.md through the config store', async () => {
    await mount()
    await pick('CLAUDE.md')
    expect(q('doc-editor')?.dataset.path).toBe(MD)
    expect(q('doc-editor-text')?.textContent).toBe('# alpha rules\n')
    // No explainer paragraph or file-age chip; Insert preset sits behind the header's ⋯.
    expect(q('project-claude-md')?.textContent).not.toContain('Project instructions')
    expect(q('project-claude-md')?.querySelector('[data-testid="source-chip-path"]')).toBeNull()
    expect(q('insert-preset-button')).toBeNull()
    await act(async () => { q('claude-md-more')!.click() })
    expect(q('claude-md-more-menu')?.querySelector('[data-testid="insert-preset-button"]')).not.toBeNull()
    await act(async () => { q('claude-md-more')!.click() })
    expect(container.querySelectorAll('[data-testid="editor-status-bar"]')).toHaveLength(1)

    await act(async () => { q('doc-editor-type')!.click() })
    await clickSave()
    expect(api.config.writeText).toHaveBeenCalledWith(MD, '# alpha rules\nedited\n', undefined, undefined)
    expect(disk[MD].text).toBe('# alpha rules\nedited\n')
    expect(useConfig.getState().files[MD]?.dirty).toBe(false)

    await pickLocal()
    expect(q('doc-editor')?.dataset.path).toBe(LOCAL_MD)
    expect(q('doc-editor-text')?.textContent).toBe('# my local notes\n')
    await act(async () => { q('doc-editor-type')!.click() })
    await clickSave()
    expect(disk[LOCAL_MD].text).toBe('# my local notes\nedited\n')
    expect(api.config.canWrite).toHaveBeenCalledWith(LOCAL_MD)
    expect(api.config.writeText).toHaveBeenCalledWith(LOCAL_MD, '# my local notes\nedited\n', undefined, undefined)
  })

  it('CLAUDE.md tab keeps the conflict check: a newer disk copy is not overwritten', async () => {
    await mount()
    await pick('CLAUDE.md')
    await act(async () => { q('doc-editor-type')!.click() })
    // Another editor wrote the file after this draft was loaded.
    disk[MD] = { text: '# rewritten elsewhere\n', mtimeMs: 50 }
    await clickSave()
    expect(api.config.writeText).not.toHaveBeenCalled()
    expect(disk[MD].text).toBe('# rewritten elsewhere\n')
    expect(q('project-claude-md')?.textContent).toContain('changed on disk')
    expect(useConfig.getState().files[MD]?.dirty).toBe(true)
  })

  it('Settings tab has no Epic isolation strip above the page; it is a rail entry naming its real file', async () => {
    await mount()
    await pick('Settings')
    expect(q('project-claude-config-epic-isolation')).toBeNull()
    expect(q('settings-epic-isolation')).toBeNull()
    expect(chips()).toEqual([])
    await act(async () => {
      q('settings-row-epic-isolation')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    const card = q('settings-epic-isolation')!
    expect(card.textContent).toContain(EPIC_CFG)
    expect(container.querySelectorAll('[data-testid="settings-epic-isolation"]')).toHaveLength(1)
    const sw = card.querySelector('[data-testid="settings-epic-isolation-toggle"] [role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(api.promptSessions.getWorktreeDisabled).toHaveBeenCalledWith({ cwd: PROJECT_CWD })
  })

  it('asks for a project tab when none is active', async () => {
    useSessions.setState({ tabs: [], activeTabId: null })
    await mount()
    expect(container.textContent).toContain('no active project')
    expect(q('config-rail')).toBeNull()
  })

  describe('Search all config', () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Search all config"]')!
    const key = (k: string) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
    async function focusAndType(value: string) {
      await act(async () => { input().focus() })
      await flush()
      act(() => {
        setter.call(input(), value)
        input().dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    it('loads this project\'s items on first focus and shows results grouped by tab', async () => {
      api.config.readJson.mockImplementation(async (p: string) => {
        const data = p.endsWith('/.mcp.json') ? { mcpServers: { 'model-srv': { command: 'npx' } } } : {}
        return { raw: JSON.stringify(data), data, exists: true, mtimeMs: 1, parseError: null, error: null }
      })
      await mount()
      expect(container.querySelector('[data-testid="config-search-panel"]')).toBeNull()
      await focusAndType('model')
      const groups = Array.from(container.querySelectorAll('[data-testid="config-search-group"]')).map((g) => g.textContent ?? '')
      expect(groups.map((g) => g.replace(/\d+$/, ''))).toEqual(['Settings', 'MCP'])
      const rows = container.querySelectorAll('[data-testid="config-search-panel"] [role="option"]')
      expect(rows.length).toBeGreaterThan(1)
      expect(rows.length).toBeLessThanOrEqual(10)
      expect(rows[0].textContent).toContain('model')
    })

    it('Enter on a result switches the tab and hands the item to it via configSearchFocus', async () => {
      const set = vi.spyOn(useConfigSearchFocus.getState(), 'set')
      await mount()
      await focusAndType('model')
      key('Enter')
      await flush()
      expect(q('project-claude-config-panel-settings')).not.toBeNull()
      expect(set).toHaveBeenCalledWith('settings', 'settings:model')
      // The Settings tab selected the item's group and consumed the request.
      expect(q('settings-detail-header')?.textContent).toContain('Essentials')
      expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })
      set.mockRestore()
      expect(input().value).toBe('')
    })

    it("'/' focuses the field and Esc clears it", async () => {
      await mount()
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })) })
      expect(document.activeElement).toBe(input())
      await focusAndType('zzzz')
      expect(q('config-search-panel')?.textContent).toContain('No matches')
      key('Escape')
      expect(input().value).toBe('')
      expect(q('config-search-panel')).toBeNull()
    })
  })
})
