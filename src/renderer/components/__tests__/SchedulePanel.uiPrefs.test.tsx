// @vitest-environment jsdom
/**
 * Regression coverage for PRD 1398: hiddenCompletedSlugs/queueFilterStatus
 * used to live in one machine-wide localStorage key, so two different
 * projects sharing the same PRD slug could hide or filter each other's
 * rows. They now live in the ACTIVE project's own ui-prefs/prefs.json
 * (lib/uiPrefs.ts) — this proves two cwds get independent state.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulePanel } from '../SchedulePanel'
import { useScheduleState } from '../../state/scheduleState'
import { useToast } from '../../state/toast'
import type { ScheduleStateSnapshot, ScheduleJob } from '../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

function job(over: Partial<ScheduleJob> = {}): ScheduleJob {
  const now = new Date()
  return {
    slug: '001-thing',
    title: 'Thing',
    status: 'completed',
    cwd: '/proj-a',
    startedAt: new Date(now.getTime() - 1000).toISOString(),
    finishedAt: now.toISOString(),
    ...over,
  } as ScheduleJob
}

function snapshot(jobs: ScheduleJob[]): ScheduleStateSnapshot {
  return {
    config: { firePolicy: 'when-available', supervisor: { enabled: false } },
    jobs,
    lastTick: null,
    scheduledFor: null,
    lastRunAt: null,
    nextReset: null,
    paused: null,
    utilization: null,
    effectiveConcurrency: { cap: 3, source: 'config' },
  } as unknown as ScheduleStateSnapshot
}

/** In-memory fake of the disk-backed config IPC, keyed by absolute path — mirrors
 *  what config:read-json/config:write-json actually persist. */
function installApi(store: Map<string, unknown>) {
  ;(globalThis as any).window.api = {
    schedule: {
      listPrds: async () => [],
      health: () => new Promise(() => {}),
      onState: () => () => {},
      setConfig: async () => ({ ok: true }),
      forceTick: async () => ({ ok: true }),
    },
    config: {
      readJson: vi.fn(async (path: string) => {
        const data = store.get(path)
        return data ? { exists: true, data } : { exists: false, data: null }
      }),
      writeJson: vi.fn(async (path: string, data: unknown) => {
        store.set(path, data)
        return { ok: true, mtimeMs: Date.now() }
      }),
    },
  }
}

beforeEach(() => {
  useScheduleState.setState({ snapshot: null, loaded: false })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (globalThis as any).window?.api
  vi.restoreAllMocks()
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('SchedulePanel ui-prefs per-project isolation', () => {
  it('clearing completed for one project does not hide the same slug in another', async () => {
    const store = new Map<string, unknown>()
    installApi(store)

    useScheduleState.setState({ snapshot: snapshot([job({ cwd: '/proj-a' })]), loaded: true })
    const c = mount(<SchedulePanel scopeCwd="/proj-a" planMode="list" />)
    await flush()

    const clearBtn = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Clear completed')
    expect(clearBtn).toBeTruthy()
    await act(async () => { clearBtn!.click() })
    await flush()

    await vi.waitFor(() => expect(store.get('/proj-a/session-manager-operations/ui-prefs/prefs.json')).toEqual(
      expect.objectContaining({ hiddenCompletedSlugs: ['001-thing'] }),
    ))
    // The row is now hidden in project A's own view.
    expect(c.textContent).not.toContain('Thing')

    // Switch the active project to B, which has a job with the SAME slug.
    // Project B's ui-prefs file was never written to, so its row must still
    // be visible — proving the two projects' hidden-slug state is independent.
    useScheduleState.setState({ snapshot: snapshot([job({ cwd: '/proj-b' })]), loaded: true })
    act(() => { root!.render(<SchedulePanel scopeCwd="/proj-b" planMode="list" />) })
    await flush()

    expect(c.textContent).toContain('Thing')
    expect(store.has('/proj-b/session-manager-operations/ui-prefs/prefs.json')).toBe(false)
  })

  it('clearing completed reverts and toasts when the write rejects', async () => {
    const store = new Map<string, unknown>()
    installApi(store)
    ;(globalThis as any).window.api.config.writeJson = vi.fn(async () => { throw new Error('boom') })
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })

    useScheduleState.setState({ snapshot: snapshot([job({ cwd: '/proj-a' })]), loaded: true })
    const c = mount(<SchedulePanel scopeCwd="/proj-a" planMode="list" />)
    await flush()

    const clearBtn = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Clear completed')
    expect(clearBtn).toBeTruthy()
    await act(async () => { clearBtn!.click() })
    await flush()

    // The optimistic hide is reverted once the write rejects — the row is
    // visible again — and the user is told, rather than the failure being
    // silently swallowed (CLAUDE.md: Toast is the user-facing error channel).
    await vi.waitFor(() => expect(c.textContent).toContain('Thing'))
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && /hidden completed/.test(t.message))).toBe(true)
  })

  it('a status filter chosen for one project is not applied to another', async () => {
    const store = new Map<string, unknown>()
    store.set('/proj-a/session-manager-operations/ui-prefs/prefs.json', { queueFilterStatus: 'failed' })
    installApi(store)

    useScheduleState.setState({ snapshot: snapshot([job({ cwd: '/proj-b', status: 'pending', finishedAt: undefined })]), loaded: true })
    mount(<SchedulePanel scopeCwd="/proj-b" planMode="list" />)
    await flush()

    // Project B never had a saved filter — it must read its OWN file, not
    // project A's, and project A's persisted 'failed' filter must never
    // leak into project B's in-memory state.
    expect((globalThis as any).window.api.config.readJson).toHaveBeenCalledWith(
      '/proj-b/session-manager-operations/ui-prefs/prefs.json',
    )
    expect((globalThis as any).window.api.config.readJson).not.toHaveBeenCalledWith(
      '/proj-a/session-manager-operations/ui-prefs/prefs.json',
    )
  })
})
