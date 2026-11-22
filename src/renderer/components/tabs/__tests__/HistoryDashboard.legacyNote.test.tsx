// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HistoryDashboard } from '../HistoryDashboard'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { encodeWorkspace } from '../../../lib/encodeWorkspace'
import type { HistoryDashboardProjectRow, HistoryDashboardResult, HistoryDashboardTotals } from '../../../../preload/api'

/**
 * Days finalized under the older rollup version (before once-per-call
 * counting) read high and cannot be recounted — their transcripts are gone.
 * `history:dashboard` names them in `legacyDates`; the page must state them
 * in one line rather than let those numbers be read as exact.
 * Mount pattern follows HistoryDashboard.navface.test.tsx.
 */

const ALPHA_CWD = '/home/bilko/Projects/alpha'
const ALPHA_KEY = encodeWorkspace(ALPHA_CWD)

vi.mock('../../../lib/useKnownProjects', () => ({
  useKnownProjects: () => ({
    projects: [
      { cwd: ALPHA_CWD, name: 'alpha', encoded: ALPHA_KEY, encodedIds: [ALPHA_KEY], sessionCount: 0, sizeBytes: 0, lastSession: 0, details: {} },
    ],
    rows: [],
    enriched: {},
    loading: false,
    resolving: false,
  }),
}))

function emptyTotals(): HistoryDashboardTotals {
  return {
    promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 0, sessionCount: 0, errorCount: 0, activeMinutes: 0, estimatedCostUsd: 0,
  }
}

function row(date: string): HistoryDashboardProjectRow {
  return { ...emptyTotals(), promptCount: 5, estimatedCostUsd: 1.5, date, projectDir: ALPHA_KEY, toolBreakdown: {}, byModel: {} }
}

function buildRaw(legacyDates: string[] | undefined): HistoryDashboardResult {
  const dates = ['2026-07-28', '2026-07-29', '2026-07-30']
  const raw: HistoryDashboardResult = {
    from: dates[0],
    to: dates[2],
    days: dates.map((date) => ({ date, byProject: { [ALPHA_KEY]: row(date) } })),
    prevTotals: emptyTotals(),
    totals: emptyTotals(),
    byProjectTotals: { [ALPHA_KEY]: emptyTotals() },
    byModelTotals: {},
    toolsByProject: {},
    generatedAt: 0,
    provisionalDates: [],
    legacyDates: legacyDates ?? [],
  }
  if (legacyDates === undefined) delete (raw as Partial<HistoryDashboardResult>).legacyDates
  return raw
}

function installWindowApiMock(legacyDates: string[] | undefined) {
  const api = {
    history: {
      dashboard: vi.fn().mockResolvedValue(buildRaw(legacyDates)),
      loopEfficiency: vi.fn().mockResolvedValue({ fromMs: 0, toMs: 0, rows: [], totals: { runs: 0, wastedRuns: 0, verified: 0, refuted: 0, executorUsd: 0, wastedRunRate: 0 }, weeklyUtilizationPct: null, verifiedPerUsagePct: null }),
      onUpdated: vi.fn(() => () => {}),
    },
    config: {
      readJson: vi.fn(async () => ({ exists: false, data: {} })),
      writeJson: vi.fn(async () => ({ ok: true, mtimeMs: Date.now() })),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<HistoryDashboard />)
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  localStorage.clear()
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

describe('HistoryDashboard legacy-days note', () => {
  it('states the count and last legacy day, the older method, the 2-3x overcount and why it cannot be recounted', async () => {
    installWindowApiMock(['2026-07-29', '2026-07-28'])
    const el = await mount()
    const notes = el.querySelectorAll('[data-testid="history-legacy-note"]')
    expect(notes.length).toBe(1)
    const text = notes[0].textContent ?? ''
    expect(text).toContain('2 days')
    expect(text).toContain('2026-07-29')
    expect(text).toContain('older method')
    expect(text).toContain('two to three times too high')
    expect(text).toContain('transcripts are gone')
    // Sits above the panels: before the project facet and charts in document order.
    const facetBtn = el.querySelector(`button[title="${ALPHA_CWD}"]`)!
    expect(notes[0].compareDocumentPosition(facetBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows nothing when legacyDates is empty', async () => {
    installWindowApiMock([])
    const el = await mount()
    expect(el.querySelector('[data-testid="history-dashboard"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="history-legacy-note"]')).toBeNull()
  })

  it('shows nothing when legacyDates is missing', async () => {
    installWindowApiMock(undefined)
    const el = await mount()
    expect(el.querySelector('[data-testid="history-dashboard"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="history-legacy-note"]')).toBeNull()
  })
})
