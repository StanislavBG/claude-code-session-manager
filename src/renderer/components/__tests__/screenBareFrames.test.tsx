// @vitest-environment jsdom
import { isValidElement, Children, type ReactNode } from 'react'
import { describe, it, expect } from 'vitest'
import { renderScreenComponent, type ScreenRenderCtx } from '../screenComponents'
import { SectionFrame } from '../layout/SectionFrame'

function hasSectionFrame(node: ReactNode): boolean {
  if (!isValidElement(node)) return false
  if (node.type === SectionFrame) return true
  const children = (node.props as { children?: ReactNode }).children
  return Children.toArray(children).some(hasSectionFrame)
}

describe('bare Claude config frames', () => {
  const ctx: ScreenRenderCtx = { onNavigate: () => {} }

  it.each(['memory', 'claude-config'] as const)('%s renders without SectionFrame', (key) => {
    const node = renderScreenComponent(key, ctx)
    expect(isValidElement(node)).toBe(true)
    expect(isValidElement(node) && node.type).not.toBe(SectionFrame)
    expect(hasSectionFrame(node)).toBe(false)
  })

  it('history still renders inside SectionFrame', () => {
    const node = renderScreenComponent('history', ctx)
    expect(isValidElement(node) && node.type).toBe(SectionFrame)
  })
})
