// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { JobRow } from '../JobRow'
import { SchBadge, prdStatusFor, STATUS_TONE } from '../sched-primitives'
import { usePromptSessions } from '../../../../state/promptSessions'
import type { ScheduleJob, ScheduleJobStatus } from '../../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  usePromptSessions.setState({ sessions: {} })
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    slug: '901-cancel-me',
    title: 'Cancel me',
    cwd: '/proj',
    parallelGroup: 901,
    estimateMinutes: 5,
    bodyPreview: '',
    status: 'failed',
    runId: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: 'cancelled by user',
    ...overrides,
  } as ScheduleJob
}

const ALL_STATUSES: ScheduleJobStatus[] = [
  'running', 'investigating', 'pending', 'completed', 'skipped', 'needs_review', 'failed', 'quarantined',
]

describe('STATUS_TONE cancelled', () => {
  it('uses the neutral skipped tone, bordered, labelled cancelled', () => {
    expect(STATUS_TONE.cancelled).toEqual({ bg: 'bg-fg-dim/10', text: 'text-fg-dim', border: true, label: 'cancelled' })
  })
})

describe('prdStatusFor cancelled', () => {
  it('returns cancelled for a cancelled failed job', () => {
    expect(prdStatusFor({ status: 'failed', cancelled: true })).toBe('cancelled')
  })
  it('returns cancelled for a cancelled needs_review job, before any verdict fold', () => {
    expect(prdStatusFor({ status: 'needs_review', cancelled: true })).toBe('cancelled')
    expect(prdStatusFor({ status: 'completed', cancelled: true }, 'verified')).toBe('cancelled')
    expect(prdStatusFor({ status: 'failed', cancelled: true }, 'refuted')).toBe('cancelled')
  })
  it('keeps a real failure failed', () => {
    expect(prdStatusFor({ status: 'failed' })).toBe('failed')
    expect(prdStatusFor({ status: 'failed', cancelled: false })).toBe('failed')
  })
})

describe('SchBadge cancelled', () => {
  it('renders cancelled in the neutral tone when cancelled is true', () => {
    for (const status of ['failed', 'needs_review'] as const) {
      const el = mount(<SchBadge status={status} cancelled />)
      const badge = el.querySelector('[role="status"]') as HTMLElement
      expect(badge.getAttribute('aria-label')).toBe('Status: cancelled')
      expect(badge.textContent).toContain('cancelled')
      expect(badge.className).toContain('bg-fg-dim/10')
      expect(badge.className).toContain('text-fg-dim')
      expect(badge.className).toContain('border-line')
      expect(badge.className).not.toContain('text-accent')
      act(() => root?.unmount()); (container as HTMLDivElement | null)?.remove(); root = null; container = null
    }
  })
  it('renders every ScheduleJobStatus unchanged without the flag', () => {
    for (const status of ALL_STATUSES) {
      const plain = mount(<SchBadge status={status} />).innerHTML
      act(() => root?.unmount()); (container as HTMLDivElement | null)?.remove(); root = null; container = null
      const withFalse = mount(<SchBadge status={status} cancelled={false} />).innerHTML
      act(() => root?.unmount()); (container as HTMLDivElement | null)?.remove(); root = null; container = null
      expect(withFalse).toBe(plain)
      expect(plain).toContain(`Status: ${status.replace('_', ' ')}`)
      expect(plain).not.toContain('cancelled')
    }
  })
})

describe('JobRow cancelled', () => {
  const render = (j: ScheduleJob) =>
    mount(<JobRow job={j} eta={null} elapsedMs={null} avgDurationMs={60_000} listIndex={0} onFocused={vi.fn()} />)

  it('a cancelled failed job shows a neutral cancelled badge, no failure note, and data-job-cancelled', () => {
    const el = render(job({ status: 'failed', cancelled: true }))
    const row = el.querySelector('[data-job-row]') as HTMLElement
    expect(row.getAttribute('data-job-cancelled')).toBe('true')
    expect(row.getAttribute('aria-label')).toContain('cancelled')
    const badge = el.querySelector('[role="status"]') as HTMLElement
    expect(badge.getAttribute('aria-label')).toBe('Status: cancelled')
    // isFailed false → the red first-line error note is not rendered
    expect(el.querySelector('.text-accent\\/80')).toBeNull()
    expect(el.textContent).not.toContain('cancelled by user')
  })

  it('a cancelled needs_review job shows the cancelled badge', () => {
    const el = render(job({ status: 'needs_review', cancelled: true, error: null }))
    const row = el.querySelector('[data-job-row]') as HTMLElement
    expect(row.getAttribute('data-job-cancelled')).toBe('true')
    expect((el.querySelector('[role="status"]') as HTMLElement).getAttribute('aria-label')).toBe('Status: cancelled')
  })

  it('a real failure stays a red failed row without data-job-cancelled', () => {
    const el = render(job({ status: 'failed', error: 'tests failed\nmore' }))
    const row = el.querySelector('[data-job-row]') as HTMLElement
    expect(row.hasAttribute('data-job-cancelled')).toBe(false)
    expect((el.querySelector('[role="status"]') as HTMLElement).getAttribute('aria-label')).toBe('Status: failed')
    const note = el.querySelector('.text-accent\\/80') as HTMLElement
    expect(note.textContent).toBe('tests failed')
  })
})
