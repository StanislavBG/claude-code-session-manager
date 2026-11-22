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
import { HOME, PROJECT_CWD, PROJECT_TAB } from './_navfaceHarness'

vi.mock('../../VoiceButton', () => ({ VoiceButton: () => null }))
// Monaco-backed editors don't render in jsdom.
vi.mock('../../ui/MarkdownEditor', () => ({ MarkdownEditor: () => createElement('div') }))
vi.mock('../../ui/JsonEditor', () => ({ JsonEditor: () => createElement('div') }))
// The document pane is a stand-in that shows its value and can "type" one line.
vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: { path: string; value: string; onChange: (v: string) => void }) =>
    createElement(
      'div',
      { 'data-testid': 'doc-editor', 'data-path': p.path },
      createElement('pre', { 'data-testid': 'doc-editor-text' }, p.value),
      createElement('button', { type: 'button', 'data-testid': 'doc-editor-type', onClick: () => p.onChange(`${p.value}edited\n`) }, 'type'),
    ),
}))

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
      canWrite: vi.fn().mockResolvedValue(true),
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
/** Clicks a ConfigBand tab. */
async function pick(label: string) {
  const band = Array.from(q('config-band')?.querySelectorAll('[role="tab"]') ?? []) as HTMLElement[]
  const b = band.find((x) => tabLabel(x) === label)
  if (!b) throw new Error(`no band tab "${label}"`)
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
    expect(container.querySelector('h1, h2')?.textContent).toBe('Claude config')
  })

  it('renders ConfigBand over the project path with exactly Memory, CLAUDE.md, Settings, MCP, Skills and live counts', async () => {
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
    const band = q('config-band')!
    expect(band.textContent).toContain('CLAUDE CODE · PROJECT')
    expect(band.textContent).toContain('Claude config')
    expect(band.textContent).toContain(SHORT)
    const tabs = Array.from(band.querySelectorAll('[role="tab"]'))
    expect(tabs.map(tabLabel)).toEqual(['Memory', 'CLAUDE.md', 'Settings', 'MCP', 'Skills'])
    // Plugins and Agents are machine-wide: Home only.
    expect(q('config-band-tab-plugins')).toBeNull()
    expect(q('config-band-tab-agents')).toBeNull()
    expect(tabs.some((t) => /Plugins|Agents/.test(t.textContent ?? ''))).toBe(false)
    const countOf = (key: string) => q(`config-band-tab-${key}`)?.querySelector('[data-testid="config-band-count"]')?.textContent
    expect(countOf('memory')).toBe('3')
    expect(countOf('claude-md')).toBe('1 file')
    expect(countOf('settings')).toBe('3')
    expect(countOf('mcp')).toBe('2')
    expect(countOf('skills')).toBe('1')
    // The old ViewTabs/SourceChip header row and the source strip under the band are gone.
    expect(q('project-claude-config-toolbar')).toBeNull()
    expect(q('project-claude-config-source')).toBeNull()
  })

  it('marks CLAUDE.md missing when neither project file exists', async () => {
    api.config.exists.mockResolvedValue(false)
    await mount()
    expect(q('config-band-tab-claude-md')?.querySelector('[data-testid="config-band-count"]')?.textContent).toBe('missing')
  })

  it('mounts all five tabs with no source strip under the band; radio rows own the Project / Local choice', async () => {
    await mount()
    const panel = (key: string) => q(`project-claude-config-panel-${key}`)
    const checked = () =>
      Array.from(container.querySelectorAll('[role="radio"][aria-checked="true"]')).map((x) => x.textContent ?? '')

    // Memory: today's MemoryExplorer, over this project's memory folder.
    expect(panel('memory')).not.toBeNull()
    expect(q('mx-nav-all')).not.toBeNull()
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
    expect(chips()).toEqual([`${SHORT}/${EPIC_CFG}`, `${SHORT}/.claude/settings.json`])
    await pickLocal()
    expect(q('settings-file-local')?.getAttribute('aria-checked')).toBe('true')
    expect(chips()).toEqual([`${SHORT}/${EPIC_CFG}`, `${SHORT}/.claude/settings.local.json`])

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

    await act(async () => { q('doc-editor-type')!.click() })
    await clickText('Save')
    expect(api.config.writeText).toHaveBeenCalledWith(MD, '# alpha rules\nedited\n')
    expect(disk[MD].text).toBe('# alpha rules\nedited\n')
    expect(useConfig.getState().files[MD]?.dirty).toBe(false)

    await pickLocal()
    expect(q('doc-editor')?.dataset.path).toBe(LOCAL_MD)
    expect(q('doc-editor-text')?.textContent).toBe('# my local notes\n')
    await act(async () => { q('doc-editor-type')!.click() })
    await clickText('Save')
    expect(disk[LOCAL_MD].text).toBe('# my local notes\nedited\n')
  })

  it('CLAUDE.md tab keeps the conflict check: a newer disk copy is not overwritten', async () => {
    await mount()
    await pick('CLAUDE.md')
    await act(async () => { q('doc-editor-type')!.click() })
    // Another editor wrote the file after this draft was loaded.
    disk[MD] = { text: '# rewritten elsewhere\n', mtimeMs: 50 }
    await clickText('Save')
    expect(api.config.writeText).not.toHaveBeenCalled()
    expect(disk[MD].text).toBe('# rewritten elsewhere\n')
    expect(q('project-claude-md')?.textContent).toContain('changed on disk')
    expect(useConfig.getState().files[MD]?.dirty).toBe(true)
  })

  it('Settings tab shows SettingsEpicIsolation once, under a SourceChip naming its real file', async () => {
    await mount()
    await pick('Settings')
    const section = q('project-claude-config-epic-isolation')
    expect(section).not.toBeNull()
    const chip = section!.querySelector('[data-testid="source-chip-path"]')!
    const card = section!.querySelector('[data-testid="settings-epic-isolation"]')!
    expect(chip.textContent).toBe(`${SHORT}/${EPIC_CFG}`)
    expect(chip.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="settings-epic-isolation"]')).toHaveLength(1)
    const box = card.querySelector('[data-testid="settings-epic-isolation-checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(api.promptSessions.getWorktreeDisabled).toHaveBeenCalledWith({ cwd: PROJECT_CWD })
    // Same section, still once, on the Local scope.
    await pickLocal()
    expect(container.querySelectorAll('[data-testid="settings-epic-isolation"]')).toHaveLength(1)
  })

  it('asks for a project tab when none is active', async () => {
    useSessions.setState({ tabs: [], activeTabId: null })
    await mount()
    expect(container.textContent).toContain('no active project')
    expect(q('config-band')).toBeNull()
  })
})
