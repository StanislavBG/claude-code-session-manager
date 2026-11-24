// @vitest-environment jsdom
/**
 * ArtifactsSection — the File Explorer's per-project Artifacts list
 * (window.api.artifacts.list). Hidden with no artifacts, grouped by Epic
 * (newest group first, newest row first), a row click opens the stored file,
 * and the header reveals the store folder in the OS file manager.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ArtifactsSection, artifactPath } from '../ArtifactsSection'
import { useToast } from '../../../state/toast'
import { flushAsync } from '../../../testUtils/domFlush'
import type { ArtifactEntry } from '../../../../preload/api'

const CWD = '/home/u/proj'
const STORE = `${CWD}/session-manager-operations/artifacts`

const entry = (over: Partial<ArtifactEntry>): ArtifactEntry => ({
  name: 'a.txt',
  title: 'A',
  kind: 'doc',
  size: 2048,
  createdAt: '2026-11-01T00:00:00.000Z',
  producer: { epicId: 'e1', prdSlug: null, sessionId: null, taskId: null },
  ownerId: 'e1',
  epicTitle: 'Epic One',
  ...over,
})

const list = vi.fn()
const open = vi.fn()
let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  list.mockReset()
  open.mockReset()
  open.mockResolvedValue({ ok: true })
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  ;(window as unknown as { api: unknown }).api = {
    artifacts: { list, worktrees: vi.fn() },
    shell: { open },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

async function mount(onOpenFile = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<ArtifactsSection cwd={CWD} onOpenFile={onOpenFile} />))
  await flushAsync()
  return { c: container, onOpenFile }
}

describe('ArtifactsSection', () => {
  it('renders nothing when the project has no artifacts', async () => {
    list.mockResolvedValue({ ok: true, artifacts: [] })
    const { c } = await mount()
    expect(list).toHaveBeenCalledWith({ cwd: CWD })
    expect(c.querySelector('[data-testid="artifacts-section"]')).toBeNull()
    expect(c.innerHTML).toBe('')
  })

  it('groups rows by Epic title, newest group and newest row first', async () => {
    list.mockResolvedValue({
      ok: true,
      artifacts: [
        entry({ name: 'old-b.png', title: 'Old B', kind: 'image', ownerId: 'e2', epicTitle: 'Epic Two', createdAt: '2026-11-01T00:00:00.000Z' }),
        entry({ name: 'new-a.md', title: 'New A', ownerId: 'e1', epicTitle: 'Epic One', createdAt: '2026-11-03T00:00:00.000Z' }),
        entry({ name: 'mid-b.mp4', title: 'Mid B', kind: 'video', ownerId: 'e2', epicTitle: 'Epic Two', createdAt: '2026-11-02T00:00:00.000Z', producer: { epicId: 'e2', prdSlug: '4041-x', sessionId: null, taskId: null } }),
        entry({ name: 'old-a.md', title: 'Old A', ownerId: 'e1', epicTitle: 'Epic One', createdAt: '2026-10-01T00:00:00.000Z' }),
      ],
    })
    const { c } = await mount()
    const section = c.querySelector('[data-testid="artifacts-section"]')
    expect(section).not.toBeNull()
    const groups = Array.from(c.querySelectorAll<HTMLElement>('[data-testid="artifacts-group-title"]')).map((g) => g.textContent)
    expect(groups).toEqual(['Epic One', 'Epic Two'])
    const rows = Array.from(c.querySelectorAll<HTMLElement>('[data-testid="artifacts-row"]'))
    expect(rows.map((r) => r.dataset.path)).toEqual([
      `${STORE}/e1/new-a.md`,
      `${STORE}/e1/old-a.md`,
      `${STORE}/e2/mid-b.mp4`,
      `${STORE}/e2/old-b.png`,
    ])
    const mid = rows[2].textContent ?? ''
    expect(mid).toContain('Mid B')
    expect(mid).toContain('video')
    expect(mid).toContain('2.0 KB')
    expect(mid).toContain('4041-x')
  })

  it('opens a row through onOpenFile with the stored file path', async () => {
    list.mockResolvedValue({ ok: true, artifacts: [entry({ name: 'r.md', ownerId: 'e9' })] })
    const { c, onOpenFile } = await mount()
    const row = c.querySelector<HTMLElement>('[data-testid="artifacts-row"]')!
    act(() => row.click())
    expect(onOpenFile).toHaveBeenCalledWith(`${STORE}/e9/r.md`)
    expect(artifactPath(CWD, entry({ name: 'x.json', ownerId: '_tasks/t1' }))).toBe(`${STORE}/_tasks/t1/x.json`)
  })

  it('collapses the rows from the header', async () => {
    list.mockResolvedValue({ ok: true, artifacts: [entry({})] })
    const { c } = await mount()
    act(() => c.querySelector<HTMLElement>('[data-testid="artifacts-section-toggle"]')!.click())
    expect(c.querySelector('[data-testid="artifacts-row"]')).toBeNull()
    expect(c.querySelector('[data-testid="artifacts-section"]')).not.toBeNull()
  })

  it('reveals the store folder in the OS file manager and toasts on failure', async () => {
    list.mockResolvedValue({ ok: true, artifacts: [entry({})] })
    open.mockResolvedValue({ ok: false, error: 'EACCES' })
    const { c } = await mount()
    act(() => c.querySelector<HTMLElement>('[data-testid="artifacts-open-folder"]')!.click())
    await flushAsync()
    expect(open).toHaveBeenCalledWith({ as: 'revealPath', path: STORE })
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('EACCES'))).toBe(true)
  })

  it('refreshes every 5 s while visible and on window focus', async () => {
    vi.useFakeTimers()
    list.mockResolvedValue({ ok: true, artifacts: [] })
    await mount()
    expect(list).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(list).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('toasts when the list fails', async () => {
    list.mockResolvedValue({ ok: false, error: 'boom' })
    const { c } = await mount()
    expect(c.innerHTML).toBe('')
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('boom'))).toBe(true)
  })
})
