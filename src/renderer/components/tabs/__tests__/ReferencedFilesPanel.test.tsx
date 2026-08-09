// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ReferencedFilesPanel } from '../ReferencedFilesPanel'
import type { ImportRef } from '../../../../preload/api'
import { flushAsync } from '../../../testUtils/domFlush'

const toastError = vi.fn()
vi.mock('../../../state/toast', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}))

function installApi(overrides: { parseImports: any }) {
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

interface MountProps {
  activePath: string | null
  selectedPath?: string | null
  onSelect?: (r: ImportRef | null) => void
}

function render({ activePath, selectedPath = activePath, onSelect = () => {} }: MountProps) {
  act(() => root!.render(createElement(ReferencedFilesPanel, { activePath, selectedPath, onSelect })))
}

function mount(props: MountProps) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  render(props)
  return container
}

const flush = () => flushAsync(2)

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
    installApi({ parseImports })

    const el = mount({ activePath: '/home/user/.claude/CLAUDE.md' })
    await flush()

    expect(el.innerHTML).toBe('')
  })

  it('lists the root document plus one row per ImportRef, flagging missing entries', async () => {
    const healthy = ref({ path: '/a/healthy.md' })
    const missing = ref({ path: '/a/missing.md', exists: false, ok: false })
    installApi({ parseImports: vi.fn().mockResolvedValue({ ok: true, imports: [healthy, missing] }) })

    const el = mount({ activePath: '/a/CLAUDE.md' })
    await flush()

    expect(el.querySelector('[data-testid="referenced-file-root"]')?.textContent).toContain('CLAUDE.md')
    const rows = el.querySelectorAll('[data-testid="referenced-file-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('[data-testid="referenced-file-missing"]')).toBeNull()
    expect(rows[1].querySelector('[data-testid="referenced-file-missing"]')).not.toBeNull()
    // Weight is stated per row so the reader can see what each import costs.
    expect(rows[0].textContent).toContain('300')
  })

  it('is selection-only — clicking a row reports it upward and never reads the file itself', async () => {
    const healthy = ref({ path: '/a/healthy.md' })
    const parseImports = vi.fn().mockResolvedValue({ ok: true, imports: [healthy] })
    const readText = vi.fn()
    installApi({ parseImports, readText } as any)
    const onSelect = vi.fn()

    const el = mount({ activePath: '/a/CLAUDE.md', onSelect })
    await flush()

    const row = el.querySelector('[data-testid="referenced-file-row"]') as HTMLButtonElement
    act(() => row.click())
    expect(onSelect).toHaveBeenLastCalledWith(healthy)

    const rootRow = el.querySelector('[data-testid="referenced-file-root"]') as HTMLButtonElement
    act(() => rootRow.click())
    expect(onSelect).toHaveBeenLastCalledWith(null)

    // The rail never fetches content — the host's document view does.
    expect(readText).not.toHaveBeenCalled()
  })

  it('marks the selected row, defaulting to the root document', async () => {
    const healthy = ref({ path: '/a/healthy.md' })
    installApi({ parseImports: vi.fn().mockResolvedValue({ ok: true, imports: [healthy] }) })

    const el = mount({ activePath: '/a/CLAUDE.md' })
    await flush()
    expect(el.querySelector('[data-testid="referenced-file-root"]')?.getAttribute('aria-current')).toBe('true')

    render({ activePath: '/a/CLAUDE.md', selectedPath: '/a/healthy.md' })
    expect(el.querySelector('[data-testid="referenced-file-root"]')?.getAttribute('aria-current')).toBe('false')
    expect(el.querySelector('[data-testid="referenced-file-row"]')?.getAttribute('aria-current')).toBe('true')
  })

  it('resets the host back to the root document when the root file changes', async () => {
    const parseImports = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, imports: [ref({ path: '/a/one.md' })] })
      .mockResolvedValueOnce({ ok: true, imports: [ref({ path: '/b/two.md' })] })
    installApi({ parseImports })
    const onSelect = vi.fn()

    mount({ activePath: '/a/CLAUDE.md', onSelect })
    await flush()
    onSelect.mockClear()

    render({ activePath: '/b/CLAUDE.md', selectedPath: '/a/one.md', onSelect })
    await flush()

    // An import of the OLD root must not stay selected against the new one.
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('surfaces a parseImports failure via toast rather than throwing', async () => {
    installApi({ parseImports: vi.fn().mockResolvedValue({ ok: false, error: 'ipc boom' }) })

    const el = mount({ activePath: '/home/user/.claude/CLAUDE.md' })
    await flush()

    expect(toastError).toHaveBeenCalledWith('ipc boom')
    expect(el.innerHTML).toBe('')
  })

  it('does not resurrect a stale imports response after an A -> B -> A round trip', async () => {
    let resolveStale: (v: unknown) => void = () => {}
    const parseImports = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveStale = r })) // A, kept pending
      .mockResolvedValueOnce({ ok: true, imports: [] }) // B
      .mockResolvedValueOnce({ ok: true, imports: [ref({ path: '/a/fresh.md' })] }) // back to A
    installApi({ parseImports })

    const el = mount({ activePath: '/a/CLAUDE.md' })
    await flush()
    render({ activePath: '/b/CLAUDE.md' })
    await flush()
    render({ activePath: '/a/CLAUDE.md' })
    await flush()

    act(() => resolveStale({ ok: true, imports: [ref({ path: '/a/STALE.md' })] }))
    await flush()

    expect(el.textContent).not.toContain('STALE.md')
    expect(el.textContent).toContain('fresh.md')
  })
})
