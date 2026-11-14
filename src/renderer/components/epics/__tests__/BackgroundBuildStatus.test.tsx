// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach, vi } from 'vitest'
import type { ScheduleJob } from '../../../../preload/api'
import { BackgroundBuildStatus } from '../BackgroundBuildStatus'
import { formatClock } from '../../../lib/formatTime'

/**
 * BackgroundBuildStatus — the one Discussion status line a job-macro Epic
 * (Demo Video, Project Home pages, Competitor matrix) shows while its
 * background build is queuing / waiting / running. Pure props; EpicDetail
 * derives them. Real case: Epic demo-video-…-8e9c1672, PRD
 * 827-demo-video-build-mwguqdcvmwz, running 12:23 PM → 1:16 PM PST.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

const SLUG = '827-demo-video-build-mwguqdcvmwz'
const STARTED = Date.parse('2026-11-14T20:23:00.000Z') // 12:23 PM PST

function job(status: ScheduleJob['status'], startedAt: string | null = null): ScheduleJob {
  return { slug: SLUG, status, startedAt, sourcePromptId: 'demo-video-generate-a-character-and-cute-animate-8e9c1672' } as unknown as ScheduleJob
}

const base = { isBackgroundBuild: true, prdCreatedSlugs: [] as string[], jobs: [] as ScheduleJob[], notQueued: false, onOpenPrd: () => {} }

describe('BackgroundBuildStatus', () => {
  it('shows "Queuing the background build…" before any prd_created event or not-queued notice', () => {
    const el = mount(createElement(BackgroundBuildStatus, base))
    expect(el.querySelector('[data-testid="epic-background-build-status"]')?.textContent).toContain('Queuing the background build…')
  })

  it('shows "Queued — waiting for a free slot" when the latest build PRD job is pending', () => {
    const el = mount(createElement(BackgroundBuildStatus, { ...base, prdCreatedSlugs: ['old-slug', SLUG], jobs: [job('pending')] }))
    expect(el.textContent).toContain('Queued — waiting for a free slot')
    expect(el.textContent).not.toContain('Queuing')
  })

  it('shows the running line with local start time, elapsed, and an Open in Scheduler button', () => {
    const now = STARTED + 53 * 60_000 // 1:16 PM PST
    const onOpenPrd = vi.fn()
    const el = mount(createElement(BackgroundBuildStatus, {
      ...base,
      prdCreatedSlugs: [SLUG],
      jobs: [job('running', new Date(STARTED).toISOString())],
      now,
      onOpenPrd,
    }))
    expect(el.textContent).toContain(`Building in the background — PRD #827, running since ${formatClock(STARTED)} (53m)`)
    const btn = el.querySelector('[data-testid="epic-background-build-open"]') as HTMLButtonElement
    expect(btn.textContent).toBe('Open in Scheduler')
    act(() => btn.click())
    expect(onOpenPrd).toHaveBeenCalledWith(SLUG)
  })

  it('refreshes elapsed every 30 s and clears its interval on unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(STARTED + 60_000)
    const clear = vi.spyOn(window, 'clearInterval')
    const el = mount(createElement(BackgroundBuildStatus, { ...base, prdCreatedSlugs: [SLUG], jobs: [job('running', new Date(STARTED).toISOString())] }))
    expect(el.textContent).toContain('(1m)')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(el.textContent).toContain('(2m)')
    act(() => root!.unmount())
    root = null
    expect(clear).toHaveBeenCalled()
  })

  it('renders nothing once the job is no longer pending or running', () => {
    for (const jobs of [[job('completed')], [job('failed')], []]) {
      const el = mount(createElement(BackgroundBuildStatus, { ...base, prdCreatedSlugs: [SLUG], jobs }))
      expect(el.querySelector('[data-testid="epic-background-build-status"]')).toBeNull()
      act(() => root!.unmount()); container!.remove(); root = null
    }
  })

  it('renders nothing after a job-not-queued notice with no build PRD', () => {
    const el = mount(createElement(BackgroundBuildStatus, { ...base, notQueued: true }))
    expect(el.innerHTML).toBe('')
  })

  it('renders nothing for a non-job Epic', () => {
    const el = mount(createElement(BackgroundBuildStatus, { ...base, isBackgroundBuild: false, prdCreatedSlugs: [SLUG], jobs: [job('running', new Date(STARTED).toISOString())] }))
    expect(el.innerHTML).toBe('')
  })
})
