// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { HomeSessionDrawer } from '../HomeSessionDrawer'

/**
 * Coverage for the Home dashboard's slide-in session detail drawer (PRD 967,
 * Home Screen A fidelity — variants/home-a.jsx's ADrawer). Verifies the
 * drawer renders/hides on `open`, shows real KeyVals, the optional live-tail
 * section, close-via-button and close-via-backdrop-click.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(props: Parameters<typeof HomeSessionDrawer>[0]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(HomeSessionDrawer, props))
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

describe('HomeSessionDrawer', () => {
  it('renders nothing when closed', async () => {
    await mount({ open: false, onClose: vi.fn(), title: 'x', keyVals: [] })
    expect(document.querySelector('[data-testid="home-drawer"]')).toBeNull()
  })

  it('renders title, sub, and KeyVals when open', async () => {
    await mount({
      open: true,
      onClose: vi.fn(),
      title: 'Contextual chat per Epic',
      sub: 'Active session · chat run',
      keyVals: [
        { label: 'Owner', value: 'chat:epic-2' },
        { label: 'Project', value: 'sigma' },
      ],
    })
    const drawer = document.querySelector('[data-testid="home-drawer"]')!
    expect(drawer.textContent).toContain('Contextual chat per Epic')
    expect(drawer.textContent).toContain('Active session · chat run')
    expect(drawer.textContent).toContain('chat:epic-2')
    expect(drawer.textContent).toContain('sigma')
  })

  it('omits the live tail section when no tail lines are given', async () => {
    await mount({ open: true, onClose: vi.fn(), title: 'x', keyVals: [] })
    expect(document.body.textContent).not.toContain('Live tail')
  })

  it('renders real tail lines when given', async () => {
    await mount({
      open: true,
      onClose: vi.fn(),
      title: 'x',
      keyVals: [],
      tail: [{ id: 't1', role: 'assistant', text: 'Ran /develop and queued PRD 967.' }],
    })
    expect(document.body.textContent).toContain('Live tail')
    expect(document.body.textContent).toContain('Ran /develop and queued PRD 967.')
  })

  it('renders footer actions when given', async () => {
    await mount({
      open: true,
      onClose: vi.fn(),
      title: 'x',
      keyVals: [],
      footer: createElement('button', null, 'Resume'),
    })
    expect(document.body.textContent).toContain('Resume')
  })

  it('calls onClose when the Close button is clicked', async () => {
    const onClose = vi.fn()
    await mount({ open: true, onClose, title: 'x', keyVals: [] })
    const closeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close')!
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn()
    await mount({ open: true, onClose, title: 'x', keyVals: [] })
    const backdrop = document.querySelector('[data-testid="home-drawer-backdrop"]')!
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape key', async () => {
    const onClose = vi.fn()
    await mount({ open: true, onClose, title: 'x', keyVals: [] })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
