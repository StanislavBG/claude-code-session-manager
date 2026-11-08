// @vitest-environment jsdom
import { useState, type ReactNode } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ExtensionsToolbar } from '../ExtensionsToolbar'
import { Z } from '../../../../lib/zLayers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Item = { label: string; testId: string; onSelect: () => void }

let container: HTMLDivElement | null = null
let root: Root | null = null

/** Owns the filter state the way a tab body will, so typing round-trips. */
function Harness({
  items,
  onFilterChange,
  initial = '',
  children,
}: {
  items: Item[]
  onFilterChange?: (v: string) => void
  initial?: string
  children?: ReactNode
}) {
  const [filter, setFilter] = useState(initial)
  return (
    <ExtensionsToolbar
      filter={filter}
      onFilterChange={(v) => {
        onFilterChange?.(v)
        setFilter(v)
      }}
      placeholder="Filter servers"
      summary={<>7 servers · 1 checked</>}
      primary={{ label: '+ Add server', testId: 'mcp-add', items }}
    >
      {children}
    </ExtensionsToolbar>
  )
}

function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(node)
  })
}

const q = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const menu = () => container!.querySelector<HTMLElement>('[role="menu"]')
const filterInput = () => container!.querySelector<HTMLInputElement>('input')!

/** A real click is mousedown → mouseup → click, each its own task, so React
 *  re-renders between them. An outside-click listener on mousedown must not
 *  close (and unmount) the menu before the click lands on the trigger or an
 *  item — hence one act() per event, never one act() around all three. */
function press(el: Element) {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    })
  }
}

function keydown(key: string) {
  act(() => {
    ;(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

/** React tracks a controlled input's value; go through the native setter so
 *  the 'input' event reaches onChange. */
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/)

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

const twoItems = () => [
  { label: 'Blank server', testId: 'mcp-add-blank', onSelect: vi.fn() },
  { label: 'From the catalog', testId: 'mcp-add-catalog', onSelect: vi.fn() },
]

describe('ExtensionsToolbar', () => {
  it('renders the 3a band: filter, faint summary, children, then the right-aligned accent primary', () => {
    mount(
      <Harness items={twoItems()}>
        <button type="button" data-testid="mcp-check-all">Check all</button>
      </Harness>,
    )
    const band = q('extensions-toolbar')!
    for (const c of ['h-11', 'bg-bg-elev', 'border-b', 'border-line', 'px-3', 'gap-3', 'text-xs']) {
      expect(classes(band)).toContain(c)
    }

    const input = filterInput()
    expect(input.placeholder).toBe('Filter servers')
    for (const c of ['w-[276px]', 'h-7', 'bg-bg-hi', 'border-line', 'rounded-md']) {
      expect(classes(input)).toContain(c)
    }
    expect(input.parentElement!.querySelector('svg')).not.toBeNull() // search icon

    const summary = q('extensions-toolbar-summary')!
    expect(summary.textContent).toBe('7 servers · 1 checked')
    expect(classes(summary)).toContain('text-fg-faint')

    const primary = q('mcp-add')!
    expect(primary.textContent).toBe('+ Add server')
    for (const c of ['ml-auto', 'bg-accent', 'text-bg-hi', 'font-semibold']) {
      expect(classes(primary)).toContain(c)
    }
    expect(primary.querySelector('svg')).not.toBeNull() // chevron
    expect(primary.getAttribute('aria-haspopup')).toBe('menu')

    // Children sit between the summary and the primary.
    const checkAll = q('mcp-check-all')!
    expect(summary.compareDocumentPosition(checkAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(checkAll.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(menu()).toBeNull() // closed until the primary is pressed
  })

  it('typing in the filter reports each value and the controlled field follows it', () => {
    const onFilterChange = vi.fn()
    mount(<Harness items={twoItems()} onFilterChange={onFilterChange} initial="pl" />)
    expect(filterInput().value).toBe('pl')

    typeInto(filterInput(), 'fet')
    expect(onFilterChange).toHaveBeenLastCalledWith('fet')
    expect(filterInput().value).toBe('fet')

    typeInto(filterInput(), 'fetch')
    expect(onFilterChange).toHaveBeenLastCalledWith('fetch')
    expect(onFilterChange).toHaveBeenCalledTimes(2)
    expect(filterInput().value).toBe('fetch')
    expect(menu()).toBeNull() // typing never opens the menu
  })

  it('pressing the primary toggles a role=menu of role=menuitem entries on a zLayers rung', () => {
    mount(<Harness items={twoItems()} />)
    const primary = q('mcp-add')!
    expect(primary.getAttribute('aria-expanded')).toBe('false')

    press(primary)
    const m = menu()!
    expect(m).not.toBeNull()
    expect(primary.getAttribute('aria-expanded')).toBe('true')
    const items = Array.from(m.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    expect(items.map((i) => i.dataset.testid)).toEqual(['mcp-add-blank', 'mcp-add-catalog'])
    expect(items.map((i) => i.textContent)).toEqual(['Blank server', 'From the catalog'])

    // z-index comes from the ladder, never a raw literal.
    expect(classes(m)).toContain(Z.dialog)
    expect(classes(m).filter((c) => /^z-/.test(c))).toEqual([Z.dialog])

    press(primary)
    expect(menu()).toBeNull()
    expect(primary.getAttribute('aria-expanded')).toBe('false')
  })

  it('Escape closes the open menu; other keys do not', () => {
    mount(<Harness items={twoItems()} />)
    press(q('mcp-add')!)
    keydown('Enter')
    expect(menu()).not.toBeNull()
    keydown('Escape')
    expect(menu()).toBeNull()
    expect(q('mcp-add')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('an outside click closes the open menu; a click inside it does not', () => {
    const items = twoItems()
    mount(<Harness items={items} />)

    press(q('mcp-add')!)
    act(() => {
      menu()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menu()).not.toBeNull() // inside the menu

    press(document.body)
    expect(menu()).toBeNull()

    // Elsewhere in the band (the filter field) is outside too.
    press(q('mcp-add')!)
    expect(menu()).not.toBeNull()
    press(filterInput())
    expect(menu()).toBeNull()

    for (const i of items) expect(i.onSelect).not.toHaveBeenCalled()
  })

  it('selecting an item calls its onSelect once and closes the menu', () => {
    const items = twoItems()
    mount(<Harness items={items} />)
    press(q('mcp-add')!)
    press(q('mcp-add-catalog')!)

    expect(items[1].onSelect).toHaveBeenCalledTimes(1)
    expect(items[0].onSelect).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
    expect(q('mcp-add-catalog')).toBeNull()
  })

  it('a single-item primary still opens the menu and keeps its label', () => {
    const only = { label: 'Blank server', testId: 'mcp-add-blank', onSelect: vi.fn() }
    mount(<Harness items={[only]} />)
    press(q('mcp-add')!)

    expect(only.onSelect).not.toHaveBeenCalled() // no shortcut straight to the flow
    expect(q('mcp-add')!.textContent).toBe('+ Add server')
    const items = menu()!.querySelectorAll('[role="menuitem"]')
    expect(items).toHaveLength(1)
    expect((items[0] as HTMLElement).dataset.testid).toBe('mcp-add-blank')

    press(items[0])
    expect(only.onSelect).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })
})
