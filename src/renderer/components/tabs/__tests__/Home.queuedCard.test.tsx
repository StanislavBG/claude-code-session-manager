// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { QueuedCard } from '../Home'
import { useScheduleState } from '../../../state/scheduleState'

/**
 * Regression test for the reported "Queued card renders blank" bug (Home
 * Screen A fidelity PRD 966). Leading hypothesis: the scheduler snapshot
 * arrives async after mount, so the card briefly renders against a null
 * store slice. QueuedCard already falls back to EMPTY_JOBS in that case
 * (Home.tsx's `useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS`),
 * so both states below should already render the 'Queued' header and the
 * 'Nothing pending.' empty-state text — this test locks that in.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(props: Parameters<typeof QueuedCard>[0] = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(QueuedCard, props))
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  useScheduleState.setState({ snapshot: null, loaded: false })
  ;(window as unknown as { api: { schedule: { runNow: () => Promise<{ ok: boolean }> } } }).api = {
    schedule: { runNow: () => Promise.resolve({ ok: true }) },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  useScheduleState.setState({ snapshot: null, loaded: false })
})

describe('QueuedCard', () => {
  it('renders the header and empty-state text before any scheduler snapshot has arrived (snapshot === null)', async () => {
    const el = await mount()
    expect(el.textContent).toContain('Queued')
    expect(el.textContent).toContain('Nothing pending.')
  })

  it('renders the header and empty-state text once an empty-jobs snapshot has arrived', async () => {
    const el = await mount()
    await act(async () => {
      useScheduleState.setState({
        snapshot: { jobs: [], history: [], paused: null, concurrency: 3 } as never,
        loaded: true,
      })
      await Promise.resolve()
    })
    expect(el.textContent).toContain('Queued')
    expect(el.textContent).toContain('Nothing pending.')
  })

  it('renders pending job titles once the snapshot has real pending jobs', async () => {
    const el = await mount()
    await act(async () => {
      useScheduleState.setState({
        snapshot: {
          jobs: [{ slug: 'job-1', title: 'Fix the thing', status: 'pending', cwd: '/home/bilko/Projects/foo' }],
          history: [],
          paused: null,
          concurrency: 3,
        } as never,
        loaded: true,
      })
      await Promise.resolve()
    })
    expect(el.textContent).toContain('Fix the thing')
    expect(el.textContent).not.toContain('Nothing pending.')
  })

  it('keeps an "Open Scheduler →" link that navigates even with pending jobs', async () => {
    const onNavigate = vi.fn()
    const el = await mount({ onNavigate })
    await act(async () => {
      useScheduleState.setState({
        snapshot: {
          jobs: [{ slug: 'job-1', title: 'Fix the thing', status: 'pending', cwd: '/home/bilko/Projects/foo' }],
          history: [],
          paused: null,
          concurrency: 3,
        } as never,
        loaded: true,
      })
      await Promise.resolve()
    })
    const link = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Open Scheduler →')!
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onNavigate).toHaveBeenCalledWith('scheduler')
  })

  it('clicking a job row opens a popover with its real details, and clicking again closes it', async () => {
    const el = await mount()
    await act(async () => {
      useScheduleState.setState({
        snapshot: {
          jobs: [{ slug: 'job-1', title: 'Fix the thing', status: 'pending', cwd: '/home/bilko/Projects/foo', estimateMinutes: 12 }],
          history: [],
          paused: null,
          concurrency: 3,
        } as never,
        loaded: true,
      })
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="queue-job-popover"]')).toBeNull()
    const row = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Fix the thing'))!
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const popover = document.querySelector('[data-testid="queue-job-popover"]')
    expect(popover).not.toBeNull()
    expect(popover!.textContent).toContain('job-1')
    expect(popover!.textContent).toContain('foo')
    expect(popover!.textContent).toContain('~12m')
    expect(popover!.textContent).toContain('Nudge scheduler now')

    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="queue-job-popover"]')).toBeNull()
  })
})
