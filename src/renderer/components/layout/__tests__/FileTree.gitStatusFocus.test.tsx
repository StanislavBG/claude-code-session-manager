// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../FileTree'
import { PanelFocusProvider } from '../../../lib/panelFocus'
import { useLayout } from '../../../state/layout'

/**
 * Gating coverage (performance PRD, panel-focus timers): FileTree's 5s
 * git-status refresh must not keep spawning `git status` child processes
 * for a backgrounded-but-mounted panel (dockview's renderer:'always'), and
 * must catch up immediately the moment the panel regains focus rather than
 * waiting out the rest of the interval.
 */

const PANEL_ID = 'files-under-test'

function installWindowApiMock(fileStatus: ReturnType<typeof vi.fn>) {
  const api = {
    files: {
      list: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
    },
    git: { fileStatus },
  }
  ;(window as unknown as { api: typeof api }).api = api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(focused: boolean) {
  useLayout.setState({ focusedPanelId: focused ? PANEL_ID : 'somewhere-else' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        PanelFocusProvider,
        { panelId: PANEL_ID, children: createElement(FileTree, { cwd: '/tmp/project' }) },
      ),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
})

describe('FileTree git-status interval — panel-focus gating', () => {
  it('does not poll git status while the panel is unfocused', async () => {
    const fileStatus = vi.fn().mockResolvedValue({})
    installWindowApiMock(fileStatus)
    await mount(false)
    fileStatus.mockClear()

    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })

    expect(fileStatus).not.toHaveBeenCalled()
  })

  it('refreshes immediately on regaining focus, then resumes ticking', async () => {
    const fileStatus = vi.fn().mockResolvedValue({})
    installWindowApiMock(fileStatus)
    await mount(false)
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
