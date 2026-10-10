// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HistoryDashboard } from '../HistoryDashboard'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useToast } from '../../../state/toast'
import { encodeWorkspace } from '../../../lib/encodeWorkspace'
import { usd, tok, int, min } from '../../../lib/analyticsFormat'
import { prettyModel } from '../../../lib/prettyModel'
import type { HistoryDashboardProjectRow, HistoryDashboardResult, HistoryDashboardTotals } from '../../../../preload/api'

/**
 * History's project facet is FORCE-scoped on the Project face — no manual
 * override, no ProjectFacet UI at all, `keep` derives directly from
 * activeCwd every render (matches Scheduler.navface.test.tsx's Project-face
 * force-scoping coverage). Home face keeps the full multi-project
 * toggle/isolate/show-all filter, resetting to "all" on transition back in.
 *
 * `history:dashboard` keys `byProject` by the ENCODED cwd slug (same
 * encoding as `~/.claude/projects/<encoded>/`), so the IPC fixture below
 * mirrors that real shape via `encodeWorkspace`. The component folds those
 * keys to the RESOLVED CWD before anything renders (lib/historyProjectFold.ts
 * — a project is a working directory, not a transcript folder), so every UI
 * lookup below matches on the raw cwd, and `useKnownProjects` is mocked to
 * supply the encoded→cwd map that fold needs.
 */

vi.mock('../../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    projects: [
      { cwd: '/home/bilko/Projects/alpha', name: 'alpha', encoded: ALPHA_KEY, encodedIds: [ALPHA_KEY], sessionCount: 0, sizeBytes: 0, lastSession: 0, details: {} },
      { cwd: '/home/bilko/Projects/beta', name: 'beta', encoded: BETA_KEY, encodedIds: [BETA_KEY], sessionCount: 0, sizeBytes: 0, lastSession: 0, details: {} },
      { cwd: DASH_CWD, name: 'session-manager', encoded: DASH_KEY, encodedIds: [DASH_KEY], sessionCount: 0, sizeBytes: 0, lastSession: 0, details: {} },
    ],
    rows: [],
    enriched: {},
    loading: false,
    resolving: false,
  }),
}))

const ALPHA_CWD = '/home/bilko/Projects/alpha'
const BETA_CWD = '/home/bilko/Projects/beta'
const DASH_CWD = '/home/bilko/Projects/session-manager'
const ALPHA_KEY = encodeWorkspace(ALPHA_CWD)
const BETA_KEY = encodeWorkspace(BETA_CWD)
const DASH_KEY = encodeWorkspace(DASH_CWD)

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
  const store: Record<string, unknown> = {}
  const api = {
    history: {
      dashboard: vi.fn().mockResolvedValue(buildRaw()),
    },
    config: {
      readJson: vi.fn(async () => ({ exists: Object.keys(store).length > 0, data: { ...store } })),
      writeJson: vi.fn(async (_path: string, data: unknown) => {
        Object.assign(store, data as Record<string, unknown>)
        return { ok: true, mtimeMs: Date.now() }
      }),
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
  const alpha = isolateBtn(el, ALPHA_CWD)
  const beta = isolateBtn(el, BETA_CWD)
  if (!alpha || !beta) return false
  const alphaActive = !alpha.className.includes('opacity-40')
  const betaActive = !beta.className.includes('opacity-40')
  if (cwd === ALPHA_CWD) return alphaActive && !betaActive
  return betaActive && !alphaActive
}

function isShowingAll(el: HTMLElement): boolean {
  const alpha = isolateBtn(el, ALPHA_CWD)
  const beta = isolateBtn(el, BETA_CWD)
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
      isolateBtn(el, ALPHA_CWD)!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
      await Promise.resolve()
    })
    expect(isIsolatedTo(el, ALPHA_CWD)).toBe(true)

    // A re-render on the SAME navFace ('home') must not reset the manual choice.
    await act(async () => {
      useSessions.setState({ tabs: [], activeTabId: null })
      await Promise.resolve()
    })
    expect(isIsolatedTo(el, ALPHA_CWD)).toBe(true)
  })
})

