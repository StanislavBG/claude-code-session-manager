// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { NewEpicProjectDrawer } from '../NewEpicProjectDrawer'
import type { HomeProjectRow } from '../../../../lib/homeProjectRows'

/**
 * Coverage for the Home dashboard's "New epic" project picker drawer (Home
 * Screen A fidelity — variants/home-a.jsx's newEpic ADrawer), rebuilt on the
 * real HomeSessionDrawer primitive. Verifies the radio list renders real
 * project rows (no fabricated names), selection + Continue/Cancel wiring.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(props: Parameters<typeof NewEpicProjectDrawer>[0]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(NewEpicProjectDrawer, props))
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

const projects: HomeProjectRow[] = [
  { encoded: 'a', name: 'session-manager', cwd: '/home/bilko/Projects/session-manager', dotSeed: 'a', liveCount: 0, lastActivityMs: 1 },
  { encoded: 'b', name: 'sigma', cwd: '/home/bilko/Projects/sigma', dotSeed: 'b', liveCount: 1, lastActivityMs: 2 },
]

describe('NewEpicProjectDrawer', () => {
  it('renders nothing when closed', async () => {
    await mount({ open: false, onClose: vi.fn(), projects, onConfirm: vi.fn() })
    expect(document.querySelector('[data-testid="home-drawer"]')).toBeNull()
  })

  it('lists real known projects as a radio list, defaulting to the first', async () => {
    await mount({ open: true, onClose: vi.fn(), projects, onConfirm: vi.fn() })
    const radios = document.querySelectorAll('input[type="radio"]')
    expect(radios.length).toBe(2)
    expect(document.body.textContent).toContain('session-manager')
    expect(document.body.textContent).toContain('sigma')
    expect((radios[0] as HTMLInputElement).checked).toBe(true)
  })

  it('shows an empty state when there are no known projects', async () => {
    await mount({ open: true, onClose: vi.fn(), projects: [], onConfirm: vi.fn() })
    expect(document.body.textContent).toContain('No known projects yet.')
  })

  it('selecting a different project updates the checked radio and Continue label', async () => {
    await mount({ open: true, onClose: vi.fn(), projects, onConfirm: vi.fn() })
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
    await act(async () => {
      radios[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      radios[1].checked = true
      radios[1].dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    const continueBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Continue in'))!
    expect(continueBtn.textContent).toContain('sigma')
  })

  it('confirming calls onConfirm with the selected cwd and closes', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    await mount({ open: true, onClose, projects, onConfirm })
    const continueBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Continue in'))!
    await act(async () => {
      continueBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onConfirm).toHaveBeenCalledWith('/home/bilko/Projects/session-manager')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Cancel closes without confirming', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    await mount({ open: true, onClose, projects, onConfirm })
    const cancelBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!
    await act(async () => {
      cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
