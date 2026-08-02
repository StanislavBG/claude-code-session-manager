// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Scheduler } from '../Scheduler'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useScheduleState } from '../../../state/scheduleState'
import { usePromptSessions } from '../../../state/promptSessions'
import type { ScheduleStateSnapshot } from '../../../../preload/api'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * Scheduler is ONE combined screen on both sidebar faces (Home and Project)
 * — no fork on navFace (reverted from the short-lived Home/"Scheduler
 * Configs" vs Project/"Epic's Execution Queue" split, see Scheduler.tsx's
 * module docstring). Global Options (SessionManagerConfig) live on their own
 * "Machine" destination; Queue shows this project's live PRD monitoring
 * (SchedulePanel) — scoped to whichever tab is active, or every project if
 * none is.
 */

// GlobalControlsSection (rendered inside SessionManagerConfig) pulls in a
// much larger IPC surface (config, homeDir, skills) unrelated to what these
// tests cover — stub it, same as SessionManagerConfig.test.tsx does.
vi.mock('../GlobalControlsSection', () => ({
  GlobalControlsSection: () => createElement('div', { 'data-testid': 'global-controls-stub' }),
}))

const ALPHA_TAB: SessionTab = {
  id: 'tab-alpha',
  sessionId: 'tab-alpha',
  label: 'alpha',
  cwd: '/home/bilko/Projects/alpha',
  pid: null,
  status: 'dormant',
  exitCode: null,
  startupCommand: null,
  presetId: null,
  generation: 0,
}

function emptySnapshot(): ScheduleStateSnapshot {
  return {
    config: {
      enabled: true,
      offsetMinutes: 0,
      concurrencyCap: 3,
      defaultCwd: '/home/bilko',
      firePolicy: 'when-available',
      utilizationThreshold: 90,
      schemaVersion: 1,
    },
    jobs: [],
    scheduledFor: null,
    lastRunAt: null,
    nextReset: null,
    paused: null,
    utilization: null,
    pollHealth: undefined,
    effectiveConcurrency: { cap: 3, source: 'config' },
  } as ScheduleStateSnapshot
}

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/bilko') },
    config: {
      readJson: vi.fn().mockResolvedValue({ exists: false }),
      writeJson: vi.fn().mockResolvedValue(undefined),
    },
    schedule: {
      state: vi.fn().mockResolvedValue(null),
      health: vi.fn().mockResolvedValue({}),
      onState: vi.fn(() => () => {}),
      listPrds: vi.fn().mockResolvedValue([]),
      sessionSlots: vi.fn().mockResolvedValue({ total: 3, inUse: 0, holders: [] }),
      setConfig: vi.fn().mockResolvedValue(undefined),
    },
    supervisor: {
      getLog: vi.fn().mockResolvedValue([]),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Scheduler))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

// Global Options (SessionManagerConfig) now lives on its own "Machine"
// destination, a peer pill beside the Queue/PRDs/History segmented control
// — see Scheduler.tsx. Tests that assert on its content need to switch to it
// first.
async function openMachine(el: HTMLElement) {
  const toggle = Array.from(el.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Machine'),
  )
  if (!toggle) throw new Error('Machine toggle not found')
  await act(async () => {
    toggle.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  installWindowApiMock()
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
  useScheduleState.setState({ snapshot: emptySnapshot() })
  usePromptSessions.setState({ sessions: {}, events: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('Scheduler — one combined screen on both faces', () => {
  it('renders a single "Scheduler" title on the Home face, with Options and the PRD queue combined', async () => {
    const el = await mount()
    expect(el.textContent).toContain('Scheduler')
    expect(el.textContent).not.toContain('Scheduler Configs')
    expect(el.textContent).not.toContain("Epic's Execution Queue")
    await openMachine(el)
    expect(el.textContent).toContain('Session pool')
  })

  it('renders the same combined Options + Queue content on the Project face, force-scoped, with no scope toggle', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    expect(el.textContent).toContain('Scheduler')
    expect(el.textContent).not.toContain("Epic's Execution Queue")
    await openMachine(el)
    expect(el.textContent).toContain('Session pool')
    // No escape hatch — the toggle buttons don't exist at all.
    expect(el.querySelector('[data-testid="scheduler-scope-all"]')).toBeNull()
    expect(el.querySelector('[data-testid="scheduler-scope-project"]')).toBeNull()
  })

  it('flipping between faces does not change which screen renders', async () => {
    const el = await mount()
    await openMachine(el)
    expect(el.textContent).toContain('Session pool')
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
      await flushAsync()
    })
    expect(el.textContent).toContain('Session pool')
    await act(async () => {
      useLayout.setState({ navFace: 'home' })
      await Promise.resolve()
      await flushAsync()
    })
    expect(el.textContent).toContain('Session pool')
  })
})
