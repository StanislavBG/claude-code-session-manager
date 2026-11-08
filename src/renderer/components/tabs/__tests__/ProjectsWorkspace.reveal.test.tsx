// @vitest-environment jsdom
/**
 * "Reveal in File Explorer" through the page, with the real FileTree: a
 * `reveal:<path>` hint (lib/revealInFileExplorer.ts) makes ProjectsWorkspace
 * pick the File Explorer root that contains the path and FileTree select it.
 * A path outside every root falls back to the OS file manager — never a no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectsWorkspace } from '../ProjectsWorkspace'
import { useSessions } from '../../../state/sessions'
import { useLayout } from '../../../state/layout'
import { useToast } from '../../../state/toast'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import { flushAsync } from '../../../testUtils/domFlush'

vi.mock('../EditorView', () => ({
  EditorView: () => <div data-testid="editor-view-stub" />,
}))

vi.mock('../../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    projects: [],
    rows: [],
    enriched: {},
    loading: false,
    resolving: false,
    openProject: vi.fn(),
    openInSession: vi.fn(),
    archiveProject: vi.fn(),
    archiveProjectByCwd: vi.fn(),
  }),
}))

const HOME = '/home/testuser'
const PROJECT = `${HOME}/work/proj`
const SKILL = `${HOME}/.claude/skills/foo/SKILL.md`
const SETTINGS_PREFS = '~/.claude/session-manager/ui-settings-prefs.json'

// Folder → [name, isDirectory] rows.
const FS: Record<string, Array<[string, boolean]>> = {
  [HOME]: [['.claude', true], ['work', true]],
  [`${HOME}/.claude`]: [['skills', true]],
  [`${HOME}/.claude/skills`]: [['foo', true]],
  [`${HOME}/.claude/skills/foo`]: [['SKILL.md', false]],
  [`${HOME}/work`]: [['proj', true]],
  [PROJECT]: [['src', true], ['README.md', false]],
  [`${PROJECT}/src`]: [['main.ts', false]],
}

const list = vi.fn(async (dir: string, showHidden: boolean) => {
  const rows = FS[dir]
  if (!rows) return { ok: false, entries: [], error: 'ENOENT' }
  return {
    ok: true,
    entries: rows
      .filter(([name]) => showHidden || !name.startsWith('.'))
      .map(([name, isDirectory]) => ({ name, path: `${dir}/${name}`, isDirectory, isFile: !isDirectory, size: 0, mtimeMs: 0 })),
  }
})
const open = vi.fn()
const writeJson = vi.fn()
let settingsPrefs: Record<string, unknown> | null = null
const realScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

const projectTab = { id: 't1', cwd: PROJECT, label: 'proj', status: 'running', pid: 1 } as never

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  settingsPrefs = null
  open.mockReset()
  open.mockResolvedValue({ ok: true })
  writeJson.mockReset()
  writeJson.mockResolvedValue(undefined)
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  useSessions.setState({ tabs: [], activeTabId: null })
  useLayout.setState({ navFace: 'home', panelTabHint: null, focusedPanelId: 'overview' })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() })
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    files: { list },
    git: { fileStatus: vi.fn().mockResolvedValue({}) },
    shell: { open },
    config: {
      readJson: vi.fn(async (p: string) =>
        p === SETTINGS_PREFS && settingsPrefs ? { exists: true, data: settingsPrefs } : { exists: false, data: null }),
      writeJson,
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
  if (realScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', realScrollIntoView)
  else delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ProjectsWorkspace />))
  await flushAsync()
  return container
}

async function until(check: () => void) {
  await vi.waitFor(async () => { await flushAsync(); check() }, { timeout: 2000 })
}

const selectedPaths = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('[data-selected="true"]')).map((el) => el.dataset.path)

describe('ProjectsWorkspace reveal:<path> hint', () => {
  it('Home face: selects the path in the home-rooted tree and consumes the hint', async () => {
    revealInFileExplorer(SKILL)
    const c = await mount()

    await until(() => expect(selectedPaths(c)).toEqual([SKILL]))
    expect(useLayout.getState().panelTabHint).toBeNull()
    expect(useLayout.getState().navFace).toBe('home')
    expect(open).not.toHaveBeenCalled()
  })

  it('Project face: a hint arriving while mounted reveals inside the active project', async () => {
    useSessions.setState({ tabs: [projectTab], activeTabId: 't1' })
    useLayout.setState({ navFace: 'project' })
    const c = await mount()

    act(() => revealInFileExplorer(`${PROJECT}/src/main.ts`))

    await until(() => expect(selectedPaths(c)).toEqual([`${PROJECT}/src/main.ts`]))
    expect(useLayout.getState().navFace).toBe('project')
    expect(open).not.toHaveBeenCalled()
  })

  it('Project face: a path under home but outside the project switches to the home-rooted tree', async () => {
    useSessions.setState({ tabs: [projectTab], activeTabId: 't1' })
    useLayout.setState({ navFace: 'project' })
    revealInFileExplorer(SKILL)
    const c = await mount()

    await until(() => expect(selectedPaths(c)).toEqual([SKILL]))
    expect(useLayout.getState().navFace).toBe('home')
  })

  it('opens a collapsed file tree for the reveal without saving it as the layout', async () => {
    settingsPrefs = { projectsFileTreeCollapsed: true }
    const c = await mount()
    await until(() => expect(c.querySelector('[data-testid="projects-file-tree-rail-toggle"]')).not.toBeNull())

    act(() => revealInFileExplorer(SKILL))

    await until(() => expect(selectedPaths(c)).toEqual([SKILL]))
    expect(writeJson.mock.calls.some(([p]) => p === SETTINGS_PREFS)).toBe(false)
  })

  it('falls back to the OS file manager for a path outside every root', async () => {
    revealInFileExplorer('/etc/hosts')
    const c = await mount()

    await until(() => expect(open).toHaveBeenCalledWith({ as: 'revealPath', path: '/etc/hosts' }))
    expect(selectedPaths(c)).toEqual([])
  })

  it('toasts when the OS fallback fails, never silently doing nothing', async () => {
    open.mockResolvedValue({ ok: false, error: 'ENOENT' })
    revealInFileExplorer('/nope/x.md')
    await mount()

    await until(() => expect(
      useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('/nope/x.md')),
    ).toBe(true))
  })

  it('ignores any other hint', async () => {
    const c = await mount()
    act(() => useLayout.getState().openPanel('projects', 'not-a-reveal'))
    await flushAsync()

    expect(selectedPaths(c)).toEqual([])
    expect(open).not.toHaveBeenCalled()
    expect(c.querySelector('[data-testid="projects-file-tree-pane"]')).not.toBeNull()
  })
})
