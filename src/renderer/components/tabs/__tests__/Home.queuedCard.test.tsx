// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
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

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(QueuedCard, {}))
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  useScheduleState.setState({ snapshot: null, loaded: false })
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
})
