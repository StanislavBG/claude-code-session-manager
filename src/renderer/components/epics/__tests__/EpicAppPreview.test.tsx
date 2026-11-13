// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { AppPreviewState } from '../../../../preload/api'

/**
 * EpicAppPreview (app preview plan): Run preview → script picker → confirm →
 * starting/running controls → Open (system browser) / Stop. No webview.
 */

const toastError = vi.fn()
vi.mock('../../../state/toast', () => ({
  toast: { error: (m: string) => toastError(m), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}))

const SCRIPTS_OK = {
  ok: true as const,
  dir: '/repo/.worktrees/e1',
  inWorktree: true,
  scripts: [
    { name: 'build', command: 'vite build' },
    { name: 'dev', command: 'vite --port 5173' },
  ],
  suggested: 'dev' as string | null,
}

function previewState(over: Partial<AppPreviewState> = {}): AppPreviewState {
  return {
    epicId: 'e1',
    cwd: '/repo',
    dir: '/repo/.worktrees/e1',
    script: 'dev',
    command: 'vite --port 5173',
    port: 5173,
    url: 'http://localhost:5173',
    status: 'starting',
    error: null,
    pid: 123,
    startedAt: '2026-11-12T00:00:00.000Z',
    ...over,
  }
}

function installApi() {
  const api = {
    appPreview: {
      scripts: vi.fn().mockResolvedValue(SCRIPTS_OK),
      start: vi.fn().mockResolvedValue({ ok: true, state: previewState() }),
      stop: vi.fn().mockResolvedValue({ ok: true }),
      list: vi.fn().mockResolvedValue([]),
      onChanged: vi.fn(() => () => {}),
    },
    shell: { open: vi.fn().mockResolvedValue({ ok: true }) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let api: ReturnType<typeof installApi>
let EpicAppPreview: typeof import('../EpicAppPreview').EpicAppPreview
let useAppPreview: typeof import('../../../state/appPreview').useAppPreview

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(EpicAppPreview, { epicId: 'e1', cwd: '/repo' }))
  })
  return container
}

const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

