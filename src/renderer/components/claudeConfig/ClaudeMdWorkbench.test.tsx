// @vitest-environment jsdom
import { createElement, Fragment } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useConfig } from '../../state/config'
import { flushAsync } from '../../testUtils/domFlush'
import { useConfigSearchFocus } from '../../state/configSearchFocus'
import { estimateTokens } from '../../lib/estimateTokens'

// Monaco / Tiptap don't render in jsdom: the pane is a stand-in showing its value (or the host's
// empty state in its place) plus the REAL EditorStatusBar driven by the props it is handed.
vi.mock('../tabs/editor/DocumentEditorPane', async () => {
  const { stubStatusBar } = await import('../tabs/__tests__/_docPaneStatusBar')
  return {
    DocumentEditorPane: (p: any) =>
      createElement(
        Fragment,
        null,
        createElement(
          'div',
          { 'data-testid': 'document-editor-pane', 'data-path': p.path, 'data-mode': p.defaultMode },
          p.emptyState ?? createElement('span', { 'data-testid': 'pane-text', onClick: () => p.onChange(`${p.value}EDIT`) }, p.value),
        ),
        stubStatusBar(p),
      ),
  }
})

const { ClaudeMdWorkbench } = await import('./ClaudeMdWorkbench')

const HOME = '/home/u'
const CWD = `${HOME}/Projects/alpha`
const MD = `${CWD}/CLAUDE.md`
const LOCAL = `${CWD}/CLAUDE.local.md`
const RULES = `${HOME}/shared/rules.md`
const GIT = `${CWD}/rules/git.md`

let disk: Record<string, string> = {}

function installApi() {
  ;(window as any).api = {
    config: {
      readText: vi.fn(async (p: string) => ({ text: disk[p] ?? '', raw: disk[p] ?? '', exists: p in disk, mtimeMs: 1, error: null })),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 2 }),
      canWrite: vi.fn().mockResolvedValue({ ok: true }),
      parseImports: vi.fn(async (p: string) =>
        p === MD
          ? {
              ok: true,
              imports: [
                { path: GIT, exists: true, ok: true, sizeBytes: 6, tokenEstimate: 2 },
                { path: RULES, exists: true, ok: true, sizeBytes: 20, tokenEstimate: 5 },
              ],
            }
          : { ok: true, imports: [] },
      ),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
}

let container: HTMLDivElement
let root: Root

const roots = [
  { path: MD, label: 'Project · shared via git', eyebrow: 'PROJECT INSTRUCTIONS' },
  { path: LOCAL, label: 'Local · this machine only', eyebrow: 'LOCAL INSTRUCTIONS' },
]

