// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { QueuedJobPopover } from '../QueuedJobPopover'

/**
 * Coverage for the Home dashboard's per-job queue popover (Home Screen A
 * fidelity — variants/home-a.jsx's `queuePop`). Verifies real job details
 * render, close-on-outside-click/Escape, and that the popover is view-only:
 * no 'Nudge scheduler now' scheduler control, only 'Open in Scheduler'.
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

  it('never shows a "Nudge scheduler now" control, even for a pending job', async () => {
    await mount({ job, onClose: vi.fn(), onOpenScheduler: vi.fn() })
    expect(container!.textContent).not.toContain('Nudge')
    const labels = Array.from(container!.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['Open in Scheduler →'])
  })

  it('ignores a stray onRunNow prop — the popover has no nudge action', async () => {
    const props = { job, onClose: vi.fn(), onOpenScheduler: vi.fn(), onRunNow: vi.fn() }
    await mount(props as Parameters<typeof QueuedJobPopover>[0])
    expect(container!.textContent).not.toContain('Nudge scheduler now')
    expect(container!.querySelectorAll('button').length).toBe(1)
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
