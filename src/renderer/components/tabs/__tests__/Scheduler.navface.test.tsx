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
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * Scheduler is two genuinely different screens split by navFace (see
 * lib/navGroups.ts's labelByFace and the module docstring in Scheduler.tsx):
 *   - Home face ("Scheduler Configs"): renders SessionManagerConfig's global
 *     policy/session-pool content — no PRDs, no project/all scope toggle.
 *   - Project face ("Epic's Execution Queue"): the Queue/PRDs/History
 *     workflow, with its own project/all scope toggle (an explicit
 *     machine-wide escape hatch), unchanged from before this split.
 */

// GlobalControlsSection (rendered inside SessionManagerConfig on the Home
// branch) pulls in a much larger IPC surface (config, homeDir, skills)
// unrelated to what these tests cover — stub it, same as
// SessionManagerConfig.test.tsx does.
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

beforeEach(() => {
  localStorage.clear()
  installWindowApiMock()
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
  useScheduleState.setState({ snapshot: null })
  usePromptSessions.setState({ sessions: {}, events: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('Scheduler Home face — Scheduler Configs', () => {
  it('renders global config content, not the PRD queue', async () => {
    const el = await mount()
    expect(el.textContent).toContain('Scheduler Configs')
    expect(el.textContent).toContain('Session pool')
    expect(el.textContent).toContain('Architecture summary')
  })

  it('has no project/all scope toggle on the Home face', async () => {
    const el = await mount()
    expect(el.querySelector('[data-testid="scheduler-scope-all"]')).toBeNull()
    expect(el.querySelector('[data-testid="scheduler-scope-project"]')).toBeNull()
  })
})

describe('Scheduler Project face — Epic\'s Execution Queue', () => {
  it('renders the PRD queue workflow with the scope toggle defaulted to project', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    expect(el.textContent).toContain("Epic's Execution Queue")
    const allBtn = el.querySelector('[data-testid="scheduler-scope-all"]') as HTMLButtonElement
    const projectBtn = el.querySelector('[data-testid="scheduler-scope-project"]') as HTMLButtonElement
    expect(projectBtn.className).toContain('border-accent/60')
    expect(allBtn.className).not.toContain('border-accent/60')
  })

  it('a manual scope toggle survives a re-render at the same navFace', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    const allBtn = el.querySelector('[data-testid="scheduler-scope-all"]') as HTMLButtonElement
    const projectBtn = el.querySelector('[data-testid="scheduler-scope-project"]') as HTMLButtonElement
    expect(projectBtn.className).toContain('border-accent/60')

    await act(async () => {
      allBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(allBtn.className).toContain('border-accent/60')
    expect(projectBtn.className).not.toContain('border-accent/60')

    // A re-render at the SAME navFace ('project') must not reset the manual choice.
    await act(async () => {
      useSessions.setState({ tabs: [{ ...ALPHA_TAB }], activeTabId: ALPHA_TAB.id })
      await Promise.resolve()
    })
    expect(allBtn.className).toContain('border-accent/60')
  })

  it('leaving the Project face and returning to Home swaps back to Scheduler Configs', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    expect(el.textContent).toContain("Epic's Execution Queue")

    await act(async () => {
      useLayout.setState({ navFace: 'home' })
      await Promise.resolve()
      await flushAsync()
    })
    expect(el.textContent).toContain('Scheduler Configs')
    expect(el.querySelector('[data-testid="scheduler-scope-project"]')).toBeNull()
  })
})
