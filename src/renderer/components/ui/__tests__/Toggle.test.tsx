// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Toggle } from '../Toggle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function render(el: ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function Harness({ onChange, label }: { onChange?: (v: boolean) => void; label?: string }) {
  const [on, setOn] = useState(false)
  return (
    <Toggle
      checked={on}
      label={label}
      onChange={(v) => {
        onChange?.(v)
        setOn(v)
      }}
    />
  )
}

const sw = (c: HTMLElement) => c.querySelector('[role="switch"]') as HTMLButtonElement

describe('Toggle', () => {
  it('exposes role=switch with aria-checked and toggles on click', () => {
    const spy = vi.fn()
    const c = render(<Harness onChange={spy} />)
    expect(sw(c).getAttribute('aria-checked')).toBe('false')
    act(() => sw(c).click())
    expect(spy).toHaveBeenLastCalledWith(true)
    expect(sw(c).getAttribute('aria-checked')).toBe('true')
    act(() => sw(c).click())
    expect(sw(c).getAttribute('aria-checked')).toBe('false')
  })

  it('does not fire onChange when disabled', () => {
    const spy = vi.fn()
    const c = render(<Toggle checked={false} disabled onChange={spy} />)
    act(() => sw(c).click())
    expect(spy).not.toHaveBeenCalled()
  })

  it('renders the track with accent when on and line when off, with a bg-bg-hi thumb inside', () => {
    const off = render(<Toggle checked={false} onChange={() => {}} />)
    const offTrack = sw(off)
    expect(offTrack.className).toContain('bg-line')
    expect(offTrack.className).toContain('shrink-0')
    const thumb = offTrack.querySelector('[data-testid="toggle-thumb"]') as HTMLElement
    expect(thumb).not.toBeNull()
    expect(thumb.className).toContain('bg-bg-hi')
    act(() => root?.unmount())
    container?.remove()

    const on = render(<Toggle checked onChange={() => {}} />)
    expect(sw(on).className).toContain('bg-accent')
  })

  it('renders the label after the track, outside the track element', () => {
    const c = render(<Harness label="Show unset" />)
    const track = sw(c)
    const label = c.querySelector('[data-testid="toggle-label"]') as HTMLElement
    expect(label).not.toBeNull()
    expect(label.textContent).toBe('Show unset')
    expect(track.contains(label)).toBe(false)
    expect(track.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(track.parentElement?.className).toContain('gap-2')
    // clicking the label toggles too (label element wraps the switch)
    act(() => label.click())
    expect(track.getAttribute('aria-checked')).toBe('true')
  })
})
