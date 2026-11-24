// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { StageColumn } from '../StageColumn'
import type { PlanRow, Stage } from '../../../../lib/schedulerStages'
import type { ScheduleJob } from '../../../../../preload/api'

/** A human-cancelled row (main's cancelled: true) is settled: never flagged, never in the Retry/Review pair. */

function row(slug: string, status: string, cancelled?: boolean): PlanRow {
  const job = {
    slug, title: slug, cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '', status,
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'e',
    ...(cancelled ? { cancelled: true } : {}),
  } as unknown as ScheduleJob
  return {
    slug, prdNumber: slug.split('-')[0], title: slug, status, rowKind: 'plain', rowTrailing: '', cycle: false,
    estimateMinutes: null, deps: [], crossEpicDeps: [], blockers: [], ...(cancelled ? { cancelled: true } : {}), job,
  } as unknown as PlanRow
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(rows: PlanRow[]): HTMLElement {
  const stage: Stage = { n: 1, state: 'blocked', summary: '', rows, doneCount: 0, runningCount: 0, heldCount: 0, blockedCount: 0 }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(StageColumn, {
    stage, epicId: 'e', now: 0, hidden: new Set<string>(), indexBySlug: new Map(), headChoicesBySlug: new Map(), onRowFocused: vi.fn(),
  })))
  return container
}

beforeEach(() => { ;(globalThis as any).window.api = { schedule: { resetJob: vi.fn(async () => ({ ok: true })), setPrdDisposition: vi.fn(async () => ({ ok: true })) } } })
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
})

const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const order = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="prd-row"]')).map((r) => r.dataset.slug ?? '')

describe('StageColumn — cancelled rows', () => {
  it('shows no Retry/Review pair when the only failed / needs_review rows are cancelled', () => {
    const el = render([row('1-done', 'completed'), row('2-cf', 'failed', true), row('3-cr', 'needs_review', true)])
    expect(q(el, 'stage-attention-actions')).toBeNull()
    expect(q(el, 'stage-retry')).toBeNull()
    expect(q(el, 'stage-review')).toBeNull()
  })

  it('never picks a cancelled row as the failed or review row; real ones still get the pair', () => {
    const el = render([
      row('1-cf', 'failed', true), row('2-cr', 'needs_review', true),
      row('3-real', 'failed'), row('4-rev', 'needs_review'),
    ])
    expect(q(el, 'stage-retry')!.textContent).toBe('Retry #3')
    expect(q(el, 'stage-review')!.textContent).toBe('Review #4')
  })

  it('ranks cancelled rows as settled (after pending work), real failures first', () => {
    const el = render([row('1-cf', 'failed', true), row('2-pend', 'pending'), row('3-real', 'failed')])
    const o = order(el)
    expect(o[0]).toContain('3-real')
    expect(o[1]).toContain('2-pend')
    expect(o[2]).toContain('1-cf')
  })
})
