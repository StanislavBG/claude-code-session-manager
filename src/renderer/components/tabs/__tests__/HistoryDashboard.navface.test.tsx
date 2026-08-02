// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HistoryDashboard } from '../HistoryDashboard'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { encodeWorkspace } from '../../../lib/encodeWorkspace'
import type { HistoryDashboardProjectRow, HistoryDashboardResult, HistoryDashboardTotals } from '../../../../preload/api'

/**
 * History's project facet is FORCE-scoped on the Project face — no manual
 * override, no ProjectFacet UI at all, `keep` derives directly from
 * activeCwd every render (matches Scheduler.navface.test.tsx's Project-face
 * force-scoping coverage). Home face keeps the full multi-project
 * toggle/isolate/show-all filter, resetting to "all" on transition back in.
 *
 * `history:dashboard` keys `byProject` by the ENCODED cwd slug (same
 * encoding as `~/.claude/projects/<encoded>/`), not the raw path — so the
 * fixture below mirrors that real shape via `encodeWorkspace`, and UI
 * lookups (title attr = `chip.projectDir` = the encoded key) match against
 * the encoded key too.
 */

const ALPHA_CWD = '/home/bilko/Projects/alpha'
const BETA_CWD = '/home/bilko/Projects/beta'
const ALPHA_KEY = encodeWorkspace(ALPHA_CWD)
const BETA_KEY = encodeWorkspace(BETA_CWD)

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
    days: [{ date, byProject: { [ALPHA_KEY]: row(ALPHA_KEY, date), [BETA_KEY]: row(BETA_KEY, date) } }],
    prevTotals: emptyTotals(),
    totals: emptyTotals(),
    byProjectTotals: { [ALPHA_KEY]: emptyTotals(), [BETA_KEY]: emptyTotals() },
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

function isolateBtn(el: HTMLElement, cwd: string): HTMLButtonElement | null {
  return el.querySelector(`button[title="${cwd}"]`) as HTMLButtonElement | null
}

function showAllBtn(el: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith('show all')) as HTMLButtonElement | undefined
}

function isIsolatedTo(el: HTMLElement, cwd: string): boolean {
  const alpha = isolateBtn(el, ALPHA_KEY)
  const beta = isolateBtn(el, BETA_KEY)
  if (!alpha || !beta) return false
  const alphaActive = !alpha.className.includes('opacity-40')
  const betaActive = !beta.className.includes('opacity-40')
  if (cwd === ALPHA_KEY) return alphaActive && !betaActive
  return betaActive && !alphaActive
}

function isShowingAll(el: HTMLElement): boolean {
  const alpha = isolateBtn(el, ALPHA_KEY)
  const beta = isolateBtn(el, BETA_KEY)
  if (!alpha || !beta) return false
  return !alpha.className.includes('opacity-40') && !beta.className.includes('opacity-40')
}

beforeEach(() => {
  localStorage.clear()
  installWindowApiMock()
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('HistoryDashboard Home face — full multi-project facet', () => {
  it('mounts at navFace=home (overview panel) with all projects shown', async () => {
    const el = await mount(<HistoryDashboard />)
    expect(isShowingAll(el)).toBe(true)
  })

  it('a manual filter change survives a re-render while staying on Home', async () => {
    const el = await mount(<HistoryDashboard />)
    // Shift-click isolates to just this project (plain click toggles it — see
    // ProjectFacet.tsx's onClick={(e) => e.shiftKey ? onIsolate : onToggle}).
    await act(async () => {
      isolateBtn(el, ALPHA_KEY)!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
      await Promise.resolve()
    })
    expect(isIsolatedTo(el, ALPHA_KEY)).toBe(true)

    // A re-render on the SAME navFace ('home') must not reset the manual choice.
    await act(async () => {
      useSessions.setState({ tabs: [], activeTabId: null })
      await Promise.resolve()
    })
    expect(isIsolatedTo(el, ALPHA_KEY)).toBe(true)
  })
})

describe('HistoryDashboard Project face — force-scoped, no escape hatch', () => {
  it('mounting directly on navFace=project renders no ProjectFacet UI at all', async () => {
    useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
    useLayout.setState({ navFace: 'project' })
    const el = await mount(<HistoryDashboard />)
    expect(isolateBtn(el, ALPHA_KEY)).toBeNull()
    expect(isolateBtn(el, BETA_KEY)).toBeNull()
    expect(showAllBtn(el)).toBeUndefined()
  })

  it('flipping navFace to project removes the facet even if it was manually set to "all" on Home', async () => {
    const el = await mount(<HistoryDashboard />)
    // Manually show all on Home first (a no-op here since that's the
    // default, but exercises the same manual-touch path the old code used
    // to let survive a transition).
    await act(async () => {
      showAllBtn(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    // Force-scoped: no facet UI, no way to see beta's data from here.
    expect(isolateBtn(el, ALPHA_KEY)).toBeNull()
    expect(el.textContent).not.toContain(BETA_KEY)
  })

  it('transitioning back to Home resets to "show all"', async () => {
    const el = await mount(<HistoryDashboard />)
    await act(async () => {
      useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    await act(async () => {
      useLayout.setState({ navFace: 'home' })
      await Promise.resolve()
    })
    expect(isShowingAll(el)).toBe(true)
  })

  it('scopes correctly even when the raw cwd contains a literal dash (e.g. "session-manager")', async () => {
    // Regression test: byProject is keyed by the ENCODED cwd slug, where
    // every non-alnum char (including a literal "-" already in the path)
    // becomes "-". Matching against the raw activeCwd instead of its
    // encoded form silently fails to scope any project whose path has a
    // dash in a segment name — this repo's own cwd is exactly such a case.
    const dashCwd = '/home/bilko/Projects/session-manager'
    const dashTab: SessionTab = { ...ALPHA_TAB, id: 'tab-dash', sessionId: 'tab-dash', cwd: dashCwd }
    const dashKey = encodeWorkspace(dashCwd)
    const api = installWindowApiMock()
    api.history.dashboard.mockResolvedValue({
      from: '2026-07-30',
      to: '2026-07-30',
      days: [{ date: '2026-07-30', byProject: { [dashKey]: row(dashKey, '2026-07-30'), [BETA_KEY]: row(BETA_KEY, '2026-07-30') } }],
      prevTotals: emptyTotals(),
      totals: emptyTotals(),
      byProjectTotals: { [dashKey]: emptyTotals(), [BETA_KEY]: emptyTotals() },
      byModelTotals: {},
      toolsByProject: {},
      generatedAt: 0,
      provisionalDates: [],
    })
    useSessions.setState({ tabs: [dashTab], activeTabId: dashTab.id })
    useLayout.setState({ navFace: 'project' })
    const el = await mount(<HistoryDashboard />)
    expect(el.textContent).not.toContain('no sessions in range')
    expect(el.textContent).not.toContain(BETA_KEY)
  })
})
