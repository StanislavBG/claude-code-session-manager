// @vitest-environment jsdom
import { createElement, useEffect } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { PageShell, usePageShell } from '../PageShell'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const classes = (el: HTMLElement | null) => (el ? el.className.split(/\s+/) : [])

describe('PageShell', () => {
  it('frame regions are clipped, and only subnav + content scroll', () => {
    act(() => {
      root.render(
        createElement(PageShell, {
          header: createElement('div', null, 'Header'),
          subnav: createElement('div', null, 'Nav'),
          footer: createElement('div', null, 'Footer'),
          children: createElement('div', null, 'Body'),
        }),
      )
    })
    const shell = q('page-shell')
    const header = q('page-shell-header')
    const body = q('page-shell-body')
    const footer = q('page-shell-footer')
    const subnav = q('page-shell-subnav')
    const content = q('page-shell-content')

    expect(classes(shell)).toEqual(expect.arrayContaining(['h-full', 'w-full', 'flex', 'flex-col', 'overflow-clip', 'min-h-0', 'min-w-0']))
    expect(classes(header)).toEqual(expect.arrayContaining(['shrink-0', 'overflow-clip', 'min-w-0']))
    expect(classes(body)).toEqual(expect.arrayContaining(['flex-1', 'overflow-clip', 'min-h-0', 'min-w-0']))
    expect(classes(footer)).toEqual(expect.arrayContaining(['shrink-0', 'overflow-clip', 'min-w-0']))
    expect(classes(subnav)).toEqual(expect.arrayContaining(['overflow-y-auto', 'overscroll-contain', 'min-h-0']))
    expect(classes(content)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0', 'min-h-0', 'overflow-y-auto', 'overscroll-contain']))

    // Only subnav + content are scroll containers.
    const scrollers = Array.from(container.querySelectorAll('[class*="overflow-y-auto"], [class*="overflow-auto"], [class*="overflow-hidden"], [class*="overflow-scroll"]'))
    expect(scrollers).toEqual([subnav, content])
    expect(subnav!.style.width).toBe('220px')
  })

  it('omits subnav, header and footer when not passed', () => {
    act(() => {
      root.render(createElement(PageShell, { children: createElement('div', null, 'Body') }))
    })
    expect(q('page-shell-subnav')).toBeNull()
    expect(q('page-shell-footer')).toBeNull()
    expect(q('page-shell-header')).toBeNull()
    expect(q('page-shell-content')).not.toBeNull()
  })

  it('scrollToAnchor scrolls only the content scroller and never calls scrollIntoView', () => {
    const scrollIntoView = vi.fn()
    ;(Element.prototype as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView
    let api: ReturnType<typeof usePageShell> | null = null
    function Child() {
      const shell = usePageShell()
      useEffect(() => { api = shell }, [shell])
      return createElement('div', null,
        createElement('section', { id: 'a' }, 'A'),
        createElement('section', { id: 'b' }, 'B'),
      )
    }
    act(() => {
      root.render(createElement(PageShell, { subnav: createElement('div', null, 'Nav'), children: createElement(Child) }))
    })
    const shell = q('page-shell')!
    const content = q('page-shell-content')!
    const subnav = q('page-shell-subnav')!
    const target = content.querySelector('#b') as HTMLElement
    expect(api!.contentRef.current).toBe(content)

    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 400, left: 0, right: 0, width: 0, height: 300, x: 0, y: 100, toJSON: () => ({}) })
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 760, left: 0, right: 0, width: 0, height: 60, x: 0, y: 700, toJSON: () => ({}) })
    const contentScroll = vi.fn()
    const rootScroll = vi.fn()
    const subnavScroll = vi.fn()
    ;(content as unknown as { scrollBy: unknown }).scrollBy = contentScroll
    ;(shell as unknown as { scrollBy: unknown }).scrollBy = rootScroll
    ;(subnav as unknown as { scrollBy: unknown }).scrollBy = subnavScroll

    act(() => api!.scrollToAnchor('b', { behavior: 'smooth' }))
    expect(contentScroll).toHaveBeenCalledTimes(1)
    expect(contentScroll).toHaveBeenCalledWith({ top: 600, behavior: 'smooth' })
    expect(rootScroll).not.toHaveBeenCalled()
    expect(subnavScroll).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()

    // Unknown id is a no-op.
    act(() => api!.scrollToAnchor('missing'))
    expect(contentScroll).toHaveBeenCalledTimes(1)
  })

  it('usePageShell throws outside a PageShell', () => {
    function Orphan() { usePageShell(); return null }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => act(() => root.render(createElement(Orphan)))).toThrow(/inside a <PageShell>/)
  })
})
