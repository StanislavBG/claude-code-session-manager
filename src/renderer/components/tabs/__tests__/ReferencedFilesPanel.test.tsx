// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ReferencedFilesPanel } from '../ReferencedFilesPanel'
import type { ImportRef } from '../../../../preload/api'

// MarkdownEditor wraps @monaco-editor/react, which doesn't render in jsdom —
// stub it with a plain element so the expanded-content assertions can look
// at the value/readOnly props without booting real Monaco.
vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, readOnly }: { value: string; readOnly?: boolean }) =>
    createElement('div', { 'data-testid': 'markdown-editor', 'data-readonly': String(!!readOnly) }, value),
}))

const toastError = vi.fn()
vi.mock('../../../state/toast', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}))

function installApi(overrides: { parseImports: any; readText: any }) {
  ;(globalThis as any).window.api = { config: overrides }
}

function ref(overrides: Partial<ImportRef> = {}): ImportRef {
  return {
    path: '/home/user/.claude/shared/core.md',
    exists: true,
    sizeBytes: 1234,
    tokenEstimate: 300,
    ok: true,
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(activePath: string | null) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(ReferencedFilesPanel, { activePath })))
  return container
}

function rerender(activePath: string | null) {
  act(() => root!.render(createElement(ReferencedFilesPanel, { activePath })))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ReferencedFilesPanel', () => {
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    toastError.mockClear()
  })

  it('renders zero DOM output when there are no imports', async () => {
    const parseImports = vi.fn().mockResolvedValue({ ok: true, imports: [] })
    installApi({ parseImports, readText: vi.fn() })

    const el = mount('/home/user/.claude/CLAUDE.md')
    await flush()

    expect(el.innerHTML).toBe('')
  })

  it('renders one row per ImportRef, flags missing/broken entries distinctly', async () => {
    const healthy = ref({ path: '/a/healthy.md' })
    const missing = ref({ path: '/a/missing.md', exists: false, ok: false })
    const parseImports = vi.fn().mockResolvedValue({ ok: true, imports: [healthy, missing] })
    installApi({ parseImports, readText: vi.fn() })

    const el = mount('/home/user/.claude/CLAUDE.md')
    await flush()

    const rows = el.querySelectorAll('[data-testid="referenced-file-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('[data-testid="referenced-file-missing"]')).toBeNull()
    expect(rows[1].querySelector('[data-testid="referenced-file-missing"]')).not.toBeNull()
  })

  it('clicking a row expands it and reads that file via config.readText; collapsing hides content without re-fetching', async () => {
    const healthy = ref({ path: '/a/healthy.md' })
    const parseImports = vi.fn().mockResolvedValue({ ok: true, imports: [healthy] })
    const readText = vi.fn().mockResolvedValue({ exists: true, text: 'hello world', mtimeMs: 0, error: null })
    installApi({ parseImports, readText })

    const el = mount('/home/user/.claude/CLAUDE.md')
    await flush()

    const row = el.querySelector('[data-testid="referenced-file-row"] button') as HTMLButtonElement
    act(() => row.click())
    await flush()

    expect(readText).toHaveBeenCalledWith('/a/healthy.md')
    expect(readText).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[data-testid="markdown-editor"]')?.textContent).toBe('hello world')
    expect(el.querySelector('[data-testid="markdown-editor"]')?.getAttribute('data-readonly')).toBe('true')

    // Collapse.
    act(() => row.click())
    await flush()
    expect(el.querySelector('[data-testid="markdown-editor"]')).toBeNull()

    // Re-expand within the same mount — no second fetch.
    act(() => row.click())
    await flush()
    expect(readText).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[data-testid="markdown-editor"]')?.textContent).toBe('hello world')
  })

  it('surfaces a parseImports failure via toast rather than throwing', async () => {
    const parseImports = vi.fn().mockResolvedValue({ ok: false, error: 'ipc boom' })
    installApi({ parseImports, readText: vi.fn() })

    const el = mount('/home/user/.claude/CLAUDE.md')
    await flush()

    expect(toastError).toHaveBeenCalledWith('ipc boom')
    expect(el.innerHTML).toBe('')
  })

  it('renders a readText failure inline instead of a blank expanded panel', async () => {
    const healthy = ref({ path: '/a/healthy.md' })
    const parseImports = vi.fn().mockResolvedValue({ ok: true, imports: [healthy] })
    const readText = vi.fn().mockResolvedValue({ exists: false, text: null, mtimeMs: 0, error: 'permission denied' })
    installApi({ parseImports, readText })

    const el = mount('/home/user/.claude/CLAUDE.md')
    await flush()

    const row = el.querySelector('[data-testid="referenced-file-row"] button') as HTMLButtonElement
    act(() => row.click())
    await flush()

    expect(el.querySelector('[data-testid="markdown-editor"]')).toBeNull()
    expect(el.textContent).toContain('permission denied')
  })

  it('does not resurrect a stale readText response after an A -> B -> A activePath round trip', async () => {
    const rowA = ref({ path: '/a/from-a.md' })
    const rowBackToA = ref({ path: '/a/from-a.md' })
    const parseImports = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, imports: [rowA] }) // initial mount on A
      .mockResolvedValueOnce({ ok: true, imports: [] }) // switch to B
      .mockResolvedValueOnce({ ok: true, imports: [rowBackToA] }) // switch back to A

    let resolveStaleReadText: (v: unknown) => void = () => {}
    const readText = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStaleReadText = resolve
        })
    )
    installApi({ parseImports, readText })

    const el = mount('/a/CLAUDE.md')
    await flush()

    // Expand the row on A — kicks off a readText() that we'll keep pending.
    const row = el.querySelector('[data-testid="referenced-file-row"] button') as HTMLButtonElement
    act(() => row.click())
    await flush()

    // Navigate away to B, then back to A, before the stale readText resolves.
    rerender('/b/CLAUDE.md')
    await flush()
    rerender('/a/CLAUDE.md')
    await flush()

    // Now the stale fetch from the first visit to A resolves.
    act(() => resolveStaleReadText({ exists: true, text: 'STALE CONTENT', mtimeMs: 0, error: null }))
    await flush()

    // The stale content must not appear anywhere in the freshly re-mounted A view.
    expect(el.textContent).not.toContain('STALE CONTENT')
  })
})