// A project is a working directory. ~/.claude/projects holds one folder per
// path the CLI was ever launched from, so the raw payload carried 2028
// "projects" here — 2009 of them -tmp-sm-*-test-* fixture folders with no
// resolvable cwd, contributing 4,304 phantom sessions to the `sessions`
// measure and rendering as raw encoded slugs in the facet.
describe('HistoryDashboard project axis — folded to unique cwds', () => {
  const GHOST_KEY = '-tmp-sm-paged-test-08mRjd'

  function withGhost() {
    const api = installWindowApiMock()
    const date = '2026-07-30'
    api.history.dashboard.mockResolvedValue({
      from: date,
      to: date,
      days: [{ date, byProject: {
        [ALPHA_KEY]: row(ALPHA_KEY, date),
        [BETA_KEY]: row(BETA_KEY, date),
        [GHOST_KEY]: { ...row(GHOST_KEY, date), promptCount: 0, estimatedCostUsd: 0, sessionCount: 3 },
      } }],
      prevTotals: emptyTotals(),
      totals: emptyTotals(),
      byProjectTotals: {},
      byModelTotals: {},
      toolsByProject: {},
      generatedAt: 0,
      provisionalDates: [],
    })
    return api
  }

  it('keys the facet by resolved cwd, not by the encoded transcript folder', async () => {
    const el = await mount(<HistoryDashboard />)
    expect(isolateBtn(el, ALPHA_CWD)).not.toBeNull()
    expect(isolateBtn(el, ALPHA_KEY)).toBeNull()
    expect(el.textContent).not.toContain(ALPHA_KEY)
  })

  it('drops a transcript folder with no resolvable cwd from the project axis', async () => {
    withGhost()
    const el = await mount(<HistoryDashboard />)
    expect(isolateBtn(el, GHOST_KEY)).toBeNull()
    expect(el.textContent).not.toContain(GHOST_KEY)
    // Only the two real projects remain on the axis.
    expect(isolateBtn(el, ALPHA_CWD)).not.toBeNull()
    expect(isolateBtn(el, BETA_CWD)).not.toBeNull()
  })

  it('states what it excluded rather than dropping those numbers silently', async () => {
    withGhost()
    const el = await mount(<HistoryDashboard />)
    const note = el.querySelector('[data-testid="history-excluded-note"]')
    expect(note).not.toBeNull()
    expect(note!.textContent).toContain('1 transcript folder')
    expect(note!.textContent).toContain('3 sessions')
  })

  it('shows no exclusion note when every folder resolves', async () => {
    const el = await mount(<HistoryDashboard />)
    expect(el.querySelector('[data-testid="history-excluded-note"]')).toBeNull()
  })
})

describe('HistoryDashboard Project face — force-scoped, no escape hatch', () => {
  it('mounting directly on navFace=project renders no ProjectFacet UI at all', async () => {
    useSessions.setState({ tabs: [ALPHA_TAB], activeTabId: ALPHA_TAB.id })
    useLayout.setState({ navFace: 'project' })
    const el = await mount(<HistoryDashboard />)
    expect(isolateBtn(el, ALPHA_CWD)).toBeNull()
    expect(isolateBtn(el, BETA_CWD)).toBeNull()
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
    expect(isolateBtn(el, ALPHA_CWD)).toBeNull()
    expect(el.textContent).not.toContain(BETA_CWD)
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
    const dashTab: SessionTab = { ...ALPHA_TAB, id: 'tab-dash', sessionId: 'tab-dash', cwd: DASH_CWD }
    const dashKey = DASH_KEY
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
    expect(el.textContent).not.toContain(BETA_CWD)
  })
})

