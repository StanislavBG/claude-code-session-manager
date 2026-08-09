// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useConfig } from '../../../state/config'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * System Prompt is a document SET — `~/.claude/CLAUDE.md` plus every file it
 * `@`-imports — rendered through the app's own document view, one document at
 * a time, with the imports editable rather than read-only peeks.
 *
 * The pane is stubbed (Monaco doesn't render in jsdom) so these assertions can
 * see which path the host handed it, what text, and whether it was read-only.
 */

vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: ({ path, value, readOnly, onChange }: any) =>
    createElement(
      'div',
      {
        'data-testid': 'document-editor-pane',
        'data-path': path,
        'data-readonly': String(!!readOnly),
        onClick: () => onChange(`${value}EDIT`),
      },
      value,
    ),
}))

const { SystemPrompt } = await import('../SystemPrompt')

const HOME = '/home/bilko'
const ROOT = `${HOME}/.claude/CLAUDE.md`
const CORE = `${HOME}/Projects/Agents/shared/core.md`
const GONE = `${HOME}/Projects/Agents/shared/gone.md`

const TEXT: Record<string, string> = {
  [ROOT]: '# root\n@' + CORE + '\n',
  [CORE]: '# core rules\n',
}

const IMPORTS = [
  { path: CORE, exists: true, ok: true, sizeBytes: 100, tokenEstimate: 25 },
  { path: GONE, exists: false, ok: false, sizeBytes: 0, tokenEstimate: 0 },
]

let writeText: ReturnType<typeof vi.fn>

function installWindowApiMock() {
  writeText = vi.fn().mockResolvedValue({ ok: true, mtimeMs: 1 })
  ;(window as any).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readText: vi.fn(async (p: string) => ({
        text: TEXT[p] ?? '', raw: TEXT[p] ?? '', exists: p in TEXT, mtimeMs: 0, error: null,
      })),
      readJson: vi.fn().mockResolvedValue({ raw: '{}', data: {}, exists: true, mtimeMs: 0, parseError: null, error: null }),
      writeText,
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      parseImports: vi.fn().mockResolvedValue({ ok: true, imports: IMPORTS, error: null }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(SystemPrompt))
    await flushAsync(3)
  })
  await act(async () => { await flushAsync(3) })
  return container
}

const pane = (el: HTMLElement) => el.querySelector('[data-testid="document-editor-pane"]') as HTMLElement
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="referenced-file-row"]')) as HTMLElement[]
const click = async (node: HTMLElement) => {
  await act(async () => { node.click(); await flushAsync(3) })
}

beforeEach(() => {
  installWindowApiMock()
  useConfig.setState({ files: {}, watchRefs: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as any).api
})

describe('SystemPrompt renders its document set through the shared document view', () => {
  it('opens the root CLAUDE.md in the document pane, with the import rail beside it', async () => {
    const el = await mount()
    expect(pane(el).getAttribute('data-path')).toBe(ROOT)
    expect(pane(el).getAttribute('data-readonly')).toBe('false')
    expect(el.querySelector('[data-testid="referenced-files-rail"]')).not.toBeNull()
    expect(rows(el)).toHaveLength(2)
  })

  it('selecting an import opens THAT file in the same pane, editable', async () => {
    const el = await mount()
    await click(rows(el)[0])

    expect(pane(el).getAttribute('data-path')).toBe(CORE)
    expect(pane(el).getAttribute('data-readonly')).toBe('false')
    expect(pane(el).textContent).toBe(TEXT[CORE])
    // The import is loaded and watched like any other edited file.
    expect((window as any).api.config.watch.mock.calls.flatMap((c: any[]) => c[0])).toContain(CORE)
  })

  it('saving while an import is open writes the IMPORT, not the root file', async () => {
    const el = await mount()
    await click(rows(el)[0])
    await click(pane(el)) // stub's onClick appends 'EDIT' to the buffer

    const save = Array.from(el.querySelectorAll('button')).find((b) => /save/i.test(b.textContent ?? ''))
    expect(save).toBeDefined()
    await click(save as HTMLElement)

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toBe(CORE)
    expect(String(writeText.mock.calls[0][1])).toContain('EDIT')
  })

  it('keeps an unsaved draft of the root file while an import is on screen', async () => {
    const el = await mount()
    await click(pane(el)) // dirty the root
    await click(rows(el)[0]) // detour to the import
    await click(el.querySelector('[data-testid="referenced-file-root"]') as HTMLElement)

    expect(pane(el).getAttribute('data-path')).toBe(ROOT)
    expect(pane(el).textContent).toContain('EDIT')
    expect(useConfig.getState().files[ROOT].dirty).toBe(true)
  })

  it('an unresolvable import is shown read-only, called out, and offers no save', async () => {
    const el = await mount()
    await click(rows(el)[1])

    expect(pane(el).getAttribute('data-path')).toBe(GONE)
    expect(pane(el).getAttribute('data-readonly')).toBe('true')
    expect(el.querySelector('[data-testid="system-prompt-missing-note"]')).not.toBeNull()
    expect(Array.from(el.querySelectorAll('button')).some((b) => /save/i.test(b.textContent ?? ''))).toBe(false)
  })
})
