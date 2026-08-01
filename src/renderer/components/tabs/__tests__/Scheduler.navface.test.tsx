// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Scheduler } from '../Scheduler'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useScheduleState } from '../../../state/scheduleState'
import { usePromptSessions } from '../../../state/promptSessions'

/**
 * Scheduler's project/all scope toggle defaults from the NavFace
 * (leftnav-two-face-framework): Home face -> all projects, Project face ->
 * the active tab's cwd. Mirrors the auto-default-unless-manually-touched
 * coverage in EpicsWorkspace.test.tsx's "NavFace-driven default project
 * filter" block.
 */

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
    schedule: {
      state: vi.fn().mockResolvedValue(null),
      health: vi.fn().mockResolvedValue({}),
      onState: vi.fn(() => () => {}),
      listPrds: vi.fn().mockResolvedValue([]),
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

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
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

describe('Scheduler NavFace-driven default scope', () => {
  it('mounts at navFace=home (overview panel) with scope defaulted to all projects', () => {
    const el = mount(<Scheduler />)
    const allBtn = el.querySelector('[data-testid="scheduler-scope-all"]') as HTMLButtonElement
    const projectBtn = el.querySelector('[data-testid="scheduler-scope-project"]') as HTMLButtonElement
    expect(allBtn.className).toContain('border-accent/60')
    expect(projectBtn.className).not.toContain('border-accent/60')
  })

  it('flipping navFace to project (with an active tab cwd) defaults scope to project', () => {
    const el = mount(<Scheduler />)
    act(() => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
    })
    const allBtn = el.querySelector('[data-testid="scheduler-scope-all"]') as HTMLButtonElement
    const projectBtn = el.querySelector('[data-testid="scheduler-scope-project"]') as HTMLButtonElement
    expect(projectBtn.className).toContain('border-accent/60')
    expect(allBtn.className).not.toContain('border-accent/60')
  })

  it('a manual scope toggle survives a re-render at the same navFace', () => {
    const el = mount(<Scheduler />)
    act(() => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
    })
    const allBtn = el.querySelector('[data-testid="scheduler-scope-all"]') as HTMLButtonElement
    const projectBtn = el.querySelector('[data-testid="scheduler-scope-project"]') as HTMLButtonElement

    // Auto-defaulted to 'project' by the face transition above.
    expect(projectBtn.className).toContain('border-accent/60')

    // Manual toggle back to 'all'.
    act(() => {
      allBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(allBtn.className).toContain('border-accent/60')
    expect(projectBtn.className).not.toContain('border-accent/60')

    // A re-render at the SAME navFace ('project') must not reset the manual choice.
    act(() => {
      useSessions.setState({ tabs: [{ ...ALPHA_TAB }], activeTabId: ALPHA_TAB.id })
    })
    expect(allBtn.className).toContain('border-accent/60')
  })

  it('a manual choice is consumed by the next transition, so the default re-applies on the one after', () => {
    const el = mount(<Scheduler />)
    const allBtn = el.querySelector('[data-testid="scheduler-scope-all"]') as HTMLButtonElement
    const projectBtn = el.querySelector('[data-testid="scheduler-scope-project"]') as HTMLButtonElement

    // Mounted at navFace=home -> defaults to 'all'. Manually pick 'project'.
    act(() => {
      projectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(projectBtn.className).toContain('border-accent/60')

    // Transition #1 (home -> project): the manual touch is consumed/ignored,
    // so scope stays 'project' (which happens to match the manual choice here).
    act(() => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
    })
    expect(projectBtn.className).toContain('border-accent/60')

    // Transition #2 (project -> home): the manual-touch flag was already
    // consumed by transition #1, so the navFace default re-applies here.
    act(() => {
      useLayout.setState({ navFace: 'home' })
    })
    expect(allBtn.className).toContain('border-accent/60')
    expect(projectBtn.className).not.toContain('border-accent/60')
  })
})
