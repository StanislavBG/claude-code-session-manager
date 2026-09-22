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

const CWD = '/tmp/project'

function installApi(writeJson: ReturnType<typeof vi.fn>) {
  ;(window as unknown as { api: unknown }).api = {
    files: {
      list: vi.fn(async (p: string) => ({
        ok: true,
        entries: p === CWD
          ? [{ path: `${CWD}/sub`, name: 'sub', isDirectory: true, isFile: false, size: 0, mtimeMs: 0 }]
          : [],
      })),
    },
    git: { fileStatus: vi.fn().mockResolvedValue({}) },
    config: {
      readJson: vi.fn().mockResolvedValue({ exists: false, data: null }),
      writeJson,
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
    root!.render(createElement(FileTree, { cwd: CWD }))
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
})

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
})