async function click(id: string) {
  const el = q(id)
  expect(el).not.toBeNull()
  await act(async () => {
    el!.click()
  })
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('EpicAppPreview', () => {
  beforeEach(async () => {
    vi.resetModules()
    toastError.mockReset()
    api = installApi()
    ;({ EpicAppPreview } = await import('../EpicAppPreview'))
    ;({ useAppPreview } = await import('../../../state/appPreview'))
    useAppPreview.setState({ byEpic: {} })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('subscribes to the store on mount and shows Run preview with no preview', async () => {
    await mount()
    expect(api.appPreview.list).toHaveBeenCalled()
    expect(api.appPreview.onChanged).toHaveBeenCalled()
    expect(q('epic-preview-run')?.textContent).toBe('Run preview')
    expect(q('epic-preview-picker')).toBeNull()
    expect(container!.querySelector('webview, iframe')).toBeNull()
  })

  it('Run preview fetches scripts and opens the inline picker preselecting suggested', async () => {
    await mount()
    await click('epic-preview-run')
    await flush()
    expect(api.appPreview.scripts).toHaveBeenCalledWith({ cwd: '/repo', epicId: 'e1' })
    expect(q('epic-preview-picker')).not.toBeNull()
    const select = q('epic-preview-script') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['build', 'dev'])
    expect(select.value).toBe('dev')
    expect(q('epic-preview-command')?.tagName).toBe('CODE')
    expect(q('epic-preview-command')?.textContent).toBe('vite --port 5173')
    expect(q('epic-preview-picker')?.textContent).toContain('/repo/.worktrees/e1')
    expect(q('epic-preview-picker')?.textContent).not.toContain('not an isolated worktree')
    expect(q('epic-preview-run')).toBeNull()
    expect(container!.querySelector('[class*="z-"]')).toBeNull()
    // nothing starts before the confirm click
    expect(api.appPreview.start).not.toHaveBeenCalled()
  })

  it('preselects the first script without a suggestion and flags a non-worktree folder', async () => {
    api.appPreview.scripts.mockResolvedValue({ ...SCRIPTS_OK, inWorktree: false, dir: '/repo', suggested: null })
    await mount()
    await click('epic-preview-run')
    await flush()
    expect((q('epic-preview-script') as HTMLSelectElement).value).toBe('build')
    expect(q('epic-preview-command')?.textContent).toBe('vite build')
    expect(q('epic-preview-picker')?.textContent).toContain('not an isolated worktree')
  })

  it('changing the select updates the command shown', async () => {
    await mount()
    await click('epic-preview-run')
    await flush()
    const select = q('epic-preview-script') as HTMLSelectElement
    await act(async () => {
      select.value = 'build'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(q('epic-preview-command')?.textContent).toBe('vite build')
  })

  it('scripts { ok: false } toasts the error and opens no picker', async () => {
    api.appPreview.scripts.mockResolvedValue({ ok: false, error: 'No package.json' })
    await mount()
    await click('epic-preview-run')
    await flush()
    expect(toastError).toHaveBeenCalledWith('No package.json')
    expect(q('epic-preview-picker')).toBeNull()
  })

  it('a rejected scripts call is caught and toasted', async () => {
    api.appPreview.scripts.mockRejectedValue(new Error('ipc down'))
    await mount()
    await click('epic-preview-run')
    await flush()
    expect(toastError).toHaveBeenCalledWith('ipc down')
  })

  it('Cancel closes the picker without starting', async () => {
    await mount()
    await click('epic-preview-run')
    await flush()
    await click('epic-preview-cancel')
    expect(q('epic-preview-picker')).toBeNull()
    expect(q('epic-preview-run')).not.toBeNull()
    expect(api.appPreview.start).not.toHaveBeenCalled()
  })

  it('Run starts the selected script, closes the picker and upserts the state', async () => {
    await mount()
    await click('epic-preview-run')
    await flush()
    await click('epic-preview-confirm')
    await flush()
    expect(api.appPreview.start).toHaveBeenCalledWith({ cwd: '/repo', epicId: 'e1', script: 'dev' })
    expect(q('epic-preview-picker')).toBeNull()
    expect(useAppPreview.getState().byEpic.e1?.status).toBe('starting')
    expect(q('epic-preview-starting')).not.toBeNull()
  })

  it('start { ok: false } toasts the error', async () => {
    api.appPreview.start.mockResolvedValue({ ok: false, error: 'port busy' })
    await mount()
    await click('epic-preview-run')
    await flush()
    await click('epic-preview-confirm')
    await flush()
    expect(toastError).toHaveBeenCalledWith('port busy')
    expect(q('epic-preview-picker')).toBeNull()
    expect(useAppPreview.getState().byEpic.e1).toBeUndefined()
  })

  it('starting state shows a disabled Starting button and Stop', async () => {
    useAppPreview.setState({ byEpic: { e1: previewState({ status: 'starting' }) } })
    await mount()
    const starting = q('epic-preview-starting') as HTMLButtonElement
    expect(starting.disabled).toBe(true)
    expect(starting.textContent).toBe('Starting preview…')
    expect(q('epic-preview-stop')?.textContent).toBe('Stop preview')
    expect(q('epic-preview-run')).toBeNull()
    expect(q('epic-preview-open')).toBeNull()
  })

  it('running state Open calls shell.open external with the url', async () => {
    useAppPreview.setState({ byEpic: { e1: previewState({ status: 'running' }) } })
    await mount()
    expect(q('epic-preview-open')?.getAttribute('title')).toBe('http://localhost:5173')
    await click('epic-preview-open')
    await flush()
    expect(api.shell.open).toHaveBeenCalledWith({ as: 'external', url: 'http://localhost:5173' })
  })

  it('Stop calls appPreview.stop with the epicId', async () => {
    useAppPreview.setState({ byEpic: { e1: previewState({ status: 'running' }) } })
    await mount()
    await click('epic-preview-stop')
    await flush()
    expect(api.appPreview.stop).toHaveBeenCalledWith({ epicId: 'e1' })
  })

  it('rejected open and stop calls are toasted', async () => {
    api.shell.open.mockRejectedValue(new Error('no browser'))
    api.appPreview.stop.mockRejectedValue(new Error('kill failed'))
    useAppPreview.setState({ byEpic: { e1: previewState({ status: 'running' }) } })
    await mount()
    await click('epic-preview-open')
    await flush()
    expect(toastError).toHaveBeenCalledWith('no browser')
    await click('epic-preview-stop')
    await flush()
    expect(toastError).toHaveBeenCalledWith('kill failed')
  })

  it('failed and stopped states fall back to Run preview', async () => {
    useAppPreview.setState({ byEpic: { e1: previewState({ status: 'failed', error: 'boom' }) } })
    await mount()
    expect(q('epic-preview-run')).not.toBeNull()
    expect(q('epic-preview-stop')).toBeNull()
  })
})
