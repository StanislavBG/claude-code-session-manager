// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useConfig } from '../../../state/config'
import { flushAsync } from '../../../testUtils/domFlush'

vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: ({ path, value, readOnly }: any) =>
    createElement('div', { 'data-testid': 'document-editor-pane', 'data-path': path, 'data-readonly': String(!!readOnly) }, value),
}))

const { SystemPrompt } = await import('../SystemPrompt')

const HOME = '/home/bilko'
const ROOT = `${HOME}/.claude/CLAUDE.md`
const INSIDE = `${HOME}/.claude/rules.md`
const OUTSIDE = '/opt/shared/outside.md'
const TEXT: Record<string, string> = { [ROOT]: '# root\n', [INSIDE]: 'in\n', [OUTSIDE]: 'out\n' }
const IMPORTS = [INSIDE, OUTSIDE].map((path) => ({ path, exists: true, ok: true, sizeBytes: 1, tokenEstimate: 1 }))

function installApi() {
  ;(window as any).api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readText: vi.fn(async (p: string) => ({ text: TEXT[p] ?? '', raw: TEXT[p] ?? '', exists: p in TEXT, mtimeMs: 0, error: null })),
      readJson: vi.fn().mockResolvedValue({ raw: '{}', data: {}, exists: true, mtimeMs: 0, parseError: null, error: null }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 1 }),
      writeJson: vi.fn(),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      canWrite: vi.fn(async (p: string) => p !== OUTSIDE),
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
  await act(async () => { root!.render(createElement(SystemPrompt)); await flushAsync(3) })
  await act(async () => { await flushAsync(3) })
  return container
}
const pane = (el: HTMLElement) => el.querySelector('[data-testid="document-editor-pane"]') as HTMLElement
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="referenced-file-row"]')) as HTMLElement[]
const click = async (n: HTMLElement) => { await act(async () => { n.click(); await flushAsync(5) }) }

beforeEach(() => { installApi(); useConfig.setState({ files: {}, watchRefs: {} }) })
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as any).api
})

describe('SystemPrompt imports outside the write boundary', () => {
  it('opens an unwritable import read-only with a note naming its path', async () => {
    const el = await mount()
    await click(rows(el)[1])
    expect(pane(el).getAttribute('data-path')).toBe(OUTSIDE)
    expect(pane(el).getAttribute('data-readonly')).toBe('true')
    expect(el.querySelector('[data-testid="system-prompt-readonly-note"]')?.textContent).toContain(OUTSIDE)
    expect(el.textContent).not.toContain('Save')
  })

  it('keeps a writable import editable with no note', async () => {
    const el = await mount()
    await click(rows(el)[0])
    expect(pane(el).getAttribute('data-path')).toBe(INSIDE)
    expect(pane(el).getAttribute('data-readonly')).toBe('false')
    expect(el.querySelector('[data-testid="system-prompt-readonly-note"]')).toBeNull()
  })
})
