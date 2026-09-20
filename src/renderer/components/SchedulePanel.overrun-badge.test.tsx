// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { JobRow } from './tabs/scheduler/JobRow'
import { usePromptSessions } from '../state/promptSessions'
import { takePendingPromptSessionId } from '../lib/promptSessionDeepLink'
import type { ScheduleJob } from '../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  usePromptSessions.setState({ sessions: {} })
  takePendingPromptSessionId()
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
    slug: '900-slow-thing',
    title: 'The slow thing',
    cwd: '/proj',
    parallelGroup: 900,
    estimateMinutes: 22,
    bodyPreview: '',
    status: 'running',
    runId: null,
    startedAt: new Date(Date.now() - 108 * 60_000).toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    ...overrides,
  } as ScheduleJob
}

describe('JobRow overrun badge', () => {
  it('renders the overrun badge alongside the elapsed label for a running overrun job', () => {
    const j = job({ overrun: { ratio: 4.9, ranMs: 108 * 60_000, estimateMinutes: 22, at: new Date().toISOString() } })
    const el = mount(
      <JobRow job={j} eta={null} elapsedMs={108 * 60_000} avgDurationMs={60_000} listIndex={0} onFocused={vi.fn()} />,
    )
    const badge = el.querySelector('[data-testid="overrun-badge"]') as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.textContent).toBe('4.9x over 22m est')
    expect(el.textContent).toContain('elapsed')
  })

  it('renders no badge for a running job with no overrun stamp', () => {
    const j = job({ overrun: undefined })
    const el = mount(
      <JobRow job={j} eta={null} elapsedMs={5 * 60_000} avgDurationMs={60_000} listIndex={0} onFocused={vi.fn()} />,
    )
    expect(el.querySelector('[data-testid="overrun-badge"]')).toBeNull()
  })

  it('renders no badge for a completed job with a stale overrun field', () => {
    const j = job({
      status: 'completed',
      startedAt: new Date(Date.now() - 200_000).toISOString(),
      finishedAt: new Date().toISOString(),
      overrun: { ratio: 4.9, ranMs: 108 * 60_000, estimateMinutes: 22, at: new Date().toISOString() },
    })
    const el = mount(
      <JobRow job={j} eta={null} elapsedMs={null} avgDurationMs={60_000} listIndex={0} onFocused={vi.fn()} />,
    )
    expect(el.querySelector('[data-testid="overrun-badge"]')).toBeNull()
  })
})
