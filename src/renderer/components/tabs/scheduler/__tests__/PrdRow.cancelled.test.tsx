// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PrdRow } from '../PrdRow'
import { buildPlans, type PlanRow } from '../../../../lib/schedulerStages'
import type { ScheduleJob } from '../../../../../preload/api'

/**
 * A human-cancelled PRD (main's cancelled: true, carried onto PlanRow by
 * buildPlans) is a decision, not a failure: neutral faint dot, no failed
 * tint, faint trailing text. A real failure keeps its accent dot + tint.
 */

function job(slug: string, over: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug, title: slug, cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '', status: 'pending',
    runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null, epicId: 'e', ...over,
  } as ScheduleJob
}

const ROWS: PlanRow[] = buildPlans(
  [
    job('1-cancelled', { status: 'failed', error: 'cancelled', cancelled: true } as Partial<ScheduleJob>),
    job('2-failed', { status: 'failed', error: 'boom', exitCode: 1 }),
  ],
  { sessions: {}, now: 0 },
).flatMap((p) => p.stages.flatMap((s) => s.rows))

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(row: PlanRow): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(PrdRow, { row, elapsedMs: null, listIndex: 0, onFocused: vi.fn() })))
  return container
}

const rowFor = (slug: string) => ROWS.find((r) => r.slug === slug)!
const dot = (el: HTMLElement) => el.querySelector('button > span[aria-hidden="true"]') as HTMLElement
const button = (el: HTMLElement) => el.querySelector('button[data-job-row]') as HTMLElement
const trailing = (el: HTMLElement) => el.querySelector('[data-testid="prd-row-trailing"]') as HTMLElement

describe('PrdRow — cancelled rows read neutral, never failed', () => {
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
  })

  it('buildPlans flags the cancelled row', () => {
    expect(rowFor('1-cancelled').cancelled).toBe(true)
    expect(rowFor('2-failed').cancelled).toBeUndefined()
  })

  it('gives a cancelled row the faint dot, no failed tint, faint trailing text', () => {
    const el = render(rowFor('1-cancelled'))
    expect(dot(el).className).toContain('bg-fg-faint/40')
    expect(dot(el).className).not.toContain('bg-accent')
    expect(button(el).className).not.toContain('bg-accent/10')
    expect(trailing(el).className).toContain('text-fg-faint')
    expect(trailing(el).className).not.toContain('text-accent')
  })

  it('leaves a real failure unchanged: accent dot + failed tint + accent trailing', () => {
    const el = render(rowFor('2-failed'))
    expect(dot(el).className).toContain('bg-accent')
    expect(button(el).className).toContain('bg-accent/10')
    expect(trailing(el).className).toContain('text-accent')
  })

  it('a hand-built PlanRow with cancelled: true is neutral even if rowKind says failed', () => {
    const el = render({ ...rowFor('2-failed'), cancelled: true })
    expect(dot(el).className).not.toContain('bg-accent')
    expect(button(el).className).not.toContain('bg-accent/10')
    expect(trailing(el).className).toContain('text-fg-faint')
  })
})
