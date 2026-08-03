// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HomeHeaderWithLegend } from '../Home'

/**
 * Regression coverage for the "Interactions" legend toggle added to Home's
 * header (Home Screen A fidelity PRD 966) — a reference panel adapted from
 * the design mock's own legend, describing this app's REAL wired behavior.
 */

function installWindowApiMock() {
  const api = {
    schedule: {
      sessionSlots: vi.fn().mockResolvedValue({
        total: 5, inUse: 0, holders: [], min: 0, max: 10, default: 5, envOverride: false,
      }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(HomeHeaderWithLegend, { greeting: 'Good morning', projectCount: 2, needsCount: 0 }))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  installWindowApiMock()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('HomeHeaderWithLegend (Interactions toggle)', () => {
  it('does not render the legend panel by default', async () => {
    const el = await mount()
    expect(el.textContent).toContain('Interactions')
    expect(el.textContent).not.toContain('Queued job')
  })

  it('opens the legend panel on click and shows real wired-behavior copy', async () => {
    const el = await mount()
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Interactions')!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(el.textContent).toContain('Queued job')
    expect(el.textContent).toContain('Needs-you row')
    expect(el.textContent).toContain('Active session row')
    expect(el.textContent).toContain('Recent row')
    expect(el.textContent).not.toContain('Pace')
  })

  it('closes the legend panel on a second click', async () => {
    const el = await mount()
    const openBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Interactions')!
    await act(async () => {
      openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const closeBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Hide interactions')!
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(el.textContent).not.toContain('Queued job')
  })
})
