// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HistoryDashboard } from '../HistoryDashboard'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import type { HistoryDashboardProjectRow, HistoryDashboardResult, HistoryDashboardTotals } from '../../../../preload/api'

/**
 * History's project facet (`keep`, via `toggleProject`/`isolateProject`/
 * `showAll`) defaults from the NavFace (leftnav-two-face-framework): Home
 * face -> all projects shown, Project face -> the active tab's cwd isolated.
 * Mirrors Scheduler.navface.test.tsx's auto-default-unless-manually-touched
 * coverage.
 */

const ALPHA_CWD = '/home/bilko/Projects/alpha'
const BETA_CWD = '/home/bilko/Projects/beta'

const ALPHA_TAB: SessionTab = {
  id: 'tab-alpha',
  sessionId: 'tab-alpha',
  label: 'alpha',
  cwd: ALPHA_CWD,
  pid: null,
  status: 'dormant',
  exitCode: null,
  startupCommand: null,
  presetId: null,
  generation: 0,
}

function emptyTotals(): HistoryDashboardTotals {
  return {
    promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 0, sessionCount: 0, errorCount: 0, activeMinutes: 0, estimatedCostUsd: 0,
  }
}

function row(projectDir: string, date: string): HistoryDashboardProjectRow {
  return {
    ...emptyTotals(),
    promptCount: 5,
    estimatedCostUsd: 1.5,
    date,
    projectDir,
    toolBreakdown: {},
    byModel: {},
  }
}

function buildRaw(): HistoryDashboardResult {
  const date = '2026-07-30'
  return {
    from: date,
    to: date,
    days: [{ date, byProject: { [ALPHA_CWD]: row(ALPHA_CWD, date), [BETA_CWD]: row(BETA_CWD, date) } }],
    prevTotals: emptyTotals(),
    totals: emptyTotals(),
    byProjectTotals: { [ALPHA_CWD]: emptyTotals(), [BETA_CWD]: emptyTotals() },
    byModelTotals: {},
    toolsByProject: {},
    generatedAt: 0,
    provisionalDates: [],
  }
}

function installWindowApiMock() {
  const api = {
    history: {
      dashboard: vi.fn().mockResolvedValue(buildRaw()),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(el)
    await Promise.resolve()
  })
  return container
}

function isolateBtn(el: HTMLElement, cwd: string): HTMLButtonElement {
  return el.querySelector(`button[title="${cwd}"]`) as HTMLButtonElement
}

function showAllBtn(el: HTMLElement): HTMLButtonElement {
  return Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith('show all')) as HTMLButtonElement
}

function isIsolatedTo(el: HTMLElement, cwd: string): boolean {
  const alphaActive = isolateBtn(el, ALPHA_CWD).className.includes('opacity-40') === false
  const betaActive = isolateBtn(el, BETA_CWD).className.includes('opacity-40') === false
  if (cwd === ALPHA_CWD) return alphaActive && !betaActive
  return betaActive && !alphaActive
}

function isShowingAll(el: HTMLElement): boolean {
  const alphaActive = isolateBtn(el, ALPHA_CWD).className.includes('opacity-40') === false
  const betaActive = isolateBtn(el, BETA_CWD).className.includes('opacity-40') === false
  return alphaActive && betaActive
}

beforeEach(() => {
  localStorage.clear()
  installWindowApiMock()
  useLayout.setState({ focusedPanelId: 'overview' })
  useSessions.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('HistoryDashboard NavFace-driven default project facet', () => {
  it('mounts at navFace=home (overview panel) with all projects shown', async () => {
    const el = await mount(<HistoryDashboard />)
    expect(isShowingAll(el)).toBe(true)
  })

  it('mounting directly on navFace=project (already focused, not a transition) isolates the active tab cwd', async () => {
    useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
    useLayout.setState({ focusedPanelId: 'terminal' })
    const el = await mount(<HistoryDashboard />)
    expect(isIsolatedTo(el, ALPHA_CWD)).toBe(true)
  })

  it('flipping navFace to project (with an active tab cwd) isolates that project', async () => {
    const el = await mount(<HistoryDashboard />)
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ focusedPanelId: 'terminal' })
      await Promise.resolve()
    })
    expect(isIsolatedTo(el, ALPHA_CWD)).toBe(true)
  })

  it('a manual filter change survives a re-render at the same navFace', async () => {
    const el = await mount(<HistoryDashboard />)
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ focusedPanelId: 'terminal' })
      await Promise.resolve()
    })
    expect(isIsolatedTo(el, ALPHA_CWD)).toBe(true)

    // Manual: show all again while still on the project face.
    await act(async () => {
      showAllBtn(el).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(isShowingAll(el)).toBe(true)

    // A re-render at the SAME navFace ('project') must not reset the manual choice.
    await act(async () => {
      useSessions.setState({ tabs: [{ ...ALPHA_TAB }], activeTabId: ALPHA_TAB.id })
      await Promise.resolve()
    })
    expect(isShowingAll(el)).toBe(true)
  })

  it('transitioning back to home with no manual touch clears the isolation', async () => {
    const el = await mount(<HistoryDashboard />)
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ focusedPanelId: 'terminal' })
      await Promise.resolve()
    })
    expect(isIsolatedTo(el, ALPHA_CWD)).toBe(true)

    await act(async () => {
      useLayout.setState({ focusedPanelId: 'overview' })
      await Promise.resolve()
    })
    expect(isShowingAll(el)).toBe(true)
  })
})
