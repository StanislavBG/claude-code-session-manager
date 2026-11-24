// @vitest-environment jsdom
/**
 * Project-face File Explorer root switcher: lists the project's active Epic
 * worktrees (artifacts:worktrees) so unmerged files can be reviewed before
 * merge. A worktree root is read-only — no create/rename/delete in the tree,
 * no saves in the editor, and a banner says so. 'Project' returns to the
 * project root.
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../editor/CodeEditorPane', () => ({
  CodeEditorPane: (p: { value: string; readOnly?: boolean; onChange: (t: string) => void; onSave: () => void }) =>
    createElement('div', { 'data-testid': 'code-pane', 'data-readonly': p.readOnly ? 'true' : 'false' },
      createElement('textarea', { 'data-testid': 'ta', value: p.value, onChange: (e: { target: { value: string } }) => p.onChange(e.target.value) }),
      createElement('button', { 'data-testid': 'save', onClick: p.onSave })),
}))
vi.mock('../editor/MarkdownPreview', () => ({ MarkdownPreview: () => null }))
vi.mock('../editor/MarkdownToolbar', () => ({ MarkdownToolbar: () => null }))
vi.mock('../editor/DocOutline', () => ({ DocOutline: () => null }))
vi.mock('../editor/EditorStatusBar', () => ({ EditorStatusBar: () => null }))
vi.mock('../editor/HtmlPreview', () => ({ HtmlPreview: () => null }))
vi.mock('../editor/ImagePane', () => ({ ImagePane: () => null }))
vi.mock('../editor/PdfPane', () => ({ PdfPane: () => null }))
vi.mock('../editor/TablePane', () => ({ TablePane: () => null }))
vi.mock('../editor/JsonlPane', () => ({ JsonlPane: () => null }))
vi.mock('../editor/BinaryPane', () => ({ BinaryPane: () => null }))
vi.mock('../editor/SelectionPopover', () => ({ SelectionPopover: () => null }))
vi.mock('../editor/AssistantRail', () => ({ AssistantRail: () => null }))
vi.mock('../editor/DocumentMenu', () => ({ DocumentMenu: () => createElement('div', { 'data-testid': 'document-menu' }) }))
vi.mock('../editor/DisplayPopover', () => ({ DisplayPopover: () => null }))
vi.mock('../editor/useDocEdit', () => ({
  useDocEdit: () => ({ state: { phase: 'idle' }, cancel: () => {}, select: () => {}, run: () => {}, listen: () => {}, sendHeard: () => {}, accept: () => ({ ok: false }), retry: () => {} }),
}))
vi.mock('../../../state/editor', async (orig) => ({ ...(await orig<typeof import('../../../state/editor')>()), hydrateEditorSession: async () => {} }))
vi.mock('../../layout/FileTabBar', () => ({ FileTabBar: () => null }))
vi.mock('../editor/TiptapBody', () => ({ TiptapBody: () => null }))
vi.mock('../ArtifactsSection', () => ({ ArtifactsSection: () => null }))
vi.mock('../../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    projects: [], rows: [], enriched: {}, loading: false, resolving: false,
    openProject: vi.fn(), openInSession: vi.fn(), archiveProject: vi.fn(), archiveProjectByCwd: vi.fn(),
  }),
}))

import { ProjectsWorkspace } from '../ProjectsWorkspace'
import { useSessions } from '../../../state/sessions'
import { useLayout } from '../../../state/layout'
import { useEditor } from '../../../state/editor'
import { useToast } from '../../../state/toast'
import { flushAsync } from '../../../testUtils/domFlush'

const HOME = '/home/testuser'
const PROJECT = `${HOME}/work/proj`
const WT = `${HOME}/.local/state/wt/epic-1`
const WT_FILE = `${WT}/notes.txt`

const FS: Record<string, Array<[string, boolean]>> = {
  [PROJECT]: [['src', true], ['README.md', false], ['todo.txt', false]],
  [WT]: [['notes.txt', false], ['draft', true]],
}

const list = vi.fn(async (dir: string) => {
  const rows = FS[dir]
  if (!rows) return { ok: false, entries: [], error: 'ENOENT' }
  return {
    ok: true,
    entries: rows.map(([name, isDirectory]) => ({ name, path: `${dir}/${name}`, isDirectory, isFile: !isDirectory, size: 0, mtimeMs: 0 })),
  }
})
const worktrees = vi.fn()
const write = vi.fn()

const projectTab = { id: 't1', cwd: PROJECT, label: 'proj', status: 'running', pid: 1 } as never

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  list.mockClear()
  write.mockReset()
  write.mockResolvedValue({ ok: true })
  worktrees.mockReset()
  worktrees.mockResolvedValue({
    ok: true,
    worktrees: [{ epicId: 'epic-1', title: 'Fix login', path: WT, branch: 'sm-epic/epic-1', aheadOfBase: 3, uncommitted: 4 }],
  })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  useSessions.setState({ tabs: [projectTab], activeTabId: 't1' })
  useLayout.setState({ navFace: 'project', panelTabHint: null, focusedPanelId: 'projects' })
  useEditor.setState({ openFiles: [], activeFilePath: null, buffers: {}, baselines: {}, dirty: {}, viewMode: {} } as never)
  ;(window as unknown as { api: unknown }).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    files: { list, write, read: vi.fn().mockResolvedValue({ ok: true, text: 'hello', binary: false }) },
    git: { fileStatus: vi.fn().mockResolvedValue({}) },
    shell: { open: vi.fn().mockResolvedValue({ ok: true }) },
    artifacts: { worktrees, list: vi.fn().mockResolvedValue({ ok: true, artifacts: [] }) },
    config: {
      readJson: vi.fn(async () => ({ exists: false, data: null })),
      writeJson: vi.fn().mockResolvedValue(undefined),
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

const switcher = (c: HTMLElement) => c.querySelector<HTMLSelectElement>('[data-testid="explorer-root-switcher"]')
const treeRowPaths = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('[data-testid="projects-file-tree-pane"] [data-path]')).map((el) => el.dataset.path)
const byTitle = (c: HTMLElement, title: string) => c.querySelector(`[data-testid="projects-file-tree-pane"] [title="${title}"]`)

function choose(c: HTMLElement, value: string) {
  const sel = switcher(c)!
  act(() => {
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('ProjectsWorkspace worktree root switcher', () => {
  it('lists the active Epic worktrees after Project', async () => {
    const c = await mount()
    await until(() => expect(switcher(c)).not.toBeNull())
    expect(worktrees).toHaveBeenCalledWith({ cwd: PROJECT })
    const options = Array.from(switcher(c)!.options).map((o) => o.textContent)
    expect(options).toEqual(['Project', 'Fix login — unmerged, 3 commits ahead, 4 uncommitted'])
    expect(switcher(c)!.value).toBe('')
  })

  it('labels omit a 0 or null count', async () => {
    worktrees.mockResolvedValue({
      ok: true,
      worktrees: [
        { epicId: 'e1', title: 'A', path: `${WT}-a`, branch: 'b1', aheadOfBase: 0, uncommitted: 7 },
        { epicId: 'e2', title: 'B', path: `${WT}-b`, branch: 'b2', aheadOfBase: 1, uncommitted: 0 },
        { epicId: 'e3', title: null, path: `${WT}-c`, branch: 'b3', aheadOfBase: null, uncommitted: null },
        { epicId: 'e4', title: 'D', path: `${WT}-d`, branch: 'b4', aheadOfBase: null, uncommitted: 1 },
      ],
    })
    const c = await mount()
    await until(() => expect(switcher(c)).not.toBeNull())
    expect(Array.from(switcher(c)!.options).map((o) => o.textContent)).toEqual([
      'Project',
      'A — unmerged, 7 uncommitted',
      'B — unmerged, 1 commit ahead',
      'e3 — unmerged',
      'D — unmerged, 1 uncommitted',
    ])
  })

  it('shows no switcher when there are no worktrees', async () => {
    worktrees.mockResolvedValue({ ok: true, worktrees: [] })
    const c = await mount()
    await until(() => expect(treeRowPaths(c)).toContain(`${PROJECT}/README.md`))
    expect(switcher(c)).toBeNull()
  })

  it('shows no switcher on the Home face', async () => {
    useLayout.setState({ navFace: 'home' })
    const c = await mount()
    await flushAsync()
    expect(switcher(c)).toBeNull()
  })

  it('roots the tree at the chosen worktree read-only, then Project returns to the project root', async () => {
    const c = await mount()
    await until(() => expect(treeRowPaths(c)).toContain(`${PROJECT}/README.md`))
    expect(byTitle(c, 'New file')).not.toBeNull()
    expect(c.querySelector('[data-testid="explorer-readonly-banner"]')).toBeNull()

    await until(() => expect(switcher(c)).not.toBeNull())
    choose(c, WT)

    await until(() => expect(treeRowPaths(c)).toContain(WT_FILE))
    expect(treeRowPaths(c)).not.toContain(`${PROJECT}/README.md`)
    expect(c.querySelector('[data-testid="explorer-readonly-banner"]')?.textContent).toBe('Unmerged worktree (read-only)')
    // Read-only tree: no create actions in the toolbar…
    expect(byTitle(c, 'New file')).toBeNull()
    expect(byTitle(c, 'New folder')).toBeNull()
    // …and no rename/delete/new in the row context menu.
    const row = c.querySelector<HTMLElement>(`[data-path="${WT}/draft"]`)!
    act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 })) })
    const menuLabels = Array.from(document.querySelectorAll('button')).map((b) => b.textContent)
    expect(menuLabels).toContain('Copy path')
    for (const label of ['Rename', 'Delete', 'New file', 'New folder']) expect(menuLabels).not.toContain(label)

    choose(c, '')
    await until(() => expect(treeRowPaths(c)).toContain(`${PROJECT}/README.md`))
    expect(c.querySelector('[data-testid="explorer-readonly-banner"]')).toBeNull()
    expect(byTitle(c, 'New file')).not.toBeNull()
  })

  it('a file opened from a worktree root is read-only in the editor and never saved', async () => {
    const c = await mount()
    await until(() => expect(switcher(c)).not.toBeNull())
    choose(c, WT)
    await until(() => expect(treeRowPaths(c)).toContain(WT_FILE))

    act(() => { c.querySelector<HTMLElement>(`[data-path="${WT_FILE}"]`)!.click() })
    await until(() => expect(c.querySelector('[data-testid="code-pane"]')).not.toBeNull())

    const editor = c.querySelector('[data-testid="projects-editor-pane"]')!
    expect(editor.querySelector('[data-testid="editor-readonly-banner"]')?.textContent).toBe('Unmerged worktree (read-only)')
    expect(editor.querySelector('[data-testid="code-pane"]')!.getAttribute('data-readonly')).toBe('true')
    expect(editor.querySelector('[data-testid="document-menu"]')).toBeNull()

    const ta = editor.querySelector('[data-testid="ta"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'edited')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { (editor.querySelector('[data-testid="save"]') as HTMLElement).click() })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    })
    await flushAsync()
    expect(write).not.toHaveBeenCalled()
    expect(useEditor.getState().dirty[WT_FILE]).toBeFalsy()
  })

  it('a project file stays editable and saves', async () => {
    const c = await mount()
    await until(() => expect(treeRowPaths(c)).toContain(`${PROJECT}/todo.txt`))
    act(() => { c.querySelector<HTMLElement>(`[data-path="${PROJECT}/todo.txt"]`)!.click() })
    await until(() => expect(c.querySelector('[data-testid="code-pane"]')).not.toBeNull())
    const editor = c.querySelector('[data-testid="projects-editor-pane"]')!
    expect(editor.querySelector('[data-testid="editor-readonly-banner"]')).toBeNull()
    expect(editor.querySelector('[data-testid="code-pane"]')!.getAttribute('data-readonly')).toBe('false')
    const ta = editor.querySelector('[data-testid="ta"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'edited')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { (editor.querySelector('[data-testid="save"]') as HTMLElement).click() })
    await flushAsync()
    expect(write).toHaveBeenCalledWith(`${PROJECT}/todo.txt`, 'edited')
  })
})