async function mount(activeRoot = MD, onSelectRoot = vi.fn(), scope: 'user' | 'project' = 'project') {
  await act(async () => {
    root.render(
      createElement(ClaudeMdWorkbench, {
        home: HOME,
        scope,
        roots: scope === 'user' ? [{ path: MD, label: 'User · every project on this machine', eyebrow: 'YOUR INSTRUCTIONS' }] : roots,
        activeRoot,
        onSelectRoot,
        empty: { title: 'Nothing tells Claude how this repo works yet.', body: 'It loads this file.' },
      }),
    )
  })
  await flushAsync(8)
  await flushAsync(8)
  return onSelectRoot
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const pane = () => q('document-editor-pane')
const all = (id: string) => Array.from(container.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[]
const rowsText = () => Array.from(container.querySelectorAll('[role="radio"]')).map((r) => r.textContent ?? '')

beforeEach(() => {
  disk = {
    [MD]: '# alpha\n@rules/git.md\n@../../shared/rules.md\n',
    [LOCAL]: 'one\ntwo\n',
    [RULES]: 'a\nb\nc\nd\n',
    [GIT]: 'x\ny\n',
  }
  installApi()
  useConfig.setState({ files: {}, watchRefs: {} })
  useConfigSearchFocus.getState().clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as any).api
})

describe('ClaudeMdWorkbench', () => {
  it('lists each file and its @imports (relative to the file) with line counts, a token estimate and the load order', async () => {
    await mount()
    const rows = rowsText()
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('CLAUDE.md')
    expect(rows[0]).toContain('3 lines')
    expect(rows[1]).toContain('CLAUDE.local.md')
    expect(rows[1]).toContain('2 lines')
    // Imports are named relative to the importing file's folder, not by basename.
    expect(rows[2]).toContain('rules/git.md')
    expect(rows[2]).toContain('2 lines')
    expect(rows[3]).toContain('../../shared/rules.md')
    expect(rows[3]).toContain('4 lines')
    expect(rows[3]).toContain('Imported · editable here')
    const card = q('claude-md-file-card')!
    const tokens = estimateTokens(disk[MD]) + estimateTokens(disk[GIT]) + estimateTokens(disk[RULES])
    expect(card.textContent).toContain(`~${tokens} tokens`)
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    expect(pane()?.getAttribute('data-mode')).toBe('document')
    expect(q('config-detail-header')?.textContent).toContain('Loaded in every session')
  })

  it('project scope uses the design copy: INSTRUCTIONS FILE, row subtitles, A SESSION HERE LOADS', async () => {
    delete disk[LOCAL]
    await mount()
    expect(q('claude-md-file-card')!.textContent).toContain('INSTRUCTIONS FILE')
    expect(q('claude-md-file-card')!.textContent).not.toContain('FILE + ITS IMPORTS')
    const rows = rowsText()
    expect(rows[0]).toContain('Project · shared via git')
    expect(rows[1]).toContain('Local · this machine only')
    const loads = q('claude-md-session-loads')!.textContent ?? ''
    expect(loads).toContain('A SESSION HERE LOADS')
    expect(loads).not.toContain('EVERY SESSION LOADS')
    expect(loads).toContain('~/.claude/CLAUDE.md')
    expect(loads).toContain('global · edited in Home')
    expect(loads).toContain('CLAUDE.mdthis file')
    expect(loads).toContain('CLAUDE.local.mdnot created')
    expect(loads).not.toContain('<project>')
  })

  it('user scope keeps FILE + ITS IMPORTS and EVERY SESSION LOADS', async () => {
    await mount(MD, vi.fn(), 'user')
    expect(q('claude-md-file-card')!.textContent).toContain('FILE + ITS IMPORTS')
    const loads = q('claude-md-session-loads')!.textContent ?? ''
    expect(loads).toContain('EVERY SESSION LOADS')
    expect(loads).toContain('this file · every project')
    expect(loads).toContain('<project>/CLAUDE.local.md')
  })

  it("shows ONE footer — the editor's status bar — with its save states, Save and Revert", async () => {
    await mount()
    expect(all('editor-status-bar')).toHaveLength(1)
    expect(q('savebar-clean')).toBeNull()
    expect(container.textContent).not.toContain(' chars · ')
    expect(q('editor-save-state')?.textContent).toBe('Saved · matches the file on disk')
    expect((q('editor-save') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { q('pane-text')!.click() })
    expect(q('editor-save-state')?.textContent).toBe('Unsaved changes')
    expect(all('editor-status-bar')).toHaveLength(1)
    await act(async () => { q('editor-save')!.click() })
    await flushAsync(8)
    expect((window as any).api.config.writeText).toHaveBeenCalledWith(MD, `${disk[MD]}EDIT`, undefined, undefined)
    expect(q('editor-save-state')?.textContent).toBe('Saved · matches the file on disk')

    await act(async () => { q('pane-text')!.click() })
    await act(async () => { q('editor-revert')!.click() })
    await flushAsync(8)
    expect(useConfig.getState().files[MD].dirty).toBe(false)
  })

  it('selecting an import loads it in the editor', async () => {
    await mount()
    const importRow = Array.from(container.querySelectorAll('[role="radio"]'))[3] as HTMLElement
    await act(async () => { importRow.click() })
    await flushAsync(8)
    expect(pane()?.getAttribute('data-path')).toBe(RULES)
    expect(pane()?.textContent).toBe(disk[RULES])
    expect(importRow.getAttribute('aria-checked')).toBe('true')
    expect(q('config-detail-header')?.textContent).toContain('rules.md')
  })

  it('selecting another root file asks the host to switch', async () => {
    const onSelectRoot = await mount()
    const localRow = Array.from(container.querySelectorAll('[role="radio"]'))[1] as HTMLElement
    await act(async () => { localRow.click() })
    expect(onSelectRoot).toHaveBeenCalledWith(LOCAL)
  })

  it('a missing file keeps the editor chrome with the empty state inside the document, and Create file  Ctrl S', async () => {
    delete disk[MD]
    await mount()
    const empty = q('claude-md-empty')
    expect(empty).not.toBeNull()
    expect(pane()?.contains(empty)).toBe(true)
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    expect(empty!.textContent).toContain('Nothing tells Claude how this repo works yet.')
    expect(empty!.textContent).toContain('It loads this file.')
    expect(container.textContent).not.toContain('/init')
    expect(all('editor-status-bar')).toHaveLength(1)
    expect(q('editor-save-state')?.textContent).toBe('New file · created on first save')
    expect(q('editor-save')?.textContent).toBe('Create fileCtrl S')
    expect(rowsText()[0]).toContain('missing')
    expect(q('config-detail-header')?.textContent).toContain('Not created')
    expect(q('claude-md-session-loads')!.textContent).toContain('this file · not created')
    const start = Array.from(empty!.querySelectorAll('button')).find((b) => b.textContent === 'Just start typing')!
    await act(async () => { start.click() })
    expect(q('claude-md-empty')).toBeNull()
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    expect(q('pane-text')).not.toBeNull()
    expect(q('editor-save')?.textContent).toBe('Create fileCtrl S')
  })
})

describe('ClaudeMdWorkbench write access (config:can-write)', () => {
  const api = () => (window as any).api.config
  // RULES (~/shared/rules.md — outside ~/.claude) is the last import row in either scope.
  const importRow = () => all('referenced-file-row').at(-1)!
  const readOnlyNote = () => q('claude-md-readonly-note')

  it('asks canWrite for the active root and for each import with importedBy = the root', async () => {
    await mount()
    expect(api().canWrite).toHaveBeenCalledWith(MD)
    expect(api().canWrite).toHaveBeenCalledWith(GIT, { importedBy: MD })
    expect(api().canWrite).toHaveBeenCalledWith(RULES, { importedBy: MD })
  })

  it('an import outside ~/.claude that main accepts opens editable and saves with importedBy', async () => {
    await mount(MD, vi.fn(), 'user')
    expect(importRow().textContent).toContain('Imported · editable here')
    await act(async () => { importRow().click() })
    await flushAsync(8)
    expect(pane()?.getAttribute('data-path')).toBe(RULES)
    expect(readOnlyNote()).toBeNull()
    await act(async () => { q('pane-text')!.click() })
    await act(async () => { q('editor-save')!.click() })
    await flushAsync(8)
    expect(api().writeText).toHaveBeenCalledWith(RULES, `${disk[RULES]}EDIT`, undefined, { importedBy: MD })
    expect(q('editor-save-state')?.textContent).toBe('Saved · matches the file on disk')
  })

  it('a sensitive import is read-only and says why', async () => {
    api().canWrite.mockImplementation(async (p: string) => (p === RULES ? { ok: false, reason: 'sensitive' } : { ok: true }))
    await mount()
    expect(importRow().textContent).toContain('Imported · read-only')
    expect(importRow().textContent).not.toContain('editable here')
    await act(async () => { importRow().click() })
    await flushAsync(8)
    expect(pane()?.getAttribute('data-path')).toBe(RULES)
    expect(readOnlyNote()?.textContent).toBe('Read-only: Session Manager never writes credential, SSH or autostart files.')
    expect(q('editor-save')).toBeNull()
    expect(container.textContent).not.toContain('outside the folders Session Manager may write to')
  })

  it.each([
    ['ops-root', 'Read-only: this file is inside session-manager-operations/, which only its owning writer may change.'],
    ['outside-boundary', 'Read-only: this file is outside your home folder and the projects open in Session Manager.'],
    ['not-imported', 'Read-only: this file is no longer imported by CLAUDE.md.'],
    ['permission', 'Read-only: your system does not allow writing this file.'],
  ])('reason %s gets its own sentence', async (reason, sentence) => {
    api().canWrite.mockImplementation(async (p: string) => (p === RULES ? { ok: false, reason } : { ok: true }))
    await mount()
    await act(async () => { importRow().click() })
    await flushAsync(8)
    expect(readOnlyNote()?.textContent).toBe(sentence)
  })

  it('a refused root opens read-only with the note', async () => {
    api().canWrite.mockImplementation(async (p: string) => (p === MD ? { ok: false, reason: 'permission' } : { ok: true }))
    await mount()
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    expect(readOnlyNote()?.textContent).toBe('Read-only: your system does not allow writing this file.')
    expect(q('editor-save')).toBeNull()
  })

  it('a Project CLAUDE.local.md root main accepts saves without importedBy', async () => {
    await mount(LOCAL)
    expect(api().canWrite).toHaveBeenCalledWith(LOCAL)
    expect(readOnlyNote()).toBeNull()
    await act(async () => { q('pane-text')!.click() })
    await act(async () => { q('editor-save')!.click() })
    await flushAsync(8)
    expect(api().writeText).toHaveBeenCalledWith(LOCAL, `${disk[LOCAL]}EDIT`, undefined, undefined)
  })
})

describe('ClaudeMdWorkbench config-search focus', () => {
  const pick = async (id: string) => {
    await act(async () => { useConfigSearchFocus.getState().set('claude-md', id) })
    await flushAsync(8)
  }
  const cleared = () => expect(useConfigSearchFocus.getState()).toMatchObject({ tab: null, id: null })

  it('selects the import a search result names, then clears the request', async () => {
    await mount()
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    await pick(`claude-md:${MD}>${RULES}`)
    expect(pane()?.getAttribute('data-path')).toBe(RULES)
    cleared()
  })

  it('switches to another root file, and opens its import once that root is active', async () => {
    const onSelectRoot = await mount(LOCAL)
    await pick(`claude-md:${LOCAL}`)
    expect(onSelectRoot).not.toHaveBeenCalled()
    cleared()

    await pick(`claude-md:${MD}>${RULES}`)
    expect(onSelectRoot).toHaveBeenCalledWith(MD)
    expect(useConfigSearchFocus.getState().id).toBe(`claude-md:${MD}>${RULES}`)
    await mount(MD, onSelectRoot)
    expect(pane()?.getAttribute('data-path')).toBe(RULES)
    cleared()
  })

  it('keeps the current document for an id that matches nothing, and still clears the request', async () => {
    await mount()
    await pick(`claude-md:${MD}>${HOME}/missing.md`)
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    cleared()
    await pick(`claude-md:${HOME}/elsewhere/CLAUDE.md`)
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    cleared()
  })
})
