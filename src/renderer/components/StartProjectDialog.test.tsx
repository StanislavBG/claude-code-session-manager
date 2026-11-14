// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('../lib/createPickedSession', () => ({
  openOrStartProject: vi.fn(),
  openProjectAt: vi.fn(),
  startNewProject: vi.fn(),
}))

import { StartProjectDialog } from './StartProjectDialog'
import { openOrStartProject, openProjectAt, startNewProject } from '../lib/createPickedSession'
import { usePendingRestore } from '../state/pendingRestore'
import { useToast } from '../state/toast'

let container: HTMLDivElement | null = null
let root: Root | null = null
const onClose = vi.fn()
const onOpened = vi.fn()
const pickDirectory = vi.fn()
const listRestorableRecent = vi.fn()

const ROW = {
  sessionId: 'sess-1',
  title: 'Fix the login bug',
  firstPrompt: 'please fix login',
  lastPrompt: null,
  gitBranch: 'main',
  headless: false,
  mtimeMs: Date.now() - 5 * 60_000,
  sizeBytes: 100,
  recentlyActive: false,
  cwd: '/home/u/Projects/alpha',
}

function q<T extends HTMLElement>(id: string): T {
  return document.querySelector(`[data-testid="${id}"]`) as T
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<StartProjectDialog open onClose={onClose} onOpened={onOpened} defaultParentDir="/work" />)
  })
}

async function typeName(value: string) {
  const input = q<HTMLInputElement>('start-project-name')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(id: string) {
  await act(async () => {
    q(id).click()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  listRestorableRecent.mockResolvedValue({ sessions: [], projectsRead: 0, truncated: false })
  ;(window as unknown as { api: unknown }).api = { app: { pickDirectory }, promptSessions: { listRestorableRecent } }
  usePendingRestore.setState({ pick: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('StartProjectDialog', () => {
  it('disables Create for a blank name', async () => {
    await mount()
    expect(q<HTMLButtonElement>('start-project-create').disabled).toBe(true)
    await typeName('   ')
    expect(q<HTMLButtonElement>('start-project-create').disabled).toBe(true)
  })

  it('creates with (parentDir, trimmed name) and fires onOpened on ok', async () => {
    vi.mocked(startNewProject).mockResolvedValue({ ok: true, path: '/work/foo' })
    await mount()
    await typeName('  foo ')
    expect(q('start-project-dialog').textContent).toContain('/work/foo')
    await click('start-project-create')
    expect(startNewProject).toHaveBeenCalledWith('/work', 'foo')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it("on 'exists' shows Open it which calls openProjectAt", async () => {
    vi.mocked(startNewProject).mockResolvedValue({ ok: false, code: 'exists', error: 'Already exists', path: '/work/foo' })
    await mount()
    await typeName('foo')
    await click('start-project-create')
    expect(q('start-project-error').textContent).toContain('Already exists')
    expect(onOpened).not.toHaveBeenCalled()
    const openIt = Array.from(q('start-project-error').querySelectorAll('button')).find((b) => b.textContent === 'Open it')!
    await act(async () => {
      openIt.click()
    })
    expect(openProjectAt).toHaveBeenCalledWith('/work/foo')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('Change… updates the parent dir', async () => {
    pickDirectory.mockResolvedValue('/other')
    await mount()
    await click('start-project-change-parent')
    expect(q('start-project-parent').textContent).toContain('/other')
  })

  it('Open existing calls openOrStartProject and reports onOpened on a non-null id', async () => {
    vi.mocked(openOrStartProject).mockResolvedValue('tab-1')
    await mount()
    await click('start-project-open-existing')
    expect(openOrStartProject).toHaveBeenCalledTimes(1)
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('Continue a session lists rows from listRestorableRecent and says where it continues', async () => {
    listRestorableRecent.mockResolvedValue({ sessions: [ROW], projectsRead: 1, truncated: false })
    await mount()
    expect(listRestorableRecent).toHaveBeenCalledWith({ limit: 30 })
    const row = q('start-project-recent-row-sess-1')
    expect(row).toBeTruthy()
    expect(row.textContent).toContain('Fix the login bug')
    expect(row.textContent).toContain('alpha')
    expect(row.textContent).toContain('/home/u/Projects/alpha')
    expect(row.textContent).toContain('ago')
    expect(q('start-project-recent').textContent).toMatch(/continues in the folder it was started in/i)
  })

  it('shows the empty state when there are no sessions', async () => {
    await mount()
    expect(q('start-project-recent-empty')).toBeTruthy()
  })

  it('choosing a row sets the pending pick, opens the project and closes', async () => {
    listRestorableRecent.mockResolvedValue({ sessions: [ROW], projectsRead: 1, truncated: false })
    await mount()
    await click('start-project-recent-row-sess-1')
    expect(usePendingRestore.getState().pick).toEqual({ cwd: ROW.cwd, session: ROW })
    expect(openProjectAt).toHaveBeenCalledWith('/home/u/Projects/alpha')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('an IPC error shows an error toast', async () => {
    const show = vi.spyOn(useToast.getState(), 'show')
    listRestorableRecent.mockRejectedValue(new Error('boom'))
    await mount()
    expect(show).toHaveBeenCalledWith('error', expect.stringContaining('boom'))
    show.mockRestore()
  })

  it('an { ok: false } result shows an error toast', async () => {
    const show = vi.spyOn(useToast.getState(), 'show')
    listRestorableRecent.mockResolvedValue({ ok: false, error: 'bad cwd' })
    await mount()
    expect(show).toHaveBeenCalledWith('error', expect.stringContaining('bad cwd'))
    show.mockRestore()
  })
})
