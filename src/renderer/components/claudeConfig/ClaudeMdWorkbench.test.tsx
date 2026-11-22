// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useConfig } from '../../state/config'
import { flushAsync } from '../../testUtils/domFlush'

vi.mock('../tabs/editor/DocumentEditorPane', () => ({
  DocumentEditorPane: ({ path, value, defaultMode }: { path: string; value: string; defaultMode?: string }) =>
    createElement('div', { 'data-testid': 'document-editor-pane', 'data-path': path, 'data-mode': defaultMode }, value),
}))

const { ClaudeMdWorkbench } = await import('./ClaudeMdWorkbench')

const HOME = '/home/u'
const CWD = `${HOME}/Projects/alpha`
const MD = `${CWD}/CLAUDE.md`
const LOCAL = `${CWD}/CLAUDE.local.md`
const RULES = `${HOME}/shared/rules.md`

let disk: Record<string, string> = {}

function installApi() {
  ;(window as any).api = {
    config: {
      readText: vi.fn(async (p: string) => ({ text: disk[p] ?? '', raw: disk[p] ?? '', exists: p in disk, mtimeMs: 1, error: null })),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 2 }),
      canWrite: vi.fn().mockResolvedValue(true),
      parseImports: vi.fn(async (p: string) =>
        p === MD
          ? { ok: true, imports: [{ path: RULES, exists: true, ok: true, sizeBytes: 20, tokenEstimate: 5 }] }
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
  { path: MD, label: 'Project · in git', eyebrow: 'PROJECT INSTRUCTIONS' },
  { path: LOCAL, label: 'Local · this machine', eyebrow: 'LOCAL INSTRUCTIONS' },
]

async function mount(activeRoot = MD, onSelectRoot = vi.fn()) {
  await act(async () => {
    root.render(
      createElement(ClaudeMdWorkbench, {
        home: HOME,
        scope: 'project',
        roots,
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
const rowsText = () => Array.from(container.querySelectorAll('[role="radio"]')).map((r) => r.textContent ?? '')

beforeEach(() => {
  disk = {
    [MD]: '# alpha\n@../../shared/rules.md\nthird\n',
    [LOCAL]: 'one\ntwo\n',
    [RULES]: 'a\nb\nc\nd\n',
  }
  installApi()
  useConfig.setState({ files: {}, watchRefs: {} })
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
  it('lists each file and its resolved @imports with line counts, a token estimate and the load order', async () => {
    await mount()
    const rows = rowsText()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('CLAUDE.md')
    expect(rows[0]).toContain('3 lines')
    expect(rows[0]).toContain('Project · in git')
    expect(rows[1]).toContain('CLAUDE.local.md')
    expect(rows[1]).toContain('2 lines')
    expect(rows[2]).toContain('rules.md')
    expect(rows[2]).toContain('4 lines')
    expect(rows[2]).toContain('Imported · editable here')
    const card = q('claude-md-file-card')!
    expect(card.textContent).toContain('FILE + ITS IMPORTS')
    // chars/4 over the file + its imports: ceil(37/4) + ceil(8/4) = 10 + 2
    expect(card.textContent).toContain('~12 tokens')
    const loads = q('claude-md-session-loads')!.textContent ?? ''
    expect(loads).toContain('EVERY SESSION LOADS')
    expect(loads).toContain('~/.claude/CLAUDE.md')
    expect(loads).toContain('<project>/CLAUDE.md')
    expect(loads).toContain('<project>/CLAUDE.local.md')
    expect(pane()?.getAttribute('data-path')).toBe(MD)
    expect(pane()?.getAttribute('data-mode')).toBe('document')
    expect(q('config-detail-header')?.textContent).toContain('Loaded in every session')
  })

  it('selecting an import loads it in the editor', async () => {
    await mount()
    const importRow = Array.from(container.querySelectorAll('[role="radio"]'))[2] as HTMLElement
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

  it('a missing file shows the empty state, and Just start typing opens the editor', async () => {
    delete disk[MD]
    await mount()
    const empty = q('claude-md-empty')
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toContain('Nothing tells Claude how this repo works yet.')
    expect(pane()).toBeNull()
    expect(rowsText()[0]).toContain('missing')
    expect(q('config-detail-header')?.textContent).toContain('Not created')
    const start = Array.from(empty!.querySelectorAll('button')).find((b) => b.textContent === 'Just start typing')!
    await act(async () => { start.click() })
    expect(q('claude-md-empty')).toBeNull()
    expect(pane()?.getAttribute('data-path')).toBe(MD)
  })
})
