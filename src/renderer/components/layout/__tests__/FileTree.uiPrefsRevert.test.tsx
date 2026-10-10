// @vitest-environment jsdom
/**
 * PRD 1410: writeUiPrefsPatch call sites must revert their optimistic state
 * update and toast the user when the underlying write rejects, instead of
 * swallowing the error with a bare `.catch(() => {})`. This exercises
 * FileTree's expanded-folder persistence (fileTreeExpanded).
 */
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../FileTree'
import { useToast } from '../../../state/toast'
import { PanelFocusProvider } from '../../../lib/panelFocus'
import { useLayout } from '../../../state/layout'

const CWD = '/tmp/project'
const PANEL_ID = 'files-under-test'
const PREFS_PATH = '~/.claude/session-manager/ui-settings-prefs.json'

let changedListener: ((info: { path: string }) => void) | null = null
let rootEntries: string[] = []
const watch = vi.fn()
const unwatch = vi.fn()
const list = vi.fn()

const fileStatus = vi.fn()
const defaultReadJson = () => vi.fn().mockResolvedValue({ exists: false, data: null })

function installApi(
  writeJson: ReturnType<typeof vi.fn>,
  readJson: ReturnType<typeof vi.fn> = defaultReadJson(),
) {
  changedListener = null
  rootEntries = []
  watch.mockReset()
  unwatch.mockReset()
  list.mockReset()
  fileStatus.mockReset()
  fileStatus.mockResolvedValue({})
  list.mockImplementation(async (p: string) => ({
    ok: true,
    entries: p === CWD
      ? [
          { path: `${CWD}/sub`, name: 'sub', isDirectory: true, isFile: false, size: 0, mtimeMs: 0 },
          ...rootEntries.map((n) => ({ path: `${CWD}/${n}`, name: n, isDirectory: false, isFile: true, size: 0, mtimeMs: 0 })),
        ]
      : [],
  }))
  ;(window as unknown as { api: unknown }).api = {
    files: { list },
    git: { fileStatus },
    config: {
      readJson,
      writeJson,
      watch,
      unwatch,
      onChanged: vi.fn((cb: (info: { path: string }) => void) => {
        changedListener = cb
        return () => { changedListener = null }
      }),
    },
  }
}

const rootListCalls = () => list.mock.calls.filter((c) => c[0] === CWD).length

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(opts: { focused?: boolean } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree = createElement(FileTree, { cwd: CWD })
  await act(async () => {
    if (opts.focused === undefined) {
      root!.render(tree)
    } else {
      useLayout.setState({ focusedPanelId: opts.focused ? PANEL_ID : 'somewhere-else' })
      root!.render(createElement(PanelFocusProvider, { panelId: PANEL_ID, children: tree }))
    }
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
})

const hiddenToggle = (c: HTMLElement) =>
  c.querySelector('button[title="Hide hidden files"], button[title="Show hidden files"]') as HTMLButtonElement
const lastListHidden = () => list.mock.calls[list.mock.calls.length - 1][1]

describe('FileTree expanded-folder persistence — revert on rejected write', () => {
  it('reverts the expansion and toasts when writeUiPrefsPatch rejects', async () => {
    const writeJson = vi.fn(async () => { throw new Error('boom') })
    installApi(writeJson)
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })

    const c = await mount()
    const row = Array.from(c.querySelectorAll('span')).find((s) => s.textContent === 'sub')
    expect(row).toBeTruthy()
    const rowEl = row!.closest('div.group') as HTMLDivElement
    expect(rowEl).toBeTruthy()

    await act(async () => {
      rowEl.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    // The write rejected, so the folder must collapse back and the user must
    // be toasted — never a silently swallowed failure.
    await vi.waitFor(() => {
      expect(useToast.getState().toasts.some((t) => t.kind === 'error' && /folder expansion/.test(t.message))).toBe(true)
    })
  })

  it('re-lists the root on a config:changed event and shows the new file', async () => {
    installApi(vi.fn().mockResolvedValue(undefined))
    const c = await mount()
    expect(watch).toHaveBeenCalledWith([CWD], { depth: 0 })
    expect(Array.from(c.querySelectorAll('span')).some((s) => s.textContent === 'new.txt')).toBe(false)

    rootEntries = ['new.txt']
    await act(async () => { changedListener!({ path: CWD }) })
    await vi.waitFor(() => {
      expect(Array.from(c.querySelectorAll('span')).some((s) => s.textContent === 'new.txt')).toBe(true)
    })
  })

  it('debounces a burst of 100 events on one folder into a single list call', async () => {
    installApi(vi.fn().mockResolvedValue(undefined))
    await mount()
    const before = rootListCalls()
    await act(async () => {
      for (let i = 0; i < 100; i++) changedListener!({ path: CWD })
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 450)) })
    expect(rootListCalls() - before).toBe(1)
  })

  it('unwatches the same paths and opts on unmount', async () => {
    installApi(vi.fn().mockResolvedValue(undefined))
    await mount()
    act(() => root?.unmount())
    root = null
    expect(unwatch).toHaveBeenCalledWith([CWD], { depth: 0 })
  })
})

describe('FileTree git-status interval — panel-focus gating', () => {
  it('does not poll git status while the panel is unfocused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    installApi(vi.fn().mockResolvedValue(undefined))
    await mount({ focused: false })
    fileStatus.mockClear()

    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })

    expect(fileStatus).not.toHaveBeenCalled()
  })

  it('refreshes immediately on regaining focus, then resumes ticking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    installApi(vi.fn().mockResolvedValue(undefined))
    await mount({ focused: false })
    fileStatus.mockClear()

    await act(async () => {
      useLayout.setState({ focusedPanelId: PANEL_ID })
      await Promise.resolve()
    })
    expect(fileStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })
    expect(fileStatus).toHaveBeenCalledTimes(2)
  })
})

describe('FileTree hidden-files toggle — hydrate and persist', () => {
  it('defaults to showing hidden files when never set', async () => {
    installApi(vi.fn().mockResolvedValue(undefined))
    const c = await mount()
    expect(hiddenToggle(c).title).toBe('Hide hidden files')
    expect(lastListHidden()).toBe(true)
  })

  it.each([false, true])('honors an explicitly stored fileTreeShowHidden=%s', async (stored) => {
    installApi(
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue({ exists: true, data: { fileTreeShowHidden: stored } }),
    )
    const c = await mount()
    await vi.waitFor(() => {
      expect(hiddenToggle(c).title).toBe(stored ? 'Hide hidden files' : 'Show hidden files')
    })
    expect(lastListHidden()).toBe(stored)
  })

  it('persists a toggle through the machine-wide ui-settings-prefs file', async () => {
    const writeJson = vi.fn().mockResolvedValue(undefined)
    installApi(writeJson)
    const c = await mount()
    await act(async () => {
      hiddenToggle(c).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(writeJson).toHaveBeenCalledWith(
      PREFS_PATH,
      expect.objectContaining({ fileTreeShowHidden: false }),
    ))
  })
})
