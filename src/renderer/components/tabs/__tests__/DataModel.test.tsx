// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DataModel } from '../DataModel'
import { ERD_ENTITIES, layoutErd } from '../../../lib/dataModelErd'

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(DataModel))
    await Promise.resolve()
  })
  return container
}

function clickButtonWithText(el: HTMLElement, text: string) {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text))
  if (!btn) throw new Error(`button with text "${text}" not found`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function clickButtonExact(el: HTMLElement, text: string) {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button with exact text "${text}" not found`)
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('DataModel', () => {
  it('renders without crashing in Diagram view (default)', async () => {
    const el = await mount()
    expect(el.querySelector('svg')).toBeTruthy()
  })

  it('renders without crashing in Tables view', async () => {
    const el = await mount()
    await act(async () => {
      clickButtonWithText(el, 'Tables')
      await Promise.resolve()
    })
    expect(el.textContent).toContain('Tables')
  })

  it('emits one <path> per layout edge in Diagram view', async () => {
    const el = await mount()
    const layout = layoutErd()
    const paths = el.querySelectorAll('svg path')
    expect(paths.length).toBe(layout.edges.length)
  })

  it('shows every ERD_ENTITIES name in Tables view', async () => {
    const el = await mount()
    await act(async () => {
      clickButtonWithText(el, 'Tables')
      await Promise.resolve()
    })
    for (const entity of ERD_ENTITIES) {
      expect(el.textContent).toContain(entity.name)
    }
  })

  it('selecting an entity shows its relations', async () => {
    const el = await mount()
    const box = el.querySelector('[data-testid="erd-box-epic"]') as HTMLElement
    expect(box).toBeTruthy()
    await act(async () => {
      box.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(el.textContent).toContain('relations')
    expect(el.textContent).toContain('belongs to')
  })

  it("a relation's target button selects that target", async () => {
    const el = await mount()
    const box = el.querySelector('[data-testid="erd-box-tab"]') as HTMLElement
    await act(async () => {
      box.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    // tab -> project ("belongs to") relation button, labelled with the target entity's name
    await act(async () => {
      clickButtonExact(el, 'Project')
      await Promise.resolve()
    })
    const selectedBox = el.querySelector('[data-testid="erd-box-project"]') as HTMLElement
    expect(selectedBox.className).toContain('border-accent')
  })
})
