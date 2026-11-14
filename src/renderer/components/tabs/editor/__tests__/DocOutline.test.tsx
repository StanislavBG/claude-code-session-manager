// @vitest-environment jsdom
import { createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { DocOutline } from '../DocOutline'

/**
 * DocOutline "jump to section" must scroll ONLY the preview scroller handed in
 * via scrollRef. scrollIntoView also scrolls every scrollable ancestor, which
 * drags the editor frame out of place (the "Doc-Editor bugs out" report).
 */

// jsdom has no CSS.escape; the slugs used here need no escaping.
if (!(globalThis as any).CSS?.escape) (globalThis as any).CSS = { escape: (v: string) => v }

let host: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = null
  root = null
  vi.restoreAllMocks()
})

describe('DocOutline', () => {
  it('scrolls only the scrollRef element, never its parent, and never calls scrollIntoView', () => {
    const parent = document.createElement('div')
    const scroller = document.createElement('div')
    const heading = document.createElement('h2')
    heading.id = 'second-section'
    scroller.appendChild(heading)
    parent.appendChild(scroller)
    document.body.appendChild(parent)

    const parentScrollBy = vi.fn()
    const scrollerScrollBy = vi.fn()
    ;(parent as any).scrollBy = parentScrollBy
    ;(scroller as any).scrollBy = scrollerScrollBy
    const intoView = vi.fn()
    ;(Element.prototype as any).scrollIntoView = intoView

    const scrollRef = createRef<HTMLDivElement>() as { current: HTMLDivElement | null }
    scrollRef.current = scroller

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        createElement(DocOutline, { text: '# First\n\n## Second section\n', scrollRef: scrollRef as any }),
      ),
    )

    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Second section')
    expect(btn).toBeTruthy()
    act(() => btn!.click())

    expect(scrollerScrollBy).toHaveBeenCalledTimes(1)
    expect(scrollerScrollBy.mock.calls[0][0]).toMatchObject({ behavior: 'smooth' })
    expect(parentScrollBy).not.toHaveBeenCalled()
    expect(intoView).not.toHaveBeenCalled()

    parent.remove()
    delete (Element.prototype as any).scrollIntoView
  })
})
