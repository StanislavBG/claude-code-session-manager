// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollWithin } from '../scrollWithin'

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function setup(containerRect: [number, number], targetRect: [number, number]) {
  const parent = document.createElement('div')
  const container = document.createElement('div')
  const target = document.createElement('div')
  container.appendChild(target)
  parent.appendChild(container)
  document.body.appendChild(parent)
  container.getBoundingClientRect = () => rect(...containerRect)
  target.getBoundingClientRect = () => rect(...targetRect)
  const containerScrollBy = vi.fn()
  const parentScrollBy = vi.fn()
  const scrollIntoView = vi.fn()
  container.scrollBy = containerScrollBy as unknown as typeof container.scrollBy
  parent.scrollBy = parentScrollBy as unknown as typeof parent.scrollBy
  target.scrollIntoView = scrollIntoView
  return { parent, container, target, containerScrollBy, parentScrollBy, scrollIntoView }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('scrollWithin', () => {
  it("block 'start' scrolls only the container so target lands at its top, minus offset", () => {
    const s = setup([100, 300], [450, 40])
    scrollWithin(s.container, s.target, { offset: 10, behavior: 'smooth' })
    expect(s.containerScrollBy).toHaveBeenCalledTimes(1)
    expect(s.containerScrollBy).toHaveBeenCalledWith({ top: 340, behavior: 'smooth' })
    expect(s.containerScrollBy.mock.calls[0][0]).not.toHaveProperty('left')
    expect(s.parentScrollBy).not.toHaveBeenCalled()
    expect(s.scrollIntoView).not.toHaveBeenCalled()
  })

  it("block 'start' with no offset uses the raw top delta", () => {
    const s = setup([100, 300], [50, 40])
    scrollWithin(s.container, s.target)
    expect(s.containerScrollBy).toHaveBeenCalledWith({ top: -50, behavior: 'auto' })
    expect(s.parentScrollBy).not.toHaveBeenCalled()
    expect(s.scrollIntoView).not.toHaveBeenCalled()
  })

  it("block 'nearest' scrolls up by the minimal delta when target is above", () => {
    const s = setup([100, 300], [60, 40])
    scrollWithin(s.container, s.target, { block: 'nearest' })
    expect(s.containerScrollBy).toHaveBeenCalledWith({ top: -40, behavior: 'auto' })
    expect(s.parentScrollBy).not.toHaveBeenCalled()
    expect(s.scrollIntoView).not.toHaveBeenCalled()
  })

  it("block 'nearest' scrolls down by the minimal delta when target is below", () => {
    // container visible box 100..400; target 380..420 → overflows bottom by 20
    const s = setup([100, 300], [380, 40])
    scrollWithin(s.container, s.target, { block: 'nearest' })
    expect(s.containerScrollBy).toHaveBeenCalledWith({ top: 20, behavior: 'auto' })
    expect(s.parentScrollBy).not.toHaveBeenCalled()
    expect(s.scrollIntoView).not.toHaveBeenCalled()
  })

  it("block 'nearest' is a no-op when target is already fully visible", () => {
    const s = setup([100, 300], [200, 40])
    const before = s.container.scrollTop
    scrollWithin(s.container, s.target, { block: 'nearest' })
    expect(s.containerScrollBy).not.toHaveBeenCalled()
    expect(s.container.scrollTop).toBe(before)
    expect(s.parentScrollBy).not.toHaveBeenCalled()
    expect(s.scrollIntoView).not.toHaveBeenCalled()
  })

  it('is a no-op when target is not a descendant of container', () => {
    const s = setup([100, 300], [450, 40])
    const stranger = document.createElement('div')
    s.parent.appendChild(stranger)
    stranger.getBoundingClientRect = () => rect(900, 40)
    const strangerScroll = vi.fn()
    stranger.scrollIntoView = strangerScroll
    scrollWithin(s.container, stranger)
    scrollWithin(s.container, s.container)
    expect(s.containerScrollBy).not.toHaveBeenCalled()
    expect(s.parentScrollBy).not.toHaveBeenCalled()
    expect(strangerScroll).not.toHaveBeenCalled()
    expect(s.scrollIntoView).not.toHaveBeenCalled()
  })
})