// Measure/range now persist through the shared ui-settings-prefs.json (via
// lib/historyAnalyticsPrefs.ts) instead of localStorage — a merge-write so a
// later BudgetStrip cap write never drops these two fields.
describe('HistoryDashboard measure/range — disk-backed persistence', () => {
  it('paints with the sane defaults (spend / 30d) then hydrates a persisted choice', async () => {
    const api = installWindowApiMock()
    await api.config.writeJson('~/.claude/session-manager/ui-settings-prefs.json', { history: { measure: 'sessions', range: 90 } })
    const el = await mount(<HistoryDashboard />)
    const sessionsBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Sessions')
    const rangeBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '90d')
    expect(sessionsBtn?.className).toContain('bg-bg-hi')
    expect(rangeBtn?.className).toContain('bg-bg-hi')
  })

  it('clicking a measure/range control writes it through window.api.config.writeJson', async () => {
    const el = await mount(<HistoryDashboard />)
    const sessionsBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Sessions')!
    await act(async () => {
      sessionsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const api = (window as unknown as { api: { config: { writeJson: ReturnType<typeof vi.fn> } } }).api
    expect(api.config.writeJson).toHaveBeenCalledWith(
      '~/.claude/session-manager/ui-settings-prefs.json',
      expect.objectContaining({ history: expect.objectContaining({ measure: 'sessions' }) }),
    )
  })

  it('reverts and toasts when the write fails (never swallow errors)', async () => {
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    const api = installWindowApiMock()
    api.config.writeJson.mockRejectedValueOnce(new Error('disk full'))
    const el = await mount(<HistoryDashboard />)
    const sessionsBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Sessions')!
    await act(async () => {
      sessionsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    const spendBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Spend')!
    expect(spendBtn.className).toContain('bg-bg-hi')
    expect(useToast.getState().toasts.some((t) => t.kind === 'error')).toBe(true)
  })
})

// The drill panel and the CSV both fold day rows through sumDayTotals
// (lib/historyMath.ts). One fixture, two days x two models, pins both outputs.
describe('HistoryDashboard drill panel + CSV export — shared day-total sums', () => {
  function bucket(i: number, o: number, cr: number, cc: number, c: number) {
    return { inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc, costUsd: c }
  }
  function sumRow(key: string, date: string, over: Partial<HistoryDashboardProjectRow>): HistoryDashboardProjectRow {
    return { ...row(key, date), promptCount: 0, estimatedCostUsd: 0, ...over }
  }

  function withSums() {
    const api = installWindowApiMock()
    const d1 = '2026-07-29'
    const d2 = '2026-07-30'
    api.history.dashboard.mockResolvedValue({
      from: d1,
      to: d2,
      days: [
        { date: d1, byProject: {
          [ALPHA_KEY]: sumRow(ALPHA_KEY, d1, {
            promptCount: 5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 20,
            toolCallCount: 4, sessionCount: 2, activeMinutes: 3, estimatedCostUsd: 1.5,
            toolBreakdown: { Bash: 3, Read: 1 },
            byModel: { 'claude-opus-4': bucket(60, 30, 5, 10, 1), 'claude-sonnet-4': bucket(40, 20, 5, 10, 0.5) },
          }),
          [BETA_KEY]: sumRow(BETA_KEY, d1, {
            inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 2, estimatedCostUsd: 0.25,
            byModel: { 'claude-opus-4': bucket(7, 3, 1, 2, 0.25) },
          }),
        } },
        { date: d2, byProject: {
          [ALPHA_KEY]: sumRow(ALPHA_KEY, d2, {
            promptCount: 3, inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 2,
            toolCallCount: 2, sessionCount: 1, activeMinutes: 4, estimatedCostUsd: 0.5,
            toolBreakdown: { Bash: 2 },
            byModel: { 'claude-opus-4': bucket(10, 5, 1, 2, 0.5) },
          }),
        } },
      ],
      prevTotals: emptyTotals(),
      totals: emptyTotals(),
      byProjectTotals: {},
      byModelTotals: {},
      toolsByProject: {},
      generatedAt: 0,
      provisionalDates: [],
    })
  }

  it('drill totals sum both days of the selected project', async () => {
    withSums()
    const el = await mount(<HistoryDashboard />)
    const alphaRow = Array.from(el.querySelectorAll('tr')).find((tr) => tr.textContent?.includes('alpha'))!
    await act(async () => {
      alphaRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const stat = (label: string) => {
      const l = Array.from(el.querySelectorAll('div')).find((d) => d.children.length === 0 && d.textContent === label)
      return l?.nextElementSibling?.textContent
    }
    expect(stat('prompts')).toBe(int(8))
    expect(stat('sessions')).toBe(int(3))
    expect(stat('in tokens')).toBe(tok(143))
    expect(stat('out tokens')).toBe(tok(55))
    expect(stat('spend')).toBe(usd(2))
    expect(stat('time')).toBe(min(7))
    // model mix merged by id across days; tool mix merged too.
    expect(el.textContent).toContain(usd(1.5))
    expect(el.textContent).toContain(usd(0.5))
  })

  it('CSV row per day sums every project and merges models', async () => {
    withSums()
    let blob: Blob | null = null
    const create = vi.fn((b: Blob) => { blob = b; return 'blob:test' })
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = create
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const el = await mount(<HistoryDashboard />)
    const exportBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Export CSV')!
    await act(async () => {
      exportBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    click.mockRestore()
    expect(blob).not.toBeNull()
    const csv = await new Promise<string>((res) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.readAsText(blob!)
    })
    const lines = csv.split('\n')
    expect(lines[0]).toBe('date,cost_usd,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,total_tokens,cache_hit_pct,num_models,top_model')
    // day 1 = alpha + beta: in 107, out 53, cw 22, cr 11, total 193, hit 11/140.
    expect(lines[1]).toBe('2026-07-29,1.7500,107,53,22,11,193,7.9,2,' + prettyModel('claude-opus-4'))
    expect(lines[2]).toBe('2026-07-30,0.5000,10,5,2,1,18,7.7,1,' + prettyModel('claude-opus-4'))
  })
})
