// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { QueuedJobPopover } from '../QueuedJobPopover'

/**
 * Coverage for the Home dashboard's per-job queue popover (Home Screen A
 * fidelity — variants/home-a.jsx's `queuePop`). Verifies real job details
 * render, close-on-outside-click/Escape, and that 'Nudge scheduler now'
 * (wired to schedule.runNow()) only appears when the caller supplies
 * onRunNow — QueuedCard only does so for a still-pending job.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(props: Parameters<typeof QueuedJobPopover>[0]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(QueuedJobPopover, props))
    await Promise.resolve()
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const job = {
  slug: '973-queued-popover',
  title: 'Ship queued-job popover',
  cwd: '/home/bilko/Projects/session-manager',
  estimateMinutes: 25,
  status: 'pending' as const,
}

describe('QueuedJobPopover', () => {
  it('renders real job details: title/slug, project, estimateMinutes, status', async () => {
    await mount({ job, onClose: vi.fn(), onOpenScheduler: vi.fn() })
    const text = container!.textContent!
    expect(text).toContain('Ship queued-job popover')
    expect(text).toContain('973-queued-popover')
    expect(text).toContain('session-manager')
    expect(text).toContain('~25m')
    expect(text).toContain('pending')
  })

  it('omits the estimate row when estimateMinutes is null', async () => {
    await mount({ job: { ...job, estimateMinutes: null }, onClose: vi.fn(), onOpenScheduler: vi.fn() })
    expect(container!.textContent).not.toContain('~')
  })

  it('always shows "Open in Scheduler"', async () => {
    await mount({ job, onClose: vi.fn(), onOpenScheduler: vi.fn() })
    expect(container!.textContent).toContain('Open in Scheduler')
  })

  it('shows "Nudge scheduler now" only when onRunNow is provided', async () => {
    await mount({ job, onClose: vi.fn(), onOpenScheduler: vi.fn() })
    expect(container!.textContent).not.toContain('Nudge scheduler now')
  })

  it('calls onRunNow when Nudge scheduler now is clicked', async () => {
    const onRunNow = vi.fn()
    await mount({ job, onClose: vi.fn(), onOpenScheduler: vi.fn(), onRunNow })
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Nudge scheduler now')!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onRunNow).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenScheduler when "Open in Scheduler" is clicked', async () => {
    const onOpenScheduler = vi.fn()
    await mount({ job, onClose: vi.fn(), onOpenScheduler })
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Open in Scheduler'))!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onOpenScheduler).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on outside click', async () => {
    const onClose = vi.fn()
    await mount({ job, onClose, onOpenScheduler: vi.fn() })
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when clicking inside the popover', async () => {
    const onClose = vi.fn()
    await mount({ job, onClose, onOpenScheduler: vi.fn() })
    const popover = document.querySelector('[data-testid="queue-job-popover"]')!
    await act(async () => {
      popover.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose on Escape', async () => {
    const onClose = vi.fn()
    await mount({ job, onClose, onOpenScheduler: vi.fn() })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
