// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DataModelCard } from '../Home'
import { ERD_ENTITIES } from '../../../lib/dataModelErd'

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(props: Parameters<typeof DataModelCard>[0] = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(DataModelCard, props))
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

describe('Home DataModelCard', () => {
  it('renders the live entity count, not a hardcoded number', async () => {
    const el = await mount()
    expect(el.textContent).toContain(`${ERD_ENTITIES.length} entities`)
  })

  it('navigates to the data-model screen on click', async () => {
    const onNavigate = vi.fn()
    const el = await mount({ onNavigate })
    const btn = el.querySelector('[data-testid="home-data-model-card"]') as HTMLButtonElement
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onNavigate).toHaveBeenCalledWith('data-model')
  })
})
