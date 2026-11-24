// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SchedulerHistoryView } from '../SchedulerHistoryView'
import type { ScheduleJob } from '../../../../../preload/api'

/** A human-cancelled job (main's cancelled: true) reads as a cancel badge with no red error line. */

function job(slug: string, over: Record<string, unknown> = {}): ScheduleJob {
  return {
    slug, title: slug, cwd: '/p', parallelGroup: 1, estimateMinutes: null, bodyPreview: '', status: 'pending',
    runId: null, startedAt: null, finishedAt: '2026-11-20T00:00:00Z', exitCode: null, error: null, epicId: null, ...over,
  } as unknown as ScheduleJob
}

const JOBS = [
  job('1-cf', { status: 'failed', error: 'cancelled via admin API', cancelled: true }),
  job('2-cr', { status: 'needs_review', error: 'review me', cancelled: true }),
  job('3-real', { status: 'failed', error: 'boom', exitCode: 1 }),
]

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  ;(globalThis as any).window.api = { schedule: { getHistory: vi.fn(async () => ({ ok: true, jobs: JOBS })) } }
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove(); container = null; root = null
})

async function mount(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<SchedulerHistoryView />) })
  return container
}

const rowFor = (el: HTMLElement, title: string) =>
  Array.from(el.querySelectorAll<HTMLElement>('button[aria-expanded]')).find((b) => b.textContent?.includes(title))!

describe('SchedulerHistoryView — cancelled jobs', () => {
  it('badges cancelled failed / needs_review jobs as cancelled without the red error line', async () => {
    const el = await mount()
    for (const [slug, err] of [['1-cf', 'cancelled via admin API'], ['2-cr', 'review me']]) {
      const r = rowFor(el, slug)
      expect(r.querySelector('[aria-label="Status: cancelled"]')).not.toBeNull()
      expect(r.textContent).not.toContain(err)
      expect(r.querySelector('.text-accent\\/80')).toBeNull()
    }
  })

  it('keeps a real failure as failed with its error line', async () => {
    const el = await mount()
    const r = rowFor(el, '3-real')
    expect(r.querySelector('[aria-label="Status: cancelled"]')).toBeNull()
    expect(r.textContent).toContain('boom')
    expect(r.querySelector('.text-accent\\/80')?.textContent).toBe('boom')
  })
})
